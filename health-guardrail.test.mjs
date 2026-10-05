// Regra de saúde física/mental presente em todo prompt que fala com o usuário.
// Rodar: node health-guardrail.test.mjs
import { readFileSync } from 'node:fs';
import { HEALTH_GUARDRAIL } from './web/health-guardrail.mjs';
import { systemA, systemB } from './web/agent2agent.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) ok++; else { fail++; console.log(`FALHOU: ${nome}`); } };

t('menciona médico', /consultar um médico/.test(HEALTH_GUARDRAIL));
t('menciona psicólogo ou psiquiatra', /psicólogo ou psiquiatra/.test(HEALTH_GUARDRAIL));
t('CVV 188', /CVV/.test(HEALTH_GUARDRAIL) && /188/.test(HEALTH_GUARDRAIL));
t('192', /192/.test(HEALTH_GUARDRAIL));
t('sem travessão', !/—/.test(HEALTH_GUARDRAIL));

const agent = { name: 'Bia' };
t('systemA inclui', systemA({ ownerAName: 'A', agentA: agent, ownerBName: 'B', objetivo: 'x', language: 'pt-BR' }).includes(HEALTH_GUARDRAIL));
t('systemB inclui', systemB({ ownerBName: 'B', agentB: agent, ownerAName: 'A', language: 'pt-BR' }).includes(HEALTH_GUARDRAIL));

// server.mjs inicializa banco e serviços ao importar: confere pelo fonte.
const src = readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
t('server importa', /import \{ HEALTH_GUARDRAIL \} from '\.\/health-guardrail\.mjs';/.test(src));
t('systemFor, emergência e rascunho usam', (src.match(/HEALTH_GUARDRAIL/g) || []).length === 4);
const regra = src.indexOf('REGRA DE SEGURANÇA INEGOCIÁVEL');
const uso = src.indexOf('    HEALTH_GUARDRAIL,\n    \'CONFIRMAÇÃO POR REAÇÃO');
t('systemFor no bloco incondicional de segurança', regra > 0 && uso > regra && uso - regra < 6000);

console.log(`${ok} ok, ${fail} falharam`);
process.exit(fail ? 1 : 0);
