import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailResearchSession } from './web/email-research-session.mjs';

const account = 'owner@example.invalid';
const tool = (name,run) => ({name,description:'Synthetic fixture',parameters:{type:'object'},run});
const invoke = (session,name,args={}) => session.tools.find(item=>item.name===name).run(args);
const extraction = refs => JSON.stringify({achados:[{fact:'FREE MODEL FACT',entity:'FREE MODEL ENTITY',refs}],gaps:['FREE MODEL GAP']});
function fixtureSession(tools,options={}) {
  const observed=[];
  const session=createEmailResearchSession(tools,{account,onEvidence:bundle=>observed.push(bundle),...options});
  return {session,observed,finish:(text='{}',coverage=[])=>{
    const result=session.finish(text,coverage); return {text:result,bundle:observed.at(-1)};
  }};
}
const read = id => ({id,account,subject:'Pedido 123',from:'loja@example.invalid',date:'2026-09-11',
  body:'Pedido 123 foi enviado. Entrega prevista em 17 de setembro.',truncated:false,
  link:`https://mail.google.com/mail/?authuser=${account}#all/${id}`,
  links:[{url:'https://example.invalid/track/123',label:'Rastrear'}],links_truncated:false,
});
const page = messages => ({messages,has_more:false,next_cursor:null});

test('read followed by another search preserves body, links, truncation and attachment metadata', async () => {
  const f=fixtureSession([
    tool('gmail_read',async()=>JSON.stringify({...read('a'),truncated:true,
      attachments:[{attachmentId:'att',filename:'fatura.txt',mimeType:'text/plain',size:20}]})),
    tool('gmail_search',async()=>JSON.stringify(page([{id:'a',account,subject:'Pedido 123',snippet:'Uma prévia',
      truncated:false,links:[],attachments:[]}]))),
  ]);
  await invoke(f.session,'gmail_read',{id:'a'});
  await invoke(f.session,'gmail_search',{query:'Pedido 123'});
  const row=f.session.rows()[0];
  assert.equal(row.body,read('a').body);
  assert.equal(row.truncated,true);
  assert.equal(row.links[0].url,'https://example.invalid/track/123');
  assert.equal(row.attachments[0].attachmentId,'att');
  const {bundle}=f.finish();
  assert.equal(bundle.fallback_sources[0].fields[0].truncated,true);
  assert.equal(bundle.sources[0].attachments[0].filename,'fatura.txt');
});

test('preview followed by a read upgrades the body rather than treating preview as full evidence', async () => {
  const f=fixtureSession([
    tool('gmail_search',async()=>page([{id:'a',account,snippet:'Uma prévia',subject:'Pedido 123'}])),
    tool('gmail_read',async()=>read('a')),
  ]);
  await invoke(f.session,'gmail_search',{query:'Pedido 123'});
  await invoke(f.session,'gmail_read',{id:'a'});
  const {bundle}=f.finish(extraction([{id:'a',field:'body',quote:'Pedido 123 foi enviado.'}]));
  assert.equal(bundle.trechos_verificados[0].quote,'Pedido 123 foi enviado.');
  assert.equal(bundle.sources[0].body_observed,true);
  assert.equal(bundle.sources[0].truncated,false);
});

test('invalid citations preserve good citations and raw sources, independent of the model conclusion', async () => {
  const f=fixtureSession([tool('gmail_read',async()=>read('a'))]);
  await invoke(f.session,'gmail_read',{id:'a'});
  const {text,bundle}=f.finish(extraction([
    {id:'a',field:'body',quote:'Pedido 123 foi enviado.'},
    {id:'a',field:'body',quote:'Pedido recebido pelo comprador.'},
  ]));
  assert.equal(bundle.consulta.status,'sucesso_com_resultados');
  assert.equal(bundle.extraction.refs_rejected,1);
  assert.equal(bundle.trechos_verificados.length,1);
  assert.equal(bundle.fallback_sources[0].fields[0].text,read('a').body);
  assert.doesNotMatch(text,/FREE MODEL/);
  const malformed=f.finish('Não encontrei nenhum e-mail.');
  assert.equal(malformed.bundle.consulta.status,'sucesso_com_resultados');
  assert.doesNotMatch(malformed.text,/Não encontrei nenhum e-mail/);
  assert.equal(malformed.bundle.fallback_sources.length,1);
});

