# Runner (núcleo Go)

Daemon nativo que roda na máquina do usuário: disca OUTBOUND pro servidor
(long-poll), executa comandos localmente e faz streaming da saída de volta.
Segundo transporte atrás da MESMA tool `terminal`. Este é o ÚNICO runner
distribuído: a versão Node antiga (`web/public/<slug>-runner.mjs`) saiu do repo e do
`/runner` em 26/08/2026, porque parou no protocolo 1.0 (só `exec`) e o cliente
descarta frame desconhecido calado — seguir oferecendo ela só renderia pedido
de arquivo pendurado até o timeout. A referência de protocolo agora é este
`main.go` + `web/runner.mjs`.

Confinamento de escrita determinístico pelo SO (não parsing de comando):
seatbelt no macOS, bubblewrap no Linux. Onde não dá pra cercar (Windows,
Linux sem bwrap), o modo restrito RECUSA todo comando (exit 126, desde a 2.2.0);
pra usar ali o dono escolhe acesso total de propósito, no botão "Liberar acesso
total nesta máquina" do painel ou na config. O painel só oferece esse botão onde
não há cerca: onde há, um comando cercado poderia achar o endereço do painel e se
promover, então lá acesso total continua só pela config local. Leitura = sistema inteiro; escrita = só as
pastas autorizadas (config local `~/.<slug>-runner.json`, nunca ampliada pelo
servidor).

## Marca

Nome, site e prefixos não estão no fonte: vêm na hora de gerar o programa
(`marca.go`, preenchido por `-ldflags -X`). Sem nada, é o do núcleo:

| | padrão (núcleo) | com `PRODUTO=Acme` |
|---|---|---|
| nome na tela | Brambit Runner | Acme Runner |
| executável | `brambit-runner-linux` etc. | `acme-runner-linux` etc. |
| variáveis | `BRAMBIT_RUNNER_TOKEN`, `BRAMBIT_URL`... | `ACME_RUNNER_TOKEN`, `ACME_URL`... |
| config local | `~/.brambit-runner.json` | `~/.acme-runner.json` |
| pasta de escrita padrão | `~/Documents/Brambit` | `~/Documents/Acme` |

O `PRODUTO` tem que ser o mesmo nome da marca do servidor (`marca().nome`):
é dele que a `/runner` tira os nomes dos arquivos pra baixar e os comandos
que mostra. Trocar o nome de uma instalação que já tem Runner instalado muda a
config local e as variáveis, então os Runners antigos param de achar o token.

## Build (binários servidos em /runner)

```sh
PRODUTO=Acme SITE=https://acme.exemplo ./build.sh
```

Gera os quatro executáveis em `web/public/runner-bin` (variáveis no topo do
`build.sh`). O app de duplo-clique do Mac (`<PRODUTO>-Runner-Mac.zip`, com o
`.app`) não sai do script.

`-H windowsgui` no Windows NÃO é opcional e não vem do fonte: é flag de link.
Sem ela o .exe sai como subsistema console (3) e abre uma janela de terminal
preta a cada execução. Com ela sai subsistema 2 (GUI), que é o comportamento
esperado do app de duplo-clique. Conferir com `pe+24+68` no header opcional.

## Dois modos (o binário é o mesmo)

Decidido em `main()` pela presença de `<SLUG>_RUNNER_TOKEN` no ambiente:

- **com token no ambiente** => modo CLI (`runCLI()`), o comportamento de
  sempre, pra quem roda no terminal.
- **sem token no ambiente** => modo painel (`startPanel()`, `panel.go`): sobe
  um HTTP local em `127.0.0.1:0`, sorteia um nonce, abre o navegador em
  `http://127.0.0.1:PORT/?k=<nonce>` e espera o código de conexão colado pelo
  usuário. O token vai pro `~/.<slug>-runner.json` em modo 0600. Toda rota do
  painel exige o nonce (sem ele, 403). É esse o caminho do duplo-clique no
  `.app` e no .exe.

O fonte do painel (`panel.go`, `panel_html.go`, o ícone do .exe)
ficou de fora do repo entre 21/08 e 26/08/2026: só os binários compilados
foram commitados. Quem recompilou a partir do repo em 26/08 gerou um app que
caía no `runCLI()`, reclamava de token faltando e morria na abertura. Se
mexer aqui, garantir que o fonte inteiro entre no commit.

Env (prefixo = `SLUG` em maiúsculas): `<SLUG>_RUNNER_TOKEN` (obrigatório só no
modo CLI), `<SLUG>_URL` (padrão: o `SITE` do build), `<SLUG>_RUNNER_DIR`,
`<SLUG>_RUNNER_MODE` (read-only|workspace-write|full-access),
`<SLUG>_RUNNER_WRITE_DIRS`.

PENDENTE (Fase D): assinatura/notarização + instaladores (.dmg/.pkg/.exe) +
deep-link de pareamento (Fase C). Fase B (app de duplo-clique) entregue: é o modo painel acima.
