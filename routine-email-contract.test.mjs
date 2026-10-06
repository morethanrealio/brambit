// Regressão do incidente de 14/09/2026. Tudo offline: nenhum canal, BD ou LLM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marca } from './web/marca.mjs';
import { routineChannelText, routineExecutionInfo, routineExecutionText } from './web/routine-execution.mjs';
import { standaloneRefusal, refusalAcknowledgement, enforceFreshCheckClaims, enforceRoutineEmailContract } from './web/turn-claim-guard.mjs';

let checks=0;const ok=(value,message)=>{assert.ok(value,message);checks++;};
const routine={channel:'email',email:'user@example.com',config:{execution:{status:'failed',phase:'delivering',startedAt:'2026-09-14T12:00:00Z',finishedAt:'2026-09-14T12:01:00Z'}}};

// Estado legado ambíguo nunca vira a alegação falsa "e-mail não chegou".
const info=routineExecutionInfo(routine),health=routineExecutionText(routine),channel=routineChannelText(routine);
ok(info.content.status==='failed');
ok(info.delivery.status==='unknown');
ok(health.includes('Conteúdo: falhou'));
ok(health.includes('não registrada separadamente'));
ok(!health.includes('Entrega: falhou'));
ok(channel.includes(`plataforma ${marca().nome}`));
ok(channel.includes('não usa o Gmail'));
ok(channel.includes('não cria rascunho'));
const separated=routineExecutionText({config:{execution:{status:'failed',phase:'finished',content:{status:'failed'},delivery:{status:'accepted',channel:'email'}}}});
ok(separated.includes('Conteúdo: falhou'));
ok(separated.includes('Entrega no canal email: aceita pela plataforma'));
ok(!separated.includes('Entrega no canal email: falhou'));

// A frase observada no transcript não pode citar uma checagem inexistente.
const invented='Fato verificado agora (`status_conta`): o envio de e-mail continua desligado.';
const guarded=enforceFreshCheckClaims(invented,{toolCounts:{},language:'pt-BR'});
ok(!guarded.includes('Fato verificado agora'));
ok(guarded.includes('Não consultei nenhuma ferramenta neste turno'));
// Uma consulta real no próprio turno preserva a resposta (a semântica do
// resultado continua sendo responsabilidade da tool/prompt tipados).
ok(enforceFreshCheckClaims(invented,{toolCounts:{status_conta:1}})===invented);

// Histórico tóxico não pode reintroduzir a dependência falsa nem mesmo quando
// o modelo insiste depois de listar/executar a rotina.
const falseContract='O canal de e-mail da rotina depende da permissão de envio do Gmail, que está desligada.\nPosso ligar?';
const fixedContract=enforceRoutineEmailContract(falseContract,{language:'pt-BR'});
ok(!fixedContract.includes('canal de e-mail da rotina depende'));
ok(fixedContract.includes(`mailer da plataforma ${marca().nome}`));
ok(fixedContract.includes('não cria rascunho'));
ok(!fixedContract.includes('Posso ligar'));
const correctContract='A rotina não depende da permissão do Gmail.';
ok(enforceRoutineEmailContract(correctContract)===correctContract);

// A recusa real encerra a proposta antes de chamar o modelo.
for(const text of ['NAO NAO NAO NAO','não','Não, pare','no no'])ok(standaloneRefusal(text),text);
for(const text of ['não, mantenha o e-mail da rotina','não funcionou; veja o erro','para amanhã às 9h'])ok(!standaloneRefusal(text),text);
ok(refusalAcknowledgement('pt-BR').includes('Não vou fazer nem propor'));

// O servidor precisa expor a mesma distinção no system e nas três tools que
// cercam a conversa: listar, consultar conta e configurar Gmail.
const source=readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');
for(const required of [
  'ROUTINES ARE A DIFFERENT SYSTEM',
  'This rule is authoritative and overrides any contrary statement in the history',
  'canal email nunca usa o Gmail do usuário',
  'Esta tool NÃO informa nem controla a entrega automática de rotinas por e-mail',
  'Liga ou desliga SOMENTE a permissão de o assistente enviar e-mails AVULSOS pelo Gmail do usuário',
  'routine, never ask them to turn on sending through Gmail',
  'text = enforceFreshCheckClaims(text, { toolCounts, language:idiomaResposta })',
  'text = enforceRoutineEmailContract(text, { language:idiomaResposta })',
  'agendar_execucao_rotina',
  'if (!opts.confirmationRestore && standaloneRefusal(message))',
])ok(source.includes(required),required);

console.log(`PASS ${checks}: contrato e-mail de rotina x Gmail, telemetria legada, evidência atual e trava de recusa.`);