test('attachment reads retain message identity, file metadata and independent truncation', async () => {
  const f=fixtureSession([
    tool('gmail_read',async()=>({...read('a'),attachments:[{attachmentId:'one',filename:'original.pdf',mimeType:'application/pdf'}]})),
    tool('gmail_read_attachment',async args=>({name:args.attachmentId+'.txt',mimeType:'text/plain',
      text:args.attachmentId==='one'?'Fatura um: R$ 487,90.':'Fatura dois: R$ 200,00.',truncated:args.attachmentId==='one'})),
    tool('gmail_search',async()=>page([{id:'a',account,snippet:'Depois da leitura'}])),
  ]);
  await invoke(f.session,'gmail_read',{id:'a'});
  await invoke(f.session,'gmail_read_attachment',{id:'a',attachmentId:'one'});
  await invoke(f.session,'gmail_read_attachment',{id:'a',attachmentId:'two'});
  await invoke(f.session,'gmail_search',{query:'fatura'});
  const {bundle}=f.finish(extraction([{id:'a',field:'attachmentText',attachmentId:'one',quote:'Fatura um: R$ 487,90.'}]));
  assert.equal(bundle.sources[0].truncated,false);
  assert.equal(bundle.sources[0].attachment_truncated,true);
  assert.equal(bundle.trechos_verificados[0].source_truncated,true);
  assert.equal(bundle.sources[0].attachments.length,2);
  assert.equal(bundle.sources[0].attachments[0].filename,'one.txt');
  assert.equal(bundle.sources[0].attachments[0].read,true);
  assert.equal(bundle.consulta.partial,true);
  const raw=f.finish('{bad JSON').bundle;
  const fields=raw.fallback_sources[0].fields;
  assert.equal(fields.find(field=>field.field==='body').truncated,false);
  assert.equal(fields.find(field=>field.field==='attachmentText').truncated,true);
  assert.equal(f.session.rows()[0].attachmentText,undefined);
  assert.deepEqual(f.session.rows()[0].attachments.map(attachment=>[attachment.attachmentId,attachment.text]),[
    ['one','Fatura um: R$ 487,90.'],['two','Fatura dois: R$ 200,00.'],
  ]);
});

test('binary attachment observation retains the IDs required to deliver a file', async () => {
  const f=fixtureSession([tool('gmail_read_attachment',async()=>({name:'photo.bin',mimeType:'application/octet-stream',
    size:123,note:'Formato binário; conteúdo não lido.'}))]);
  await invoke(f.session,'gmail_read_attachment',{id:'a',attachmentId:'binary'});
  const {bundle}=f.finish();
  assert.equal(bundle.sources[0].id,'a');
  assert.equal(bundle.sources[0].attachments[0].attachmentId,'binary');
  assert.equal(bundle.sources[0].attachments[0].filename,'photo.bin');
  assert.equal(bundle.sources[0].attachments[0].text_observed,false);
  assert.equal(bundle.sources[0].attachment_observed,false);
  assert.equal(bundle.fallback_sources.length,0);
});

test('an attachment cannot overwrite a different message or cross account boundaries', async () => {
  for (const response of [
    {text:'FOREIGN SECRET',account:'other@example.invalid'},
    {text:'FOREIGN SECRET',messageId:'not-requested'},
  ]) {
    const f=fixtureSession([tool('gmail_read_attachment',async()=>response)]);
    await assert.rejects(()=>invoke(f.session,'gmail_read_attachment',{id:'a',attachmentId:'att'}),/outra conta|outra mensagem/);
    const {text,bundle}=f.finish();
    assert.equal(bundle.sources.length,0);
    assert.equal(bundle.consulta.status,'falha_na_consulta');
    assert.doesNotMatch(text,/FOREIGN SECRET|other@example/);
  }
});

test('foreign account in any row rejects the whole tool result without caching it', async () => {
  let calls=0;
  const f=fixtureSession([tool('gmail_search',async()=>{
    calls++;
    return page([{id:'good',account,snippet:'Ours'},
      {id:'foreign',account:'other@example.invalid',snippet:'FOREIGN SECRET'}]);
  })]);
  for(let repeat=0;repeat<2;repeat++) await assert.rejects(()=>invoke(f.session,'gmail_search',{query:'test'}),/outra conta/);
  assert.equal(calls,2);
  assert.deepEqual(f.session.rows(),[]);
  assert.doesNotMatch(f.finish().text,/FOREIGN SECRET|other@example/);
});

