// Panel mode — the app's face for a NON-TECHNICAL user. When the binary is opened by
// double-click (without <SLUG>_RUNNER_TOKEN in the environment), instead of becoming a
// terminal program it brings up a small local panel on 127.0.0.1 and opens the
// browser on it: the person pastes the token, sees the live status and that's it. Zero
// terminal, zero command. (A technical user who sets the token via env falls into the usual
// CLI mode — see runCLI in main.go.)
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ── Token: env > config (persisted by the panel) ──────────────────────────────

var (
	tokMu sync.RWMutex
	token = os.Getenv(envVar("RUNNER_TOKEN"))
)

func getToken() string  { tokMu.RLock(); defer tokMu.RUnlock(); return token }
func setToken(t string) { tokMu.Lock(); token = t; tokMu.Unlock() }

func configToken() string {
	var cfg configFile
	if b, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	return strings.TrimSpace(cfg.Token)
}

// persistToken saves the token in ~/.<slug>-runner.json, preserving mode/writeDirs.
func persistToken(t string) error {
	var cfg configFile
	if b, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	cfg.Token = strings.TrimSpace(t)
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), b, 0o600)
}

// modeLocked = the mode came from the environment (<SLUG>_RUNNER_MODE), which overrides the config:
// saving via the panel wouldn't change anything, so the panel doesn't even offer it.
func modeLocked() bool { return os.Getenv(envVar("RUNNER_MODE")) != "" }

// checkModeChange decides whether the panel can switch the mode. Going back to restrict
// (workspace-write) is always allowed. Full access via the panel ONLY where there is no fence:
// there, in restricted mode, no command runs, so the assistant can't reach the
// panel; and it's the only way to use the runner on that machine. Where there is a fence
// (macOS, Linux with bwrap), a fenced command could find the panel's
// address and promote itself; there, full access still only comes from the local config.
func checkModeChange(want string, canConf, locked bool) (int, string) {
	switch {
	case locked:
		return 409, "o modo está fixado pela variável " + envVar("RUNNER_MODE")
	case want == "workspace-write":
		return 200, ""
	case want == "full-access" && !canConf:
		return 200, ""
	case want == "full-access":
		return 403, "esta máquina consegue cercar a escrita; acesso total só pela config local"
	}
	return 400, "modo inválido"
}

// persistMode saves the mode in ~/.<slug>-runner.json, preserving token/writeDirs.
func persistMode(m string) error {
	var cfg configFile
	if b, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	cfg.Mode = m
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), b, 0o600)
}

// ── Live status (the panel reads it via /status) ──────────────────────────────────

type liveStatus struct {
	mu        sync.Mutex
	connected bool
	lastOK    time.Time
	lastCmd   string
	lastCmdAt time.Time
	lines     []string // ring buffer of the latest activities
}

var status = &liveStatus{}

func (s *liveStatus) setConnected(v bool) {
	s.mu.Lock()
	s.connected = v
	if v {
		s.lastOK = time.Now()
	}
	s.mu.Unlock()
}

func (s *liveStatus) noteCmd(c string) {
	s.mu.Lock()
	s.lastCmd = c
	s.lastCmdAt = time.Now()
	s.mu.Unlock()
}

func (s *liveStatus) push(line string) {
	s.mu.Lock()
	s.lines = append(s.lines, line)
	if len(s.lines) > 60 {
		s.lines = s.lines[len(s.lines)-60:]
	}
	s.mu.Unlock()
}

