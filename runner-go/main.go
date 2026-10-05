// Runner — daemon da MÁQUINA do usuário (porte Go do antigo runner em Node).
//
// Disca (outbound) pro servidor, fica em long-poll esperando comando, roda
// LOCALMENTE e faz streaming da saída de volta. É o outro lado do canal do
// backend (web/runner.mjs): protocolo exec/stdout/stderr/exit/idle.
//
// Zero dependência (só a stdlib). O runner é um "device": autentica por
// Bearer <device_token> gerado na página /runner do servidor.
//
// Modelo de escrita (igual dsh/Claude Code): LEITURA livre no sistema inteiro;
// ESCRITA só nas pastas autorizadas, imposto no KERNEL (macOS seatbelt, Linux
// bwrap). Quem manda no escopo é ESTA máquina (config local), nunca o servidor.
// Onde não dá pra confinar (Windows, Linux sem bwrap), o modo restrito RECUSA o
// comando; rodar ali exige o dono escolher acesso total de propósito.
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

// 2.1.0 = canal de ARQUIVO (frames readfile/filechunk/filedone). O backend usa
// esta versão como gate: runner mais velho descarta frame desconhecido calado
// (ver pollOnce), então lá ele recusa na hora em vez de pendurar o pedido.
// 2.1.1 = mesmo protocolo, primeira build com o canal de arquivo E o painel
// juntos. O 2.1.0 publicado em 26/08 saiu SEM painel (o fonte do painel não
// estava no repo, ver panel.go) e o app de duplo-clique morria na abertura.
// 2.2.0 = mesmo protocolo; sem cerca no modo restrito o comando é recusado, e o
// painel ganha a escolha explícita de acesso total (só onde não há cerca).
const version = "2.2.0"

var (
	base     = strings.TrimRight(envOr(envVar("URL"), siteURL), "/")
	startDir = expandHome(envOr(envVar("RUNNER_DIR"), homeDir()))
	stopping = false
)

// token vive em panel.go (env > config, mutável em runtime pelo painel).

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

// ── Política de escrita ──────────────────────────────────────────────────────

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

// Lê a política a cada exec (grants de pasta valem sem reiniciar o daemon).
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

// ── Perfil seatbelt (macOS): allow-default + deny escrita + re-libera pastas ──

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

// buildLauncher monta o argv final envolvendo o shell no confinamento do SO.
// confined=false = não deu pra cercar (o runExec recusa, salvo em full-access).
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

// canConfine diz se ESTA máquina consegue cercar a escrita (seatbelt ou bwrap),
// independente do modo escolhido. Windows e Linux sem bwrap não conseguem.
func canConfine() bool {
	_, ok := buildLauncher(policy{Mode: "workspace-write"}, "bash", nil)
	return ok
}

// semCerca = modo restrito numa máquina que não consegue cercar. Nesse caso o
// runner RECUSA o comando: rodar solto no modo restrito seria fingir uma cerca
// que não existe. Acesso amplo continua possível, mas como escolha explícita
// do dono (full-access, pelo painel ou pela config local).
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

// O backend/UI conhecem os nomes do Node (process.platform/arch); traduz.
func goosToNode(g string) string {
	switch g {
	case "windows":
		return "win32"
	default:
		return g // darwin, linux batem
	}
}
func goarchToNode(a string) string {
	switch a {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	default:
		return a // arm64 bate
	}
}

// ── Protocolo do canal ────────────────────────────────────────────────────────

