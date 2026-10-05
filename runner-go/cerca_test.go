package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// Sem cerca no modo restrito o comando é recusado; acesso total é escolha explícita.
func TestSemCerca(t *testing.T) {
	casos := []struct {
		mode     string
		confined bool
		recusa   bool
	}{
		{"workspace-write", false, true},
		{"read-only", false, true},
		{"full-access", false, false},
		{"workspace-write", true, false},
		{"read-only", true, false},
	}
	for _, c := range casos {
		if got := semCerca(policy{Mode: c.mode}, c.confined); got != c.recusa {
			t.Errorf("semCerca(%s, confined=%v) = %v, quero %v", c.mode, c.confined, got, c.recusa)
		}
	}
}

func TestMsgSemCerca(t *testing.T) {
	m := msgSemCerca("windows")
	if !strings.Contains(m, "RECUSADO") || !strings.Contains(m, "Liberar acesso total nesta máquina") {
		t.Fatalf("mensagem sem o essencial: %q", m)
	}
	if strings.Contains(m, "bubblewrap") {
		t.Fatalf("dica do bwrap só no linux: %q", m)
	}
	if !strings.Contains(msgSemCerca("linux"), "bubblewrap") {
		t.Fatal("linux tem que sugerir o bubblewrap")
	}
}

// O painel só promove pra acesso total onde não há cerca; restringir sempre pode.
func TestCheckModeChange(t *testing.T) {
	casos := []struct {
		want    string
		canConf bool
		locked  bool
		code    int
	}{
		{"full-access", false, false, 200},
		{"full-access", true, false, 403},
		{"workspace-write", true, false, 200},
		{"workspace-write", false, false, 200},
		{"read-only", false, false, 400},
		{"qualquer", false, false, 400},
		{"full-access", false, true, 409},
		{"workspace-write", true, true, 409},
	}
	for _, c := range casos {
		if code, _ := checkModeChange(c.want, c.canConf, c.locked); code != c.code {
			t.Errorf("checkModeChange(%s, canConf=%v, locked=%v) = %d, quero %d", c.want, c.canConf, c.locked, code, c.code)
		}
	}
}

// Trocar o modo pelo painel não pode apagar o token nem as pastas.
func TestPersistModePreservaConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv(envVar("RUNNER_MODE"), "")
	orig := configFile{Token: "tok-123", WriteDirs: []string{"/x/y"}}
	b, _ := json.Marshal(orig)
	if err := os.WriteFile(configPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := persistMode("full-access"); err != nil {
		t.Fatal(err)
	}
	var got configFile
	raw, _ := os.ReadFile(configPath())
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Mode != "full-access" || got.Token != "tok-123" || len(got.WriteDirs) != 1 || got.WriteDirs[0] != "/x/y" {
		t.Fatalf("config ficou %+v", got)
	}
	if loadPolicy().Mode != "full-access" {
		t.Fatal("loadPolicy não leu o modo gravado")
	}
	if st, _ := os.Stat(configPath()); st.Mode().Perm() != 0o600 {
		t.Fatalf("permissão %v, quero 0600", st.Mode().Perm())
	}
}

// Ponta a ponta numa máquina sem cerca (Linux sem bwrap, Windows): no modo
// restrito o comando não roda; em acesso total roda. Em máquina com cerca o
// teste não se aplica e é pulado.
func TestRunExecSemCerca(t *testing.T) {
	if canConfine() || runtime.GOOS == "windows" {
		t.Skip("esta máquina tem cerca (ou é Windows); o caso sem cerca não se aplica aqui")
	}
	var mu sync.Mutex
	var frames []frame
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var f frame
		json.NewDecoder(r.Body).Decode(&f)
		mu.Lock()
		frames = append(frames, f)
		mu.Unlock()
	}))
	defer srv.Close()
	oldBase := base
	base = srv.URL
	defer func() { base = oldBase }()

	home := t.TempDir()
	t.Setenv("HOME", home)
	alvo := filepath.Join(home, "criado.txt")
	comando := "touch " + shq(alvo)

	t.Setenv(envVar("RUNNER_MODE"), "workspace-write")
	runExec(frame{ReqID: "r1", Type: "exec", Comando: comando, Cwd: home})
	if _, err := os.Stat(alvo); err == nil {
		t.Fatal("modo restrito sem cerca rodou o comando")
	}
	mu.Lock()
	var saida string
	var exit *int
	for _, f := range frames {
		saida += f.Chunk
		if f.Type == "exit" {
			exit = f.ExitCode
		}
	}
	frames = nil
	mu.Unlock()
	if exit == nil || *exit != 126 || !strings.Contains(saida, "RECUSADO") {
		t.Fatalf("esperava recusa com exit 126; exit=%v saída=%q", exit, saida)
	}

	t.Setenv(envVar("RUNNER_MODE"), "full-access")
	runExec(frame{ReqID: "r2", Type: "exec", Comando: comando, Cwd: home})
	if _, err := os.Stat(alvo); err != nil {
		t.Fatal("acesso total escolhido de propósito tem que rodar o comando")
	}
}