func (s *liveStatus) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	pol := loadPolicy()
	_, confined := buildLauncher(pol, "bash", []string{"-lc", ":"})
	host, _ := os.Hostname()
	ls := append([]string{}, s.lines...)
	out := map[string]any{
		"version":      version,
		"tokenPresent": getToken() != "",
		"connected":    s.connected,
		"hostname":     host,
		"os":           runtime.GOOS,
		"arch":         runtime.GOARCH,
		"mode":         pol.Mode,
		"writeDirs":    pol.WriteDirs,
		"confined":     confined,
		"canConfine":   canConfine(),
		"modeLocked":   modeLocked(),
		"startDir":     startDir,
		"lines":        ls,
	}
	if !s.lastOK.IsZero() {
		out["lastOK"] = s.lastOK.Format("15:04:05")
	}
	if s.lastCmd != "" {
		out["lastCmd"] = s.lastCmd
		out["lastCmdAt"] = s.lastCmdAt.Format("15:04:05")
	}
	return out
}

// ── Panel server ─────────────────────────────────────────────────────────

var pollOnce_ sync.Once

// startPolling fires the long-poll loop (only once).
func startPolling() {
	pollOnce_.Do(func() {
		go func() {
			for !stopping {
				pollOnce()
			}
		}()
	})
}

func randNonce() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return slug
	}
	return hex.EncodeToString(b)
}

// startPanel brings up the local panel, opens the browser and returns the URL. If a
// token already exists, it starts polling right away. Blocks the process alive (the app doesn't "end").
func startPanel() {
	nonce := randNonce()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		// No panel: falls back to degraded CLI mode (no browser), at least it polls.
		fmt.Fprintln(os.Stderr, "não consegui abrir o painel local:", err)
		if getToken() != "" {
			startPolling()
		}
		select {}
	}
	port := ln.Addr().(*net.TCPAddr).Port
	panelURL := fmt.Sprintf("http://127.0.0.1:%d/?k=%s", port, nonce)

	mux := http.NewServeMux()
	checkNonce := func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Query().Get("k") != nonce {
			w.WriteHeader(403)
			w.Write([]byte("forbidden"))
			return false
		}
		return true
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			w.WriteHeader(404)
			return
		}
		if !checkNonce(w, r) {
			return
		}
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.Write([]byte(strings.NewReplacer("__K__", nonce, "__NOME__", nomeRunner(), "__PRODUTO__", produto, "__SITE__", siteNoTexto()).Replace(panelHTML)))
	})
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if !checkNonce(w, r) {
			return
		}
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(status.snapshot())
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if !checkNonce(w, r) || r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		var body struct {
			Token string `json:"token"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		t := strings.TrimSpace(body.Token)
		if t == "" {
			w.WriteHeader(400)
			w.Write([]byte(`{"ok":false,"error":"token vazio"}`))
			return
		}
		if err := persistToken(t); err != nil {
			w.WriteHeader(500)
			w.Write([]byte(`{"ok":false,"error":"não consegui salvar"}`))
			return
		}
		setToken(t)
		status.push(time.Now().Format("15:04:05") + " token salvo, conectando…")
		startPolling()
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/mode", func(w http.ResponseWriter, r *http.Request) {
		if !checkNonce(w, r) || r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		var body struct {
			Mode string `json:"mode"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", "application/json")
		code, why := checkModeChange(body.Mode, canConfine(), modeLocked())
		if code == 200 {
			if err := persistMode(body.Mode); err != nil {
				code, why = 500, "não consegui salvar"
			}
		}
		if code != 200 {
			w.WriteHeader(code)
			json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": why})
			return
		}
		status.push(time.Now().Format("15:04:05") + " modo trocado para " + body.Mode)
		logLine("modo trocado pelo painel: " + body.Mode)
		w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/quit", func(w http.ResponseWriter, r *http.Request) {
		if !checkNonce(w, r) || r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		w.Write([]byte(`{"ok":true}`))
		go func() { time.Sleep(200 * time.Millisecond); os.Exit(0) }()
	})

	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)

	if getToken() != "" {
		startPolling()
	}
	status.push(time.Now().Format("15:04:05") + " painel aberto")
	openBrowser(panelURL)
	fmt.Println(nomeRunner()+" — painel em", panelURL)
	select {} // keeps the app alive
}

func openBrowser(u string) {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", u)
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		c = exec.Command("xdg-open", u)
	}
	_ = c.Start()
}
