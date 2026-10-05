// ── Contrato mínimo do core (model-agnostic) ──
//
// A ideia central que diferencia do NanoClaw: AQUI o CORE é dono do tool-loop.
// O provider faz apenas UM turno de modelo: recebe (system, messages, tools) e
// devolve um Step (ou um texto final, ou uma lista de tool calls). Trocar de
// modelo = implementar `complete()`. Nada do loop, tools, memória ou protocolos
// muda. Um modelo proprietário entra como só mais um provider.
//
// Tipos (JSDoc, sem dependências):
//
// @typedef {{ role:'system'|'user'|'assistant'|'tool', content:string,
//             toolCallId?:string, name?:string, toolCalls?:ToolCall[] }} Msg
// @typedef {{ name:string, description:string, parameters:object }} ToolDef   // parameters = JSON Schema (compatível com MCP)
// @typedef {{ id:string, name:string, args:object }} ToolCall
// @typedef {{ text?:string, toolCalls?:ToolCall[], stop:'end'|'tool' }} Step
// Optional protocolError:{code,retryable:true}: whole tool batch was rejected
// before execution. Core may repair once within maxSteps; never a network retry.
//
// interface Provider {
//   name: string
//   // Um único turno do modelo. Sem efeitos colaterais, sem executar tools.
//   complete(input: { system:string, messages:Msg[], tools:ToolDef[] }): Promise<Step>
// }
//
// É só isso. O contrato inteiro cabe num parágrafo, de propósito.

export const STOP = { END: 'end', TOOL: 'tool' };
