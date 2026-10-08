import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {appEditingReply,wantsTechnicalAppDetails} from './web/app-editing-reply.mjs';
import {appTaskReceipt} from './web/app-review-receipt.mjs';
import {createAppBuildJournal} from './web/app-build-state.mjs';
const ready={version:2,modo:'edicao',estado:'consistencia_validada',motivo:'completed',validacao:'aprovado',revisao:'a'.repeat(64),arquivos:['public/index.html','ESPEC.md'],publicado:false,background:false};
function journal(build,options={}){const j=createAppBuildJournal(options);j.toolResult({name:'construir_app'},{app_build:build,resumo_do_modelo:'Publiquei e tudo funciona!'});return j;}
for(const lang of ['pt-BR','en','es'])test(`natural completion ${lang}: short, trusted saved state, publication choice, no debug dump`,()=>{
 const build=structuredClone(ready),before=structuredClone(build),j=journal(build,{language:lang});const text=j.finish('Publiquei e tudo funciona!');assert.ok(text.length<260);assert.ok(!/public\/index|ESPEC|boot|runtime|hash|estátic|static|estatic|consistencia|debug|Publiquei e tudo funciona/.test(text));assert.ok(text.endsWith('?'));assert.equal(j.blockPublish(),null);assert.deepEqual(build,before);assert.equal(text,appTaskReceipt(build,lang));
 if(lang==='pt-BR')assert.equal(text,'As alterações desta etapa estão salvas. Ainda não publiquei essa versão. Quer publicar essa versão ou ajustar mais alguma coisa?');
});
test('no confirmed file changes never implies edits were made',()=>{
 const text=journal({...ready,arquivos:[]}).finish('Alterei tudo');assert.ok(text.includes('sem alterar arquivos'));assert.ok(!text.includes('alterações desta etapa estão salvas'));
});
test('unknown/paused/failed/stale validation never invites publication or claims completion',()=>{
 for(const patch of [{estado:'interrompido',motivo:'read_coverage_loop'},{estado:'nao_validado',validacao:'pendente'},{estado:'requer_correcao',validacao:'reprovado'},{motivo:'execution_error'},{revisao:'wrong'},{background:true}]){
  const b={...ready,...patch};const text=journal(b).finish('Tudo pronto e publicado');assert.ok(!text.includes('Quer publicar'),JSON.stringify(patch));assert.ok(!text.includes('Terminei'),JSON.stringify(patch));assert.ok(!text.includes('Tudo pronto'));assert.ok(text.includes('Ainda não publiquei'));if(b.estado!=='consistencia_validada')assert.ok(journal(b).blockPublish());
 }
});
test('reasons remain distinct in plain language: credit, service, permissions, uncertain effects',()=>{
 const reasonText={account_credit_exhausted:'saldo de créditos acabou',account_credit_reserved:'comprometida',credit_reservation_unavailable:'não cobre',credit_reconciliation_required:'não repetir a cobrança',credit_control_unavailable:'Não vou tratar isso como falta de saldo',provider_failure:'falha no serviço',uncertain_action:'para não repeti-la',access_denied:'acesso',draft_changed:'versão atual',scope_clarification:'escopo'};
 for(const [motivo,part] of Object.entries(reasonText)){const text=appEditingReply({...ready,estado:'interrompido',motivo});assert.ok(text.includes(part),motivo);assert.ok(!text.includes('Quer publicar'));assert.ok(!text.includes('Não debitei'));}
});
test('confirmed successful tool state cannot be replaced by arbitrary model/code/diagnostic payloads',()=>{
 const b={...ready,arquivos:['SECRET_PATH'],lint_erros:[{tipo:'SECRET_PAYLOAD'}],parecer:[{observacao:'SECRET_REPORT'}],perguntas:['```code?```','Publiquei tudo?'],resumo_do_modelo:'SECRET_MODEL'};
 const text=journal(b).finish('SECRET_UNTRUSTED');assert.ok(!text.includes('SECRET'));assert.ok(!text.includes('Publiquei tudo'));assert.ok(text.includes('Quer publicar'));
});
test('an actual pending publication has one confirmation question, never an alternative fake proposal',()=>{
 const j=journal(ready);j.toolResult({name:'publicar_sistema'},'AÇÃO PENDENTE DE CONFIRMAÇÃO (NÃO foi executada).');const text=j.finish('Já publiquei');assert.equal((text.match(/\?/g)||[]).length,1);assert.ok(text.includes('aguardando sua confirmação'));assert.ok(!text.includes('ajustar mais'));assert.ok(!text.includes('Já publiquei'));
});
test('publication failure remains failure; only successful publisher owns published receipt',()=>{
 const j=journal(ready);j.toolResult({name:'publicar_sistema'},{ok:false,error:'SECRET_INFRA_ERROR'});const text=j.finish('Está no ar');assert.ok(text.includes('não foi concluída'));assert.ok(!text.includes('SECRET'));assert.ok(!text.includes('Quer publicar'));j.toolResult({name:'publicar_sistema'},{ok:true});assert.equal(j.finish('Recibo real do publicador'),'Recibo real do publicador');
});
test('technical detail requests in PT/EN/ES select the existing detailed receipt; no technical default',()=>{
 for(const [language,userRequest] of [['pt-BR','Mostre os detalhes técnicos'],['en','Give me technical details'],['es','Quiero detalles técnicos']]){
  assert.equal(wantsTechnicalAppDetails(userRequest),true);const text=journal(ready,{language,userRequest}).finish('fake');assert.ok(text.includes('public/index.html'));assert.ok(/estática|static|estática/i.test(text));assert.ok(!text.includes('fake'));
 }
 assert.equal(wantsTechnicalAppDetails('Não publique e mostre os detalhes técnicos'),true);
 for(const request of ['Continue a implementação','Sem detalhes técnicos, por favor','No technical details','Sin detalles técnicos'])assert.equal(wantsTechnicalAppDetails(request),false,request);
});
test('user clarification is retained without injecting publication questions from model output',()=>{
 const text=journal({...ready,estado:'interrompido',motivo:'new_user_input',perguntas:['Qual cor você prefere?','Posso publicar agora?']}).finish('fake');assert.ok(text.includes('Qual cor você prefere?'));assert.ok(!text.includes('Posso publicar agora?'));
});
test('explicit technical review and non-app conversations keep their delivery contract',()=>{
 assert.equal(createAppBuildJournal().finish('Conversa comum'),'Conversa comum');const text=appTaskReceipt({...ready,modo:'revisao',parecer:[{assunto:'Referências',avaliacao:'nao_verificado',observacao:'Sem teste funcional.'}]},'pt-BR',{technicalDetails:true});assert.ok(text.includes('Revisão estática'));assert.ok(text.includes('Referências'));
});
test('server supplies the literal current user message to presentation selection',()=>{
 const code=fs.readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');const statement=code.match(/const appBuildJournal = createAppBuildJournal\(([^;]+)\);/)[1];assert.match(statement,/userRequest:message/);const current='Mostre os detalhes técnicos';let got;new Function('createAppBuildJournal','userLang','idiomaResposta','message','confirmedToolLog',`createAppBuildJournal(${statement});`)(x=>{got=x;},'pt-BR','pt-BR',current,[]);assert.equal(got.userRequest,current);assert.equal(got.failedPublication,false);
});

test('a validated edit tells the owner what changed and offers to publish for testing (case from 25/09)', () => {
  const b = { estado:'consistencia_validada', motivo:'completed', validacao:'aprovado', revisao:'a'.repeat(64), arquivos:['public/style.css'],
    objetivo:'Corrigir a tela escura que cobre o painel e impede tocar nos botões. Detalhe técnico que não vai pra mensagem.' };
  const pt = appEditingReply(b);
  assert.match(pt, /^Salvei as alterações para: corrigir a tela escura que cobre o painel e impede tocar nos botões\. /);
  assert.match(pt, /Posso publicar pra você testar\?$/);
  assert.doesNotMatch(pt, /Detalhe técnico/);
  assert.match(appEditingReply(b, 'en'), /May I publish it so you can test\?$/);
  assert.match(appEditingReply(b, 'es'), /¿La publico para que la pruebes\?$/);
  assert.equal(appEditingReply({ ...b, objetivo:'' }), 'As alterações desta etapa estão salvas. Ainda não publiquei essa versão. Quer publicar essa versão ou ajustar mais alguma coisa?');
});