test('account normalization accepts case and spaces; read message ID mismatch is rejected', async () => {
  const f=fixtureSession([tool('gmail_read',async args=>({...read(args.id==='good'?'good':'different'),account:' OWNER@EXAMPLE.INVALID '}))]);
  await invoke(f.session,'gmail_read',{id:'good'});
  await assert.rejects(()=>invoke(f.session,'gmail_read',{id:'bad'}),/outra mensagem/);
  const {bundle}=f.finish();
  assert.equal(bundle.sources.length,1);
  assert.equal(bundle.sources[0].account,account);
  assert.equal(bundle.consulta.status,'falha_na_consulta');
});

test('non-email calls preserve legacy output and are not cached', async () => {
  let calls=0;
  const f=fixtureSession([tool('calendar_list',async()=>({events:[],calls:++calls}))]);
  await invoke(f.session,'calendar_list',{day:'2026-09-24'});
  await invoke(f.session,'calendar_list',{day:'2026-09-24'});
  assert.equal(calls,2);
  assert.equal(f.session.isEmailOnly(),false);
  assert.equal(f.session.finish('A reunião é às 10h.'),'A reunião é às 10h.');
  assert.equal(f.observed.length,0);
});

test('mixed email and other tools remain identified as mixed for the legacy caller path', async () => {
  const f=fixtureSession([tool('gmail_read',async()=>read('a')),tool('drive_read',async()=>({body:'Document'}))]);
  await invoke(f.session,'gmail_read',{id:'a'});
  assert.equal(f.session.isEmailOnly(),true);
  await invoke(f.session,'drive_read',{id:'doc'});
  assert.equal(f.session.isEmailOnly(),false);
  assert.match(f.session.finish('Resultado dos dois serviços.'),/^Resultado dos dois serviços\./);
});

test('cache is per session/account and deduplicates concurrent calls with equivalent argument order', async () => {
  let calls=0;
  const shared=tool('gmail_search',async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,1));return page([]);});
  const first=fixtureSession([shared]), second=fixtureSession([shared],{account:'second@example.invalid'});
  await Promise.all([
    invoke(first.session,'gmail_search',{query:'test',max:5}),
    invoke(first.session,'gmail_search',{max:5,query:'test'}),
  ]);
  assert.equal(calls,1);
  await invoke(first.session,'gmail_search',{query:'test',max:5});
  assert.equal(calls,1);
  await invoke(second.session,'gmail_search',{query:'test',max:5});
  assert.equal(calls,2);
});

test('failures and malformed results do not become cached empty successes; retry may recover', async () => {
  for (const failure of [new Error('fixture failure'),'{bad JSON',{error:'fixture failure'},null,{ok:false},{messages:'bad'}]) {
    let calls=0;
    const f=fixtureSession([tool('gmail_search',async()=>{
      calls++;
      if(calls===1) {if(failure instanceof Error)throw failure;return failure;}
      return page([]);
    })]);
    try { await invoke(f.session,'gmail_search',{query:'test'}); } catch {}
    assert.equal(f.finish().bundle.consulta.status,'falha_na_consulta');
    await invoke(f.session,'gmail_search',{query:'test'});
    const {bundle}=f.finish('{}',[{tool:'gmail_search',account,status:'complete'}]);
    assert.equal(calls,2);
    assert.equal(bundle.consulta.status,'sucesso_sem_resultados');
    assert.equal(bundle.consulta.partial,false);
    assert.equal(bundle.extraction.search_absence_established,false);
  }
});

test('Outlook without explicit account retains Portuguese aliases, sources, body and links', async () => {
  const f=fixtureSession([
    tool('hotmail_search',async()=>JSON.stringify(page([{id:'ms',assunto:'Reunião alterada',de:'hotel@example.invalid',
      data:'2026-09-22',previa:'Nova sala e horário',link:'https://outlook.office.com/mail/id/ms'}]))),
    tool('hotmail_read',async()=>JSON.stringify({id:'ms',assunto:'Reunião alterada',de:'hotel@example.invalid',data:'2026-09-22',
      corpo:'Sua reunião será na sala Jatobá, às 10h.',truncated:false,link:'https://outlook.office.com/mail/id/ms',
      links:[{url:'https://example.invalid/reservation',label:'Reserva'}]})),
  ],{account:undefined});
  await invoke(f.session,'hotmail_search',{q:'reunião'});
  await invoke(f.session,'hotmail_read',{id:'ms'});
  const {bundle}=f.finish(extraction([{id:'ms',field:'body',quote:'Sua reunião será na sala Jatobá, às 10h.'}]));
  assert.equal(bundle.conta,'Outlook');
  assert.equal(bundle.sources[0].subject,'Reunião alterada');
  assert.equal(bundle.sources[0].from,'hotel@example.invalid');
  assert.equal(bundle.sources[0].date,'2026-09-22');
  assert.equal(bundle.sources[0].body_observed,true);
  assert.equal(bundle.available_links.length,1);
  assert.equal(bundle.trechos_verificados.length,1);
  assert.equal(bundle.consulta.status,'sucesso_com_resultados');
});

