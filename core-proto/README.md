# core-proto — protótipo do core model-agnostic

Prova de conceito: **o mesmo loop + as mesmas tools, trocando só o provider (modelo)**.

## Rodar
```
node run.mjs                          # demo determinística (2 providers, sem credencial)
GEMINI_API_KEY=... node run-gemini.mjs # demo ao vivo no Gemini real (3.5 Flash + 3.1 Pro)
```
A chave NUNCA fica no repo: o adapter lê de `process.env.GEMINI_API_KEY`.

## Ideia central (diferença vs NanoClaw)
No NanoClaw o provider (Claude Code SDK) é dono do tool-loop. Aqui **o core é dono do
tool-loop** e o provider faz só UM turno de modelo. Resultado: trocar de modelo (inclusive
um proprietário) = implementar uma função `complete()`. Loop, tools, memória e protocolos
não mudam.

## Arquivos
- `provider.mjs` — o contrato inteiro (cabe num parágrafo, de propósito).
- `core.mjs` — o harness: `ToolRegistry` + `runAgent()` (o loop). ~50 linhas de lógica.
- `tools.mjs` — tools de exemplo (`search_products`), shape = JSON Schema (compatível com MCP).
- `providers/scripted.mjs` — provider determinístico; 2 instâncias simulam 2 modelos. Usado na demo.
- `providers/gemini.mjs` — adapter real do Google Gemini (TESTADO ao vivo). Inclui
  `makeGeminiRouter()`: 3.5 Flash por padrão, escala pro 3.1 Pro em tarefas pesadas.
- `providers/anthropic.mjs` — adapter real da Anthropic (pronto p/ quando houver credencial).
- `providers/openai.mjs` — adapter real da OpenAI (idem). Mostra que "outro modelo" = +1 arquivo.
- `run.mjs` — demo: roda o mesmo loop com 2 providers.

## Próximos passos
- Ativar um adapter real (depende de credencial no gateway p/ api.anthropic.com ou api.openai.com).
- Plugar tools de um MCP server real em vez do catálogo fake.
- Camada de memória/sessão (continuação) — hoje o loop é stateless por chamada.
- Subir as camadas de produto B2C (login → provisiona agente, onboarding de conectores).
