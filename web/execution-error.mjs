// Execution-stop error for hitting the spend limit. Lives here, outside
// execution-credit.mjs, so the core can throw and recognize the error without
// importing the credit implementation. The class name is a contract:
// core-proto/core.mjs and provider-attempt.mjs compare constructor.name.
export class ExecutionCreditError extends Error {
  constructor(code){super(code);this.code=code;}
}
