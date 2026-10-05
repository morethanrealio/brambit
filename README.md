# Brambit

Motor aberto de assistentes de IA: cada pessoa tem assistentes próprios que
conversam pela web, WhatsApp, Telegram, e-mail e Slack, lembram do que importa,
usam conectores (Google, Microsoft, GitHub, MCP), rodam código num sandbox,
criam e hospedam pequenos apps e executam rotinas agendadas. O modelo de IA é
escolha de quem instala: qualquer provedor compatível com a API da OpenAI, ou o
Gemini, com a sua chave.

## Quick start

Requisitos: Node.js 24 (a versão do CI) em Linux ou macOS. O banco vem junto
(Postgres 14 pelo npm); não precisa instalar mais nada.

```bash
npm ci
cp .env.example .env
cp modelos.example.yaml modelos.yaml   # escolha provedores e modelos (explicado no arquivo)
# cole no .env a chave de cada provedor que o modelos.yaml usa
npm run modelos                        # confere: função → modelo, e avisa chave faltando
npm run local
```

O `npm run local` sobe um banco descartável em `.local/` (só num socket local),
aplica schema e migrações, cria uma conta de teste e abre o servidor. Quando
aparecer `[local] pronto: http://127.0.0.1:8080`, entre com `teste@example.com` /
`brambs-local-teste`. Pra recomeçar do zero, pare (Ctrl+C) e apague `.local/`.

Pra o assistente rodar código (python, shell), suba o sandbox num outro
terminal: `ops/sandbox-host/local.sh` (Linux com Docker; pede `sudo` pro
firewall). Ele imprime as duas linhas `SANDBOX_*` pro `.env`. Detalhe em
[`ops/sandbox-host/README.md`](ops/sandbox-host/README.md).

### Provedores e modelos

O Brambit não traz modelo próprio: você escolhe o provedor e usa a sua chave. A
escolha fica no `modelos.yaml`, um arquivo comentado com três seções:

- `provedores`: apelido, endereço da API e o *nome* da variável do `.env` com a
  chave. Qualquer serviço compatível com a API da OpenAI entra sem código
  (Together, OpenAI, OpenRouter, Groq, DeepSeek, Ollama local...); o Gemini entra
  com `tipo: gemini`.
- `funcoes`: o modelo de cada função (conversa, imagem, pesquisa, programação,
  memória, classificação...), com um modelo `reserva` opcional que entra se o
  principal cair. Função sem linha herda do `padrao`, então uma linha basta.
- `precos`: preço de modelo novo, pra o registro de gasto sair certo.

Sem `modelos.yaml`, vale o roteamento embutido, e basta uma destas chaves no `.env`:

| Provedor | Variável | Modelo de texto usado |
| --- | --- | --- |
| Together (recomendado) | `TOGETHER_API_KEY` | DeepSeek V4.1 Flash |
| OpenAI | `OPENAI_API_KEY` | gpt-5.4-mini |
| Google Gemini | `GEMINI_API_KEY` | roteador do Gemini (3.5 Flash / 3.1 Pro) |

Nos dois caminhos, gerar imagem, falar em voz e transcrever áudio usam o Gemini:
sem `GEMINI_API_KEY` esses três ficam desligados. O resto (WhatsApp, Slack,
conectores, e-mail) desliga sozinho enquanto a configuração dele estiver vazia
no `.env`; cada bloco está explicado no [.env.example](.env.example).

## Arquitetura e fluxo de uma tarefa

O backend é um monólito Node.js modular: `web/server.mjs` integra HTTP, canais,
conversas e workers no mesmo serviço. PostgreSQL guarda contas, conversas,
propostas e registros de execução; checkpoints privados de programação e chamadas
de modelo também ficam em filesystem cifrado. Os apps dos usuários e o sandbox
executam em hosts separados; o Runner pode executar na máquina do próprio usuário.

```mermaid
flowchart LR
  U[Web, app e canais] --> S[Servidor: autenticação e conversa]
  S --> C[Confirmações persistentes]
  S --> L[Loop do agente e providers]
  C --> T[Ferramentas e conectores]
  L --> T
  S --> W[Workers e scheduler]
  W --> T
  S <--> P[(PostgreSQL)]
  C <--> P
  W <--> P
  W <--> F[(Checkpoints cifrados)]
  T --> E[APIs externas, apps, sandbox e Runner]
  T --> R[Recibos e resultados]
  R --> P
  R --> U
```

