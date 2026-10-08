// Runner — daemon on the user's MACHINE (Go port of the former Node runner).
//
// Dials out (outbound) to the server, long-polls waiting for a command, runs
// it LOCALLY and streams the output back. It's the other side of the backend
// channel (web/runner.mjs): exec/stdout/stderr/exit/idle protocol.
//
// Zero dependencies (stdlib only). The runner is a "device": it authenticates
// with Bearer <device_token> generated on the server's /runner page.
//
// Write model (same as dsh/Claude Code): free READ across the whole system;
// WRITE only in authorized folders, enforced at the KERNEL level (macOS
// seatbelt, Linux bwrap). This MACHINE (local config) is always the one in
// charge of the scope, never the server. Where confinement isn't possible
// (Windows, Linux without bwrap), restricted mode REFUSES the command; running
// there requires the owner to deliberately choose full access.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

// 2.1.0 = file CHANNEL (readfile/filechunk/filedone frames). The backend uses
// this version as a gate: an older runner silently drops an unknown frame
// (see pollOnce), so there it refuses right away instead of hanging the request.
// 2.1.1 = same protocol, first build with the file channel AND the panel
// together. The 2.1.0 published on 2026-08-26 shipped WITHOUT the panel (the
// panel source wasn't in the repo, see panel.go) and the double-click app died on open.
// 2.2.0 = same protocol; with no fence in restricted mode the command is refused, and the
// panel gets the explicit full-access choice (only where there's no fence).
const version = "2.2.0"

var (
	base     = strings.TrimRight(envOr(envVar("URL"), siteURL), "/")
	startDir = expandHome(envOr(envVar("RUNNER_DIR"), homeDir()))
	stopping = false
)

// token lives in panel.go (env > config, mutable at runtime by the panel).

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	if runtime.GOOS == "windows" {
		return os.Getenv("USERPROFILE")
	}
	return os.Getenv("HOME")
}

func expandHome(p string) string {
	if p == "" {
		return homeDir()
	}
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, "~\\") {
		return homeDir() + p[1:]
	}
	return p
}

func realpathSafe(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}

func hasBin(bin string) bool {
	_, err := exec.LookPath(bin)
	return err == nil
}

// ── Write policy ──────────────────────────────────────────────────────────────

type policy struct {
	Mode      string
	WriteDirs []string
}

type configFile struct {
	Mode      string   `json:"mode,omitempty"`
	WriteDirs []string `json:"writeDirs,omitempty"`
	Token     string   `json:"token,omitempty"`
}

func configPath() string      { return filepath.Join(homeDir(), "."+slug+"-runner.json") }
func defaultWriteDir() string { return filepath.Join(homeDir(), "Documents", produto) }

