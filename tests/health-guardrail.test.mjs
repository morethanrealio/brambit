// Physical/mental health rule present in every prompt that talks to the user.
// Run: node tests/health-guardrail.test.mjs
import { readFileSync } from 'node:fs';
import { HEALTH_GUARDRAIL } from '../web/health-guardrail.mjs';
import { systemA, systemB } from '../web/agent2agent.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) ok++; else { fail++; console.log(`FALHOU: ${nome}`); } };

t('mentions a doctor', /see a doctor/.test(HEALTH_GUARDRAIL));
t('mentions a psychologist or psychiatrist', /psychologist or psychiatrist/.test(HEALTH_GUARDRAIL));
t('CVV 188', /CVV/.test(HEALTH_GUARDRAIL) && /188/.test(HEALTH_GUARDRAIL));
t('192', /192/.test(HEALTH_GUARDRAIL));
t('no em dash', !/—/.test(HEALTH_GUARDRAIL));

const agent = { name: 'Bia' };
t('systemA includes', systemA({ ownerAName: 'A', agentA: agent, ownerBName: 'B', objetivo: 'x', language: 'pt-BR' }).includes(HEALTH_GUARDRAIL));
t('systemB includes', systemB({ ownerBName: 'B', agentB: agent, ownerAName: 'A', language: 'pt-BR' }).includes(HEALTH_GUARDRAIL));

// server.mjs initializes database and services on import: check against the source.
const src = readFileSync(new URL('../web/server.mjs', import.meta.url), 'utf8');
t('server imports', /import \{ HEALTH_GUARDRAIL \} from '\.\/health-guardrail\.mjs';/.test(src));
t('systemFor, emergency and draft use it', (src.match(/HEALTH_GUARDRAIL/g) || []).length === 4);
const regra = src.indexOf('NON-NEGOTIABLE SAFETY RULE');
const uso = src.indexOf('    HEALTH_GUARDRAIL,\n    \'CONFIRMATION BY REACTION');
t('systemFor in the unconditional safety block', regra > 0 && uso > regra && uso - regra < 6000);

console.log(`${ok} ok, ${fail} falharam`);
process.exit(fail ? 1 : 0);