test('implicit account binds to the authenticated result and never accepts a later different account', async () => {
  const f=fixtureSession([tool('gmail_read',async args=>({...read(args.id),account:args.id==='a'?account:'other@example.invalid'}))],
    {account:undefined});
  await invoke(f.session,'gmail_read',{id:'a'});
  assert.equal(f.finish().bundle.conta,account);
  await assert.rejects(()=>invoke(f.session,'gmail_read',{id:'b'}),/outra conta/);
  assert.equal(f.session.rows().length,1);
});

test('onEvidence receives the same structured handoff exactly once before rendering', async () => {
  const f=fixtureSession([tool('gmail_search',async()=>page([]))]);
  await invoke(f.session,'gmail_search',{query:'missing'});
  const coverage=[{tool:'gmail_search',account,status:'complete',query:'missing',returned:0}];
  const {text,bundle}=f.finish('{"achados":[]}',coverage);
  assert.equal(f.observed.length,1);
  assert.equal(bundle.consulta.status,'sucesso_sem_resultados');
  assert.deepEqual(bundle.consultas,coverage);
  assert.ok(text.includes(JSON.stringify(bundle)));
});

test('handoff clipping is reported as partial even when the underlying email was fully read', async () => {
  const f=fixtureSession([tool('gmail_read',async()=>({...read('a'),body:'A'.repeat(7000)}))]);
  await invoke(f.session,'gmail_read',{id:'a'});
  const {bundle}=f.finish('{}',[{tool:'gmail_read',account,status:'complete'}]);
  assert.equal(bundle.sources[0].truncated,false);
  assert.equal(bundle.extraction.output_truncated,true);
  assert.equal(bundle.consulta.partial,true);
});

test('truncated or partial bodies bypass cache and a later complete read clears the source limitation', async () => {
  for (const incomplete of [{truncated:true},{partial:true},{body:'   '},{note:'Não foi possível ler tudo.'}]) {
    let calls=0;
    const f=fixtureSession([tool('gmail_read',async()=>++calls===1?{...read('a'),...incomplete}:read('a'))]);
    await invoke(f.session,'gmail_read',{id:'a'});
    assert.equal(f.finish().bundle.consulta.partial,true);
    await invoke(f.session,'gmail_read',{id:'a'});
    const {bundle}=f.finish();
    assert.equal(calls,2);
    assert.equal(bundle.sources[0].truncated,false);
    assert.equal(bundle.consulta.partial,false);
    await invoke(f.session,'gmail_read',{id:'a'});
    assert.equal(calls,2,'complete read is cached');
  }
});

test('partial, empty or noted attachments remain incomplete and can recover on reread', async () => {
  for (const incomplete of [
    {text:'Fatura parcial: R$ 48',partial:true},
    {text:'Fatura parcial: R$ 48',truncated:true},
    {text:'  \n '},
    {note:'OCR indisponível.'},
    {text:'Fatura parcial: R$ 48',note:'Uma página não pôde ser lida.'},
  ]) {
    let calls=0;
    const f=fixtureSession([tool('gmail_read_attachment',async()=>++calls===1?incomplete:
      {name:'fatura.txt',mimeType:'text/plain',text:'Fatura completa: R$ 487,90.'})]);
    await invoke(f.session,'gmail_read_attachment',{id:'a',attachmentId:'att'});
    const partial=f.finish().bundle;
    assert.equal(partial.consulta.partial,true);
    assert.equal(partial.sources[0].attachment_truncated,true);
    assert.equal(partial.sources[0].attachments[0].truncated,true);
    assert.equal(partial.sources[0].attachments[0].text_observed,typeof incomplete.text==='string'&&!!incomplete.text.trim());
    await invoke(f.session,'gmail_read_attachment',{id:'a',attachmentId:'att'});
    const complete=f.finish().bundle;
    assert.equal(calls,2);
    assert.equal(complete.consulta.partial,false);
    assert.equal(complete.sources[0].attachment_truncated,false);
    assert.equal(complete.sources[0].attachments[0].truncated,false);
    assert.equal(complete.sources[0].attachments[0].note,'');
    assert.equal(complete.fallback_sources[0].fields[0].text,'Fatura completa: R$ 487,90.');
    await invoke(f.session,'gmail_read_attachment',{id:'a',attachmentId:'att'});
    assert.equal(calls,2,'complete attachment read is cached');
  }
});

