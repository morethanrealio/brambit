# core-proto — prototype of the model-agnostic core

Proof of concept: **the same loop + the same tools, swapping only the provider (model)**.

## Run
```
node run.mjs                          # deterministic demo (2 providers, no credentials)
GEMINI_API_KEY=... node run-gemini.mjs # live demo on real Gemini (3.5 Flash + 3.1 Pro)
```
The key is NEVER in the repo: the adapter reads it from `process.env.GEMINI_API_KEY`.

## Core idea (vs. NanoClaw)
In NanoClaw, the provider (Claude Code SDK) owns the tool loop. Here **the core
owns the tool loop** and the provider does only ONE model turn. Result: switching
models (even a proprietary one) = implementing one `complete()` function. Loop,
tools, memory and protocols don't change.

## Files
- `provider.mjs` — the entire contract (fits in one paragraph, on purpose).
- `core.mjs` — the harness: `ToolRegistry` + `runAgent()` (the loop). ~50 lines of logic.
- `tools.mjs` — example tools (`search_products`), shaped as JSON Schema (MCP-compatible).
- `providers/scripted.mjs` — deterministic provider; 2 instances simulate 2 models. Used in the demo.
- `providers/gemini.mjs` — real Google Gemini adapter (TESTED live). Includes
  `makeGeminiRouter()`: 3.5 Flash by default, escalates to 3.1 Pro for heavy tasks.
- `providers/anthropic.mjs` — real Anthropic adapter (ready for when credentials exist).
- `providers/openai.mjs` — real OpenAI adapter (same idea). Shows that "another model" = +1 file.
- `run.mjs` — demo: runs the same loop with 2 providers.

## Next steps
- Turn on a real adapter (depends on gateway credentials for api.anthropic.com or api.openai.com).
- Plug in tools from a real MCP server instead of the fake catalog.
- Memory/session layer (continuation) — today the loop is stateless per call.
- Bring up the B2C product layers (login → provisions agent, connector onboarding).
