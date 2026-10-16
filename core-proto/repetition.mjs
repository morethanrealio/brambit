import { createHash } from 'node:crypto';
import { executionSignature } from './turn-recovery.mjs';
// Only audited, read-only app tools can opt in. Never writes, HTTP calls or publish.
export const REVISION_READS = new Set(['ler_arquivo_do_app','listar_arquivos_do_app','validar_rascunho_do_app','buscar_codigo_do_app']);
export function callSignature(call, revision = '') {
  return createHash('sha256').update(executionSignature(call)).update('\n' + revision).digest('hex');
}
