// Erro de parada de execução por limite de gasto. Mora aqui, fora de
// execution-credit.mjs, para o núcleo poder lançar e reconhecer o erro sem
// importar a implementação de crédito. O nome da classe é contrato:
// core-proto/core.mjs e provider-attempt.mjs comparam constructor.name.
export class ExecutionCreditError extends Error {
  constructor(code){super(code);this.code=code;}
}
