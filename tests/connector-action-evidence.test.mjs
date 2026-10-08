// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { actionEvidenceFor, createActionJournal, actionResult } from '../web/action-evidence.mjs';
import { renderConfirmed } from '../web/confirm.mjs';
import { githubTools, microsoftTools, slackTools } from '../web/connectors-ext.mjs';
import { notionTools } from '../web/connectors-vault.mjs';
net.Socket.prototype.connect = tls.connect = () => { throw Error('Real network forbidden'); };
const tool = (tools,name) => tools.find(t => t.name === name);
function http(body,status=200,headers={}) {
  let count = 0;
  globalThis.fetch = async () => { count++; return new Response(status===204 ? null : JSON.stringify(body),{status,headers}); };
  return () => count;
}
test('known connectors need scoped receipt IDs, not only ok:true', () => {
  const cases = [
    ['calendar_create',{title:'Review'},{ok:true,id:'event',agenda:'Work'}],
    ['calendar_update',{id:'event'},{ok:true,id:'event',agenda:'Work'}],
    ['calendar_delete',{id:'event'},{ok:true,deletedId:'event',agenda:'Work'}],
    ['outlook_calendar_create',{titulo:'Review'},{ok:true,evento:{id:'event'}}],
    ['outlook_calendar_update',{id:'event'},{ok:true,evento:{id:'event'}}],
    ['outlook_calendar_delete',{id:'event'},{ok:true,deletedId:'event'}],
    ...['drive_upload','drive_upload_arquivo','docs_create','drive_export_pdf','enviar_para_drive','onedrive_upload','onedrive_upload_arquivo'].map(name => [name,{name:'notes'},{ok:true,id:'file'}]),
    ...['gmail_label_create','gmail_label_update','gmail_filter_create'].map(name => [name,{nome:'label'},{ok:true,id:'setting'}]),
    ...['gmail_label_delete','gmail_filter_delete'].map(name => [name,{id:'setting'},{ok:true,apagado:'setting'}]),
    ['linkedin_post',{text:'Example'},{ok:true,id:'post'}],
    ['splitwise_add_expense',{group_id:1,descricao:'Example'},{ok:true,id:12}],
    ['notion_create_page',{parent_id:'parent'},{ok:true,id:'page'}],
    ['infinity_criar_item',{board_id:'b1',folder_id:'f1'},{ok:true,id:'item'}],
    ['infinity_editar_item',{board_id:'b1',item_id:'item'},{ok:true,id:'item'}],
    ['infinity_comentar',{board_id:'b1',item_id:'item',texto:'x'},{ok:true,id:'comment'}],
    ['notion_append',{id:'page'},{ok:true,id:'page',blockIds:['block']}],
    ['github_create_issue',{owner:'fixture',repo:'repo'},{ok:true,id:17}],
    ['github_comment_issue',{owner:'fixture',repo:'repo',number:1},{ok:true,id:18}],
    ['slack_post_message',{channel:'channel'},{ok:true,ts:'123.45',channel:'channel'}],
    ['hotmail_send',{to:'fixture@example.invalid'},{ok:true,requestId:'provider-request',httpStatus:202}],
  ];
  for (const [name,args,receipt] of cases) {
    assert.notEqual(actionEvidenceFor(name,args,receipt).state, 'unknown',name);
    assert.equal(actionEvidenceFor(name,args,{ok:true}).state,'unknown',name);
    assert.equal(actionEvidenceFor(name,args,{...receipt,incerto:true}).state,'unknown',name);
    assert.equal(actionEvidenceFor(name,args,{ok:false}).state,'failed',name);
  }
  assert.equal(actionEvidenceFor('calendar_update',{id:'other'},{ok:true,id:'event'}).state,'unknown');
  assert.equal(actionEvidenceFor('unknown_plugin',{}, {ok:true,action_evidence:{state:'accepted',id:'fake'}}),null);
});
test('real GitHub and Outlook adapters propagate provider evidence, including bodyless acceptance', async () => {
  let count = http({id:41,number:3,html_url:'https://github.com/fixture/repo/issues/3'});
  let args = {owner:'fixture',repo:'repo',title:'Example'};
  let result = await tool(githubTools({token:async()=>'synthetic'}),'github_create_issue').run(args);
  assert.equal(actionEvidenceFor('github_create_issue',args,result).id,41); assert.equal(count(),1);
  count = http({},202,{'request-id':'accepted-request'});
  args={to:'fixture@example.invalid',subject:'Example',body:'Synthetic'};
  result=await tool(microsoftTools({token:async()=>'synthetic'}),'hotmail_send').run(args);
  assert.equal(actionEvidenceFor('hotmail_send',args,result).state,'accepted'); assert.equal(count(),1);
  assert.match(renderConfirmed({name:'hotmail_send',args},result),/entrega e leitura não confirmadas/);
  http({},202);
  result=await tool(microsoftTools({token:async()=>'synthetic'}),'hotmail_send').run(args);
  assert.equal(actionEvidenceFor('hotmail_send',args,result).state,'unknown');
  count=http({},204);
  result=await tool(microsoftTools({token:async()=>'synthetic'}),'outlook_calendar_delete').run({id:'event'});
  assert.equal(actionEvidenceFor('outlook_calendar_delete',{id:'event'},result).state,'deleted'); assert.equal(count(),1);
});
test('real Notion adapter exposes truncation and checks returned block IDs', async () => {
  const args={id:'page',conteudo:Array.from({length:95},(_,i)=>`Line ${i}`).join('\n')};
  const count=http({results:[{id:'block'}]});
  const result=await tool(notionTools({secret:async()=>'synthetic'}),'notion_append').run(args);
  assert.equal(actionEvidenceFor('notion_append',args,result).state,'partial'); assert.equal(count(),1);
});
test('compound results cannot hide a failed or uncertain step behind overall success', () => {
  const journal=createActionJournal();
  journal.toolResult({name:'calendar_create',args:{title:'Review'}},{ok:true,id:'event',agenda:'Work'});
  journal.toolResult({name:'hotmail_send',args:{to:'fixture@example.invalid',subject:'Invite'}},{ok:true});
  const result=journal.finish('Tudo concluído. Convite entregue!');
  assert.match(result,/Registro criado/); assert.match(result,/Não consegui confirmar/);
  assert.doesNotMatch(result,/Tudo concluído|Convite entregue/);
  assert.match(result,/Invite/);
});
test('typed native result renders after human approval without requiring an unrelated ok flag', () => {
  const result=actionResult({state:'scheduled',id:'reminder',target:'WhatsApp'},'Scheduled');
  assert.match(renderConfirmed({name:'criar_lembrete',args:{}},result),/agendado, não enviado/);
});