A entrada resolve dono/assistente/conversa e aplica os controles do canal. No
wrapper conversacional, confirmações e controles determinísticos são tratados
antes de chamar o modelo. Ferramentas nativas sujeitas a confirmação persistem a
proposta; a resposta humana revalida alvo e autorização antes do efeito. Isso não
significa que toda ferramenta externa MCP já esteja protegida por esse gate.

O loop escolhe ferramentas e chama providers com contabilização de uso. Trabalhos
de programação continuam em worker durável, com checkpoints e locks de kernel;
lembretes têm uma ocorrência por disparo e recibos por parte no WhatsApp. Uma
resposta gerada, uma ação aceita e uma entrega confirmada são estados diferentes.

O desenho de programação é de um único host; locks locais não são uma fila
distribuída. Reservas SQL protegem confirmações, rotinas e ocorrências, mas não
tornam todo o serviço apto a múltiplas réplicas.

### Plugins e portas

Quem instala o Brambit estende o motor por plugins (`web/plugins.mjs`), sem mexer
no núcleo: marca (nome, site, logo), páginas, telas, catálogo de mensagens e as
*portas*, pontos onde o núcleo pergunta algo a quem instalou (quanto a pessoa
pode gastar, que limites de apps e disco valem, quem paga uma conta). Sem plugin,
cada porta tem um padrão que deixa a instância inteira funcionando.

## Estrutura

- `web/` — servidor (HTTP, canais, persistência, ferramentas). Começar por
  `server.mjs`, `db.mjs` (Postgres, schema `mtr_harness`) e `auth.mjs`.
- `core-proto/` — loop de agente model-agnostic (`core.mjs`), contrato comum de
  provider (`provider.mjs`) e os adapters em `providers/`.
- `onboarding/`, `routines/`, `discovery/`, `deepseek/`, `billing/` — fontes
  TypeScript de subsistemas; os builds geram módulos runtime versionados em `web/`.
- `migrations/` — SQL de migração; o `npm run local` aplica em ordem.
- `runner-go/` — o Runner: executa comandos na máquina do próprio usuário, com
  confinamento no kernel.
- `ops/sandbox-host/` — sandbox de código (máquina dedicada ou modo local).
- `ops/apps-host/` — plano de controle dos apps hospedados (`ctl.py`, `router.py`).
- `ops/tenancy-*.mjs` — provas de isolamento entre contas, rodadas pela suíte.
- `dev/` — `npm run local` e `npm run modelos`.
- `test-support/` — apoio da suíte de testes.

## Desenvolvimento e validação

Pra rodar na sua máquina, use o [Quick start](#quick-start). Nunca reutilize o
`.env` de uma instância em produção para testes: o boot aplica schema e inicia
as integrações configuradas. O `.env` não é versionado. Fora do `npm run local`,
o entrypoint é `node web/server.mjs`, por padrão em `127.0.0.1:8090`.

Na rotina, rode só os testes da área que mudou (`node --test arquivo.test.mjs` ou
o script da área); `npm test` roda a suíte inteira. Testes de navegador exigem
Chromium/Chrome via `CHROMIUM_PATH` quando necessário; testes de armazenamento de
programação precisam de `flock`. Os testes com banco usam o mesmo Postgres 14
embutido:

```bash
export TEST_POSTGRES_BIN="$(node --input-type=module -e "const m=await import('./dev/local.mjs');console.log(m.postgresBin())")"
node --test server-boot.test.mjs
```

Esse teste cria seu próprio banco, isola credenciais e bloqueia acessos externos.
Essa proteção não deve ser presumida para qualquer script de eval do repositório.

## Licença e contribuição

O código é [AGPL-3.0](LICENSE). Nomes, logos e mascotes ficam fora da licença
(ver [GOVERNANCE.md](GOVERNANCE.md#marca)). Para contribuir, leia o
[CONTRIBUTING.md](CONTRIBUTING.md); vulnerabilidades vão pelo [SECURITY.md](SECURITY.md).
