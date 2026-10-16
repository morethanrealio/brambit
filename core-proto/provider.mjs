// ── Minimal core contract (model-agnostic) ──
//
// The core idea that differs from NanoClaw: HERE the CORE owns the tool-loop.
// The provider does only ONE model turn: receives (system, messages, tools) and
// returns a Step (either final text, or a list of tool calls). Swapping
// models = implementing `complete()`. Nothing about the loop, tools, memory or protocols
// changes. A proprietary model comes in as just another provider.
//
// Types (JSDoc, no dependencies):
//
// @typedef {{ role:'system'|'user'|'assistant'|'tool', content:string,
//             toolCallId?:string, name?:string, toolCalls?:ToolCall[] }} Msg
// @typedef {{ name:string, description:string, parameters:object }} ToolDef   // parameters = JSON Schema (compatible with MCP)
// @typedef {{ id:string, name:string, args:object }} ToolCall
// @typedef {{ text?:string, toolCalls?:ToolCall[], stop:'end'|'tool' }} Step
// Optional protocolError:{code,retryable:true}: whole tool batch was rejected
// before execution. Core may repair once within maxSteps; never a network retry.
//
// interface Provider {
//   name: string
//   // A single model turn. No side effects, no executing tools.
//   complete(input: { system:string, messages:Msg[], tools:ToolDef[] }): Promise<Step>
// }
//
// That's all there is. The whole contract fits in one paragraph, on purpose.

export const STOP = { END: 'end', TOOL: 'tool' };