test('incomplete search results are not cached as a completed observation', async () => {
  let calls=0;
  const f=fixtureSession([tool('gmail_search',async()=>++calls===1?
    {messages:[],has_more:false,incomplete_search:true}:page([]))]);
  await invoke(f.session,'gmail_search',{query:'fatura'});
  await invoke(f.session,'gmail_search',{query:'fatura'});
  await invoke(f.session,'gmail_search',{query:'fatura'});
  assert.equal(calls,2);
});

test('a single valid invoice quote still hands off every observed invoice from the same email', async () => {
  const body='Fatura 101: R$ 100. Fatura 102: R$ 200.';
  const f=fixtureSession([tool('gmail_read',async()=>({...read('a'),body}))]);
  await invoke(f.session,'gmail_read',{id:'a'});
  const {bundle}=f.finish(extraction([{id:'a',field:'body',quote:'Fatura 101: R$ 100.'}]),[{tool:'gmail_read',status:'complete'}]);
  assert.equal(bundle.trechos_verificados.length,1);
  assert.equal(bundle.fallback_sources[0].fields.find(field=>field.field==='body').text,body);
  assert.equal(bundle.consulta.partial,false);
});

test('actual Outlook recipient aliases survive the handoff for questions about recipients and CC', async () => {
  const f=fixtureSession([tool('hotmail_read',async()=>({id:'ms',assunto:'Projeto',de:'sender@example.invalid',
    para:['recipient@example.invalid'],cc:['copied@example.invalid'],data:'2026-09-22',corpo:'Segue o documento.',truncated:false}))],
    {account:undefined});
  await invoke(f.session,'hotmail_read',{id:'ms'});
  const {bundle}=f.finish();
  assert.deepEqual(bundle.sources[0].to,['recipient@example.invalid']);
  assert.deepEqual(bundle.sources[0].cc,['copied@example.invalid']);
  assert.equal(bundle.sources[0].recipients_truncated,false);
  assert.equal(bundle.consulta.partial,false);
});

test('two generically worded attachments retain filename/value association in reverse read order', async () => {
  const f=fixtureSession([
    tool('gmail_read',async()=>({...read('a'),attachments:[
      {attachmentId:'alpha',filename:'Projeto Alpha.pdf'},{attachmentId:'beta',filename:'Projeto Beta.pdf'},
    ]})),
    tool('gmail_read_attachment',async args=>({text:args.attachmentId==='alpha'?'Valor: R$ 100.':'Valor: R$ 200.'})),
  ]);
  await invoke(f.session,'gmail_read',{id:'a'});
  await invoke(f.session,'gmail_read_attachment',{id:'a',attachmentId:'beta'});
  assert.equal(f.session.rows()[0].attachmentText,undefined,'known second attachment prevents unlabeled legacy text');
  await invoke(f.session,'gmail_read_attachment',{id:'a',attachmentId:'alpha'});
  const {bundle}=f.finish(extraction([{id:'a',field:'attachmentText',quote:'Valor: R$ 100.'}]));
  assert.equal(bundle.trechos_verificados.length,0);
  assert.equal(bundle.extraction.rejected[0].reason,'ambiguous_attachment');
  assert.deepEqual(bundle.fallback_sources[0].fields.filter(field=>field.field==='attachmentText')
    .map(field=>[field.attachmentId,field.filename,field.text]),[
    ['alpha','Projeto Alpha.pdf','Valor: R$ 100.'],['beta','Projeto Beta.pdf','Valor: R$ 200.'],
  ]);
  assert.equal(bundle.consulta.partial,false,'all observed content reaches the author despite the rejected quote');
});