// Reads the policy on every exec (folder grants apply without restarting the daemon).
func loadPolicy() policy {
	var cfg configFile
	if b, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	raw := strings.ToLower(firstNonEmpty(os.Getenv(envVar("RUNNER_MODE")), cfg.Mode, "workspace-write"))
	mode := "workspace-write"
	if raw == "read-only" || raw == "workspace-write" || raw == "full-access" {
		mode = raw
	}
	var dirs []string
	if env := os.Getenv(envVar("RUNNER_WRITE_DIRS")); env != "" {
		dirs = splitAny(env, ",:")
	} else if len(cfg.WriteDirs) > 0 {
		dirs = cfg.WriteDirs
	} else {
		dirs = []string{defaultWriteDir()}
	}
	seen := map[string]bool{}
	out := []string{}
	for _, d := range dirs {
		d = realpathSafe(expandHome(strings.TrimSpace(d)))
		if d != "" && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return policy{Mode: mode, WriteDirs: out}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func splitAny(s, seps string) []string {
	f := func(r rune) bool { return strings.ContainsRune(seps, r) }
	return strings.FieldsFunc(s, f)
}

// ── Seatbelt profile (macOS): allow-default + deny write + re-allow folders ──

func sbpl(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

func seatbeltProfile(mode string, writeDirs []string) string {
	forms := []string{"(version 1)", "(allow default)", "(deny file-write*)"}
	devList := []string{"/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/stdout", "/dev/stderr", "/dev/fd"}
	devs := make([]string, len(devList))
	for i, p := range devList {
		devs[i] = "(literal " + sbpl(p) + ")"
	}
	forms = append(forms, `(allow file-write* `+strings.Join(devs, " ")+` (regex #"^/dev/tty"))`)
	if mode == "workspace-write" {
		roots := append([]string{}, writeDirs...)
		roots = append(roots, "/private/tmp", "/private/var/tmp", "/private/var/folders", realpathSafe(os.TempDir()))
		seen := map[string]bool{}
		subs := []string{}
		for _, r := range roots {
			if r != "" && !seen[r] {
				seen[r] = true
				subs = append(subs, "(subpath "+sbpl(r)+")")
			}
		}
		forms = append(forms, "(allow file-write* "+strings.Join(subs, " ")+")")
	}
	return strings.Join(forms, "\n")
}

// buildLauncher builds the final argv, wrapping the shell in the OS confinement.
// confined=false = couldn't fence it (runExec refuses, except in full-access).
func buildLauncher(pol policy, shell string, shellArgs []string) (argv []string, confined bool) {
	full := append([]string{shell}, shellArgs...)
	if pol.Mode == "full-access" {
		return full, true
	}
	switch runtime.GOOS {
	case "darwin":
		prof := seatbeltProfile(pol.Mode, pol.WriteDirs)
		return append([]string{"sandbox-exec", "-p", prof}, full...), true
	case "linux":
		if hasBin("bwrap") {
			a := []string{"--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--die-with-parent"}
			if pol.Mode == "workspace-write" {
				for _, d := range pol.WriteDirs {
					a = append(a, "--bind", d, d)
				}
			}
			a = append(a, full...)
			return append([]string{"bwrap"}, a...), true
		}
	}
	return full, false
}

// canConfine says whether THIS machine can fence writes (seatbelt or bwrap),
// regardless of the chosen mode. Windows and Linux without bwrap can't.
func canConfine() bool {
	_, ok := buildLauncher(policy{Mode: "workspace-write"}, "bash", nil)
	return ok
}

// semCerca ("no fence") = restricted mode on a machine that can't fence writes.
// In that case the runner REFUSES the command: running loose in restricted
// mode would be faking a fence that doesn't exist. Broad access is still
// possible, but as the owner's explicit choice (full-access, via the panel or local config).
func semCerca(pol policy, confined bool) bool { return pol.Mode != "full-access" && !confined }

func msgSemCerca(goos string) string {
	m := "\n[runner: comando RECUSADO. Esta máquina não consegue limitar onde o assistente grava arquivos, " +
		"e no modo restrito eu não rodo comando sem essa cerca. Pra liberar, o dono abre o painel do " + nomeRunner() + " " +
		"nesta máquina e escolhe \"Liberar acesso total nesta máquina\""
	if goos == "linux" {
		m += " (ou instala o bubblewrap, pacote bwrap, que ativa a cerca)"
	}
	return m + ". Não tente contornar.]"
}

func metaQS() string {
	pol := loadPolicy()
	_, confined := buildLauncher(pol, "bash", []string{"-lc", ":"})
	host, _ := os.Hostname()
	q := url.Values{}
	q.Set("hostname", host)
	q.Set("os", goosToNode(runtime.GOOS))
	q.Set("arch", goarchToNode(runtime.GOARCH))
	q.Set("v", version)
	q.Set("mode", pol.Mode)
	if confined {
		q.Set("confined", "1")
	} else {
		q.Set("confined", "0")
	}
	return q.Encode()
}

// The backend/UI know the Node names (process.platform/arch); translate.
func goosToNode(g string) string {
	switch g {
	case "windows":
		return "win32"
	default:
		return g // darwin, linux match
	}
}
func goarchToNode(a string) string {
	switch a {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	default:
		return a // arm64 matches
	}
}

// ── Channel protocol ──────────────────────────────────────────────────────────

type frame struct {
	Type     string `json:"type"`
	ReqID    string `json:"reqId,omitempty"`
	Comando  string `json:"comando,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
	TimeoutM int    `json:"timeoutMs,omitempty"`
	Chunk    string `json:"chunk,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	// File CHANNEL (v2.1.0): readfile (server->machine) and the response in
	// filechunk (base64, sequential) + filedone (end or error).
	Path     string `json:"path,omitempty"`
	MaxBytes int64  `json:"maxBytes,omitempty"`
	Seq      int    `json:"seq,omitempty"`
	Eof      bool   `json:"eof,omitempty"`
	Name     string `json:"name,omitempty"`
	Size     int64  `json:"size,omitempty"`
	Error    string `json:"error,omitempty"`
}

var httpClient = &http.Client{Timeout: 45 * time.Second}

func authReq(req *http.Request) { req.Header.Set("Authorization", "Bearer "+getToken()) }

func postResult(f frame) {
	b, _ := json.Marshal(f)
	req, err := http.NewRequest("POST", base+"/api/runner/result", bytes.NewReader(b))
	if err != nil {
		return
	}
	authReq(req)
	req.Header.Set("content-type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return // network dropped; the backend has its own timeout, we move on
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

// ── Execution ──────────────────────────────────────────────────────────────────

func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func runExec(f frame) {
	reqID := f.ReqID
	timeoutMs := f.TimeoutM
	if timeoutMs <= 0 {
		timeoutMs = 180_000
	}
	// The backend is the source of truth for cwd per thread; empty frame.cwd = starting
	// folder. No global cwd state (otherwise one thread would inherit another's).
	sc := f.Cwd
	if sc == "" {
		sc = startDir
	}
	startCwd := expandHome(sc)

	// SERIALIZED send queue (single goroutine): guarantees order and, crucially,
	// that stdout/stderr arrive BEFORE exit (otherwise the backend closes the req).
	sendCh := make(chan frame, 256)
	var sendWG sync.WaitGroup
	sendWG.Add(1)
	go func() {
		defer sendWG.Done()
		for fr := range sendCh {
			postResult(fr)
		}
	}()

	// Buffer with periodic flush so we don't flood with tiny POSTs.
	var mu sync.Mutex
	var outBuf, errBuf strings.Builder
	var flushTimer *time.Timer
	flush := func() {
		if outBuf.Len() > 0 {
			sendCh <- frame{ReqID: reqID, Type: "stdout", Chunk: outBuf.String()}
			outBuf.Reset()
		}
		if errBuf.Len() > 0 {
			sendCh <- frame{ReqID: reqID, Type: "stderr", Chunk: errBuf.String()}
			errBuf.Reset()
		}
	}
	schedule := func() {
		if flushTimer == nil {
			flushTimer = time.AfterFunc(150*time.Millisecond, func() {
				mu.Lock()
				flushTimer = nil
				flush()
				mu.Unlock()
			})
		}
	}
	addOut := func(s string) { mu.Lock(); outBuf.WriteString(s); schedule(); mu.Unlock() }
	addErr := func(s string) { mu.Lock(); errBuf.WriteString(s); schedule(); mu.Unlock() }

	pol := loadPolicy()
	if _, confined := buildLauncher(pol, "bash", nil); semCerca(pol, confined) {
		addErr(msgSemCerca(runtime.GOOS))
		mu.Lock()
		flush()
		mu.Unlock()
		ec := 126
		sendCh <- frame{ReqID: reqID, Type: "exit", ExitCode: &ec, Cwd: startCwd}
		close(sendCh)
		sendWG.Wait()
		logLine("comando recusado: sem cerca de escrita no modo " + pol.Mode)
		return
	}
	var cmd *exec.Cmd
	var cwdReader *os.File // extra fd (unix) to capture the final pwd
	var cwdBuf bytes.Buffer

	if runtime.GOOS == "windows" {
		// PowerShell: runs the command and writes the resulting cwd to a temp file.
		tmpCwd := filepath.Join(os.TempDir(), "__"+slug+"_cwd")
		esc := strings.ReplaceAll(startCwd, "'", "''")
		ps := "Set-Location -LiteralPath '" + esc + "'; " + f.Comando +
			"\n$ec=$LASTEXITCODE; (Get-Location).Path | Out-File -FilePath '" + strings.ReplaceAll(tmpCwd, "'", "''") + "' -Encoding utf8; exit $ec"
		cmd = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)
		cmd.Dir = startCwd
	} else {
		// bash -lc: cd to the cwd, run the command, write the final pwd to fd 3
		// (separate from stdout). That way `cd` persists across execs of a thread.
		script := "cd " + shq(startCwd) + ` 2>/dev/null || cd "$HOME"; ` + f.Comando + "\n__ec=$?; pwd >&3; exit $__ec"
		argv, _ := buildLauncher(pol, "bash", []string{"-lc", script})
		cmd = exec.Command(argv[0], argv[1:]...)
		cmd.Dir = startCwd
		// Pipe to the child's fd 3: ExtraFiles[0] -> fd 3.
		pr, pw, err := os.Pipe()
		if err == nil {
			cmd.ExtraFiles = []*os.File{pw}
			cwdReader = pr
			go func() { io.Copy(&cwdBuf, pr) }()
			defer pw.Close()
		}
	}
	setPgid(cmd) // own process group, to kill the tree on timeout

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		if pw := cmd.ExtraFiles; len(pw) > 0 {
			pw[0].Close()
		}
		addErr("\n[runner: falhou ao iniciar o shell: " + err.Error() + "]")
		mu.Lock()
		flush()
		mu.Unlock()
		ec := 127
		sendCh <- frame{ReqID: reqID, Type: "exit", ExitCode: &ec, Cwd: startCwd}
		close(sendCh)
		sendWG.Wait()
		logLine("erro ao rodar: " + err.Error())
		return
	}
	// Close our write end of fd 3 in the parent (the child has its own).
	if len(cmd.ExtraFiles) > 0 {
		cmd.ExtraFiles[0].Close()
	}

	var pipeWG sync.WaitGroup
	pump := func(r io.Reader, add func(string)) {
		defer pipeWG.Done()
		buf := make([]byte, 16*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				add(string(buf[:n]))
			}
			if err != nil {
				return
			}
		}
	}
	pipeWG.Add(2)
	go pump(stdout, addOut)
	go pump(stderr, addErr)

	// Timeout: kills the process tree.
	timedOut := false
	killTimer := time.AfterFunc(maxDur(5*time.Second, time.Duration(timeoutMs)*time.Millisecond), func() {
		timedOut = true
		killGroup(cmd)
	})

	pipeWG.Wait() // drains all the output
	waitErr := cmd.Wait()
	killTimer.Stop()
	if cwdReader != nil {
		cwdReader.Close()
	}
	if timedOut {
		addErr("\n[runner: comando excedeu o tempo e foi encerrado]")
	}

	mu.Lock()
	if flushTimer != nil {
		flushTimer.Stop()
		flushTimer = nil
	}
	flush() // queues what's left BEFORE exit
	mu.Unlock()

	// final cwd
	newCwd := startCwd
	if runtime.GOOS == "windows" {
		if b, err := os.ReadFile(filepath.Join(os.TempDir(), "__"+slug+"_cwd")); err == nil {
			if c := strings.TrimSpace(string(b)); c != "" {
				newCwd = c
			}
		}
	} else {
		lines := strings.Split(strings.TrimSpace(cwdBuf.String()), "\n")
		if c := strings.TrimSpace(lines[len(lines)-1]); c != "" {
			newCwd = c
		}
	}

	code := exitCode(waitErr)
	sendCh <- frame{ReqID: reqID, Type: "exit", ExitCode: code, Cwd: newCwd}
	close(sendCh)
	sendWG.Wait()
	cs := "null"
	if code != nil {
		cs = fmt.Sprintf("%d", *code)
	}
	logLine("comando ok (exit " + cs + ") — cwd " + newCwd)
}

func maxDur(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

// exitCode extracts the exit code from the Wait error (nil = 0).
func exitCode(err error) *int {
	if err == nil {
		z := 0
		return &z
	}
	if ee, ok := err.(*exec.ExitError); ok {
		c := ee.ExitCode() // -1 se morto por sinal (ex.: timeout)
		return &c
	}
	c := 1
	return &c
}

// ── File channel ──────────────────────────────────────────────────────────────
//
// Why it exists: the exec channel only returns TEXT, with an output cap. To bring
// back a binary (photo, PDF, zip) the only option used to be a hack (base64 over
// stdout, which blows the cap, or worse: uploading to a third-party host). Here the
// bytes leave the owner's machine straight to OUR backend, in their own frames, and
// never go through the terminal output or the model's context.
//
// READ is free across the whole machine (same model as exec), so the file is
// opened directly, with no fence. Write doesn't enter here: this channel is output only.

const fileChunkRaw = 192 * 1024       // bytes per chunk BEFORE base64
const fileMaxBytes = 64 * 1024 * 1024 // hard local cap, even if the server asks for more

func fileFail(reqID, msg string) {
	postResult(frame{ReqID: reqID, Type: "filedone", Error: msg})
	logLine("arquivo recusado: " + msg)
}

func runReadFile(f frame) {
	reqID := f.ReqID
	limit := f.MaxBytes
	if limit <= 0 || limit > fileMaxBytes {
		limit = fileMaxBytes
	}
	p := expandHome(f.Path)
	if p == "" {
		fileFail(reqID, "Caminho vazio.")
		return
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(startDir, p)
	}
	p = filepath.Clean(p)

	st, err := os.Stat(p)
	if err != nil {
		fileFail(reqID, "Não achei o arquivo: "+p)
		return
	}
	if st.IsDir() {
		fileFail(reqID, "Isso é uma pasta, não um arquivo: "+p)
		return
	}
	if !st.Mode().IsRegular() {
		fileFail(reqID, "Não é um arquivo comum (device, socket ou pipe): "+p)
		return
	}
	if st.Size() > limit {
		fileFail(reqID, fmt.Sprintf("Arquivo grande demais: %d bytes (teto %d).", st.Size(), limit))
		return
	}
	fh, err := os.Open(p)
	if err != nil {
		fileFail(reqID, "Sem permissão pra ler: "+p)
		return
	}
	defer fh.Close()

	// postResult is synchronous; reading and posting in sequence ALREADY guarantees
	// chunk order (`seq` just rides along so the other side can double-check).
	buf := make([]byte, fileChunkRaw)
	var sent int64
	seq := 0
	for {
		n, rerr := fh.Read(buf)
		if n > 0 {
			sent += int64(n)
			if sent > limit {
				fileFail(reqID, "O arquivo cresceu durante a leitura; abortei.")
				return
			}
			postResult(frame{ReqID: reqID, Type: "filechunk", Seq: seq, Chunk: base64.StdEncoding.EncodeToString(buf[:n])})
			seq++
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			fileFail(reqID, "Erro lendo o arquivo: "+rerr.Error())
			return
		}
	}
	postResult(frame{ReqID: reqID, Type: "filedone", Eof: true, Name: filepath.Base(p), Size: sent, Path: p})
	logLine(fmt.Sprintf("arquivo enviado: %s (%d bytes, %d partes)", p, sent, seq))
}

// ── Long-poll ──────────────────────────────────────────────────────────────────

func pollOnce() {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/api/runner/poll?"+metaQS(), nil)
	if err != nil {
		sleep(2 * time.Second)
		return
	}
	authReq(req)
	resp, err := httpClient.Do(req)
	if err != nil {
		status.setConnected(false)
		if !stopping {
			sleep(2 * time.Second)
		}
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 {
		status.setConnected(false)
		if panelMode {
			// In the app we don't kill the process: clear the token and the panel goes back to
			// asking for a new code, no terminal.
			logLine("código inválido ou desativado. Gere outro em " + base + "/runner e cole no painel.")
			setToken("")
			_ = persistToken("")
			sleep(3 * time.Second)
			return
		}
		logLine("token inválido ou device desativado. Gere outro em " + base + "/runner")
		os.Exit(1)
	}
	if resp.StatusCode != 200 {
		status.setConnected(false)
		io.Copy(io.Discard, resp.Body)
		sleep(2 * time.Second)
		return
	}
	status.setConnected(true)
	var f frame
	if err := json.NewDecoder(resp.Body).Decode(&f); err != nil {
		return
	}
	if f.Type == "exec" {
		c := f.Comando
		if len(c) > 120 {
			c = c[:120]
		}
		status.noteCmd(c)
		logLine("comando recebido: " + c)
		go runExec(f) // doesn't block the poll loop
	}
	if f.Type == "readfile" {
		logLine("arquivo pedido: " + f.Path)
		go runReadFile(f) // same: streaming in parallel with the poll
	}
	// idle -> just re-poll
}

func sleep(d time.Duration) { time.Sleep(d) }

func logLine(m string) {
	ts := time.Now().Format("15:04:05")
	fmt.Printf("[%s] %s\n", ts, m)
	status.push(ts + " " + m)
}

// panelMode = opened by double-click (app), no token in the environment. Changes the
// error behavior (doesn't kill the process; hands control back to the panel).
var panelMode = false

func main() {
	// Technical user with a token in the environment => CLI mode (terminal), as always.
	// No token in the environment => panel mode (double-click app + browser).
	if os.Getenv(envVar("RUNNER_TOKEN")) != "" {
		runCLI()
		return
	}
	panelMode = true
	if getToken() == "" {
		if t := configToken(); t != "" {
			setToken(t)
		}
	}
	if pol := loadPolicy(); pol.Mode == "workspace-write" {
		os.MkdirAll(defaultWriteDir(), 0o755)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() { <-sig; stopping = true; os.Exit(0) }()
	startPanel() // opens the local panel + browser and keeps the app alive
}

func runCLI() {
	if getToken() == "" {
		fmt.Fprintln(os.Stderr, "Falta o token. Rode:  "+envVar("RUNNER_TOKEN")+"=<seu-token> "+slug+"-runner")
		fmt.Fprintln(os.Stderr, "Gere o token em "+base+"/runner")
		os.Exit(1)
	}
	pol := loadPolicy()
	if pol.Mode == "workspace-write" {
		os.MkdirAll(defaultWriteDir(), 0o755)
	}
	_, confined := buildLauncher(pol, "bash", []string{"-lc", ":"})
	host, _ := os.Hostname()
	fmt.Printf("%s v%s\n", nomeRunner(), version)
	fmt.Printf("• conectando em %s\n", base)
	fmt.Printf("• máquina: %s (%s/%s)\n", host, runtime.GOOS, runtime.GOARCH)
	fmt.Printf("• pasta inicial: %s\n", startDir)
	fmt.Println("• leitura: o sistema inteiro (pra eu achar seus arquivos)")
	switch pol.Mode {
	case "read-only":
		fmt.Println("• escrita: BLOQUEADA (modo só-leitura)")
	case "full-access":
		fmt.Println("• escrita: LIVRE, sem restrição (modo acesso-total) — cuidado")
	default:
		dirs := strings.Join(pol.WriteDirs, ", ")
		if dirs == "" {
			dirs = "(nenhuma pasta)"
		}
		fmt.Printf("• escrita: só em %s\n", dirs)
	}
	if semCerca(pol, confined) {
		fmt.Println("• ⚠ este sistema não consegue cercar a escrita: comandos vão ser RECUSADOS.")
		fmt.Println("  Pra liberar de propósito: " + envVar("RUNNER_MODE") + "=full-access (o assistente grava em qualquer lugar)")
		if runtime.GOOS == "linux" {
			fmt.Println("  Ou instale o bubblewrap (pacote bwrap), que ativa a cerca.")
		}
	}
	fmt.Println("• Ctrl-C pra parar. Comandos do seu assistente rodam AQUI.")
	fmt.Println()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		stopping = true
		logLine("encerrando…")
		os.Exit(0)
	}()

	for !stopping {
		pollOnce()
	}
}