type frame struct {
	Type     string `json:"type"`
	ReqID    string `json:"reqId,omitempty"`
	Comando  string `json:"comando,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
	TimeoutM int    `json:"timeoutMs,omitempty"`
	Chunk    string `json:"chunk,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	// Canal de ARQUIVO (v2.1.0): readfile (servidor->máquina) e a resposta em
	// filechunk (base64, sequencial) + filedone (fim ou erro).
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
		return // rede caiu; o backend tem timeout próprio, seguimos
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

// ── Execução ──────────────────────────────────────────────────────────────────

func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func runExec(f frame) {
	reqID := f.ReqID
	timeoutMs := f.TimeoutM
	if timeoutMs <= 0 {
		timeoutMs = 180_000
	}
	// O backend é a fonte da verdade do cwd por thread; frame.cwd vazio = pasta
	// inicial. Nada de estado global de cwd (senão uma thread herdava de outra).
	sc := f.Cwd
	if sc == "" {
		sc = startDir
	}
	startCwd := expandHome(sc)

	// Fila SERIALIZADA de envio (goroutine única): garante ordem e, crucial,
	// que stdout/stderr cheguem ANTES do exit (senão o backend fecha o req).
	sendCh := make(chan frame, 256)
	var sendWG sync.WaitGroup
	sendWG.Add(1)
	go func() {
		defer sendWG.Done()
		for fr := range sendCh {
			postResult(fr)
		}
	}()

	// Buffer com flush periódico pra não floodar de POSTs minúsculos.
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
	var cwdReader *os.File // fd extra (unix) pra capturar o pwd final
	var cwdBuf bytes.Buffer

	if runtime.GOOS == "windows" {
		// PowerShell: roda o comando e grava o cwd resultante num arquivo temp.
		tmpCwd := filepath.Join(os.TempDir(), "__"+slug+"_cwd")
		esc := strings.ReplaceAll(startCwd, "'", "''")
		ps := "Set-Location -LiteralPath '" + esc + "'; " + f.Comando +
			"\n$ec=$LASTEXITCODE; (Get-Location).Path | Out-File -FilePath '" + strings.ReplaceAll(tmpCwd, "'", "''") + "' -Encoding utf8; exit $ec"
		cmd = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)
		cmd.Dir = startCwd
	} else {
		// bash -lc: cd pro cwd, roda o comando, escreve o pwd final no fd 3
		// (separado do stdout). Assim `cd` persiste entre execs de uma thread.
		script := "cd " + shq(startCwd) + ` 2>/dev/null || cd "$HOME"; ` + f.Comando + "\n__ec=$?; pwd >&3; exit $__ec"
		argv, _ := buildLauncher(pol, "bash", []string{"-lc", script})
		cmd = exec.Command(argv[0], argv[1:]...)
		cmd.Dir = startCwd
		// Pipe pro fd 3 do filho: ExtraFiles[0] -> fd 3.
		pr, pw, err := os.Pipe()
		if err == nil {
			cmd.ExtraFiles = []*os.File{pw}
			cwdReader = pr
			go func() { io.Copy(&cwdBuf, pr) }()
			defer pw.Close()
		}
	}
	setPgid(cmd) // grupo de processo próprio, pra matar a árvore no timeout

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
	// Fecha nossa ponta de escrita do fd 3 no pai (o filho tem a dele).
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

	// Timeout: mata a árvore de processos.
	timedOut := false
	killTimer := time.AfterFunc(maxDur(5*time.Second, time.Duration(timeoutMs)*time.Millisecond), func() {
		timedOut = true
		killGroup(cmd)
	})

	pipeWG.Wait() // drena toda a saída
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
	flush() // enfileira o que sobrou ANTES do exit
	mu.Unlock()

	// cwd final
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

// exitCode extrai o código de saída do erro do Wait (nil = 0).
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

// ── Canal de arquivo ──────────────────────────────────────────────────────────
//
// Por que existe: o canal exec só devolve TEXTO, com teto de saída. Pra trazer
// um binário (foto, PDF, zip) o único jeito era gambiarra (base64 pelo stdout,
// que estoura o teto, ou pior: subir num host de terceiro). Aqui os bytes saem
// da máquina do dono direto pro NOSSO backend, em frames próprios, e nunca
// passam pela saída do terminal nem pelo contexto do modelo.
//
// LEITURA é livre na máquina inteira (mesmo modelo do exec), então o arquivo é
// aberto direto, sem cerca. Escrita não entra aqui: este canal é só de saída.

const fileChunkRaw = 192 * 1024       // bytes por chunk ANTES do base64
const fileMaxBytes = 64 * 1024 * 1024 // teto duro local, mesmo se o server pedir mais

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

	// postResult é síncrono; ler e postar em sequência JÁ garante a ordem dos
	// chunks (o `seq` viaja junto só pra o outro lado poder conferir).
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
			// No app não matamos o processo: zera o token e o painel volta a
			// pedir um código novo, sem terminal.
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
		go runExec(f) // não bloqueia o loop de poll
	}
	if f.Type == "readfile" {
		logLine("arquivo pedido: " + f.Path)
		go runReadFile(f) // idem: streaming em paralelo ao poll
	}
	// idle -> só re-pola
}

func sleep(d time.Duration) { time.Sleep(d) }

func logLine(m string) {
	ts := time.Now().Format("15:04:05")
	fmt.Printf("[%s] %s\n", ts, m)
	status.push(ts + " " + m)
}

// panelMode = aberto por duplo-clique (app), sem token no ambiente. Muda o
// comportamento de erro (não mata o processo; devolve o controle ao painel).
var panelMode = false

func main() {
	// Técnico com token no ambiente => modo CLI (terminal), como sempre.
	// Sem token no ambiente => modo painel (app de duplo-clique + navegador).
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
	startPanel() // abre o painel local + navegador e mantém o app vivo
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
