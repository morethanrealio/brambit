import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { readGmailBody, extractGmailBody } from './web/gmail-payload.mjs';
import { normalizeEmailBody, limitEmailBody, EMAIL_BODY_INPUT_LIMIT } from './web/email-body.mjs';
import { trackEmailPagination } from './web/email-pagination.mjs';
import { executeEmailSearch, emailSearchPromptBlock } from './web/email-search-runtime.mjs';
net.Socket.prototype.connect=tls.connect=()=>{throw Error('Rede real proibida');};
const { googleTools }=await import('./web/connectors.mjs');
const { microsoftTools }=await import('./web/connectors-ext.mjs');
const part=(mime,text,extra={})=>({mimeType:mime,body:{data:Buffer.from(text).toString('base64url')},...extra});
const orderUrl='https://shop.example.invalid/account#/orders?campaign=shipping&order=synthetic';
const html=`<html><head><style>${'.layout{color:red;margin:0}'.repeat(900)}</style></head><body>
<a href="${orderUrl.replace('&','&amp;')}"><img src="https://images.example.invalid/button.png" alt="Acompanhe seu pedido"></a>
<table><tr><td>Prazo de entrega:</td><td>at&eacute; 17/09/2026</td></tr></table>
<p>Pedido despachado para a transportadora.</p><script>UNTRUSTED_SCRIPT_SHOULD_DISAPPEAR</script></body></html>`;
const find=(tools,name)=>tools.find(t=>t.name===name);

test('long template: deadline and button survive; CSS, scripts and the image URL don\'t become body text',()=>{
  assert.ok(html.indexOf('17/09/2026')>9000);
  const read=readGmailBody(part('text/html',html));
  assert.ok(read.body.includes('até 17/09/2026'));assert.ok(read.body.includes('Acompanhe seu pedido'));
  assert.ok(!read.body.includes(orderUrl));assert.equal(read.truncated,false);assert.ok(read.chars<1000);
  assert.ok(!read.body.includes('.layout'));assert.ok(!read.body.includes('UNTRUSTED_SCRIPT'));assert.ok(!read.body.includes('button.png'));
  assert.deepEqual(read.links,[{label:'Acompanhe seu pedido',url:orderUrl}]);
});

test('MIME: prefers plain text even after HTML, but keeps the alternative\'s buttons',()=>{
  const read=readGmailBody({mimeType:'multipart/alternative',parts:[part('text/html',html),part('text/plain','Texto simples do pedido.')]});
  assert.equal(read.body,'Texto simples do pedido.');assert.equal(read.links[0].url,orderUrl);
  assert.equal(read.truncated,false);
  assert.equal(readGmailBody({mimeType:'multipart/alternative',parts:[part('text/plain','  '),part('text/html','<p>Corpo real</p>')]}).body,'Corpo real');
});

test('body charset preserves accents in legacy messages',()=>{
  const payload={mimeType:'text/plain',headers:[{name:'Content-Type',value:'text/plain; charset=iso-8859-1'}],body:{data:Buffer.from('Entrega até amanhã.','latin1').toString('base64url')}};
  assert.equal(readGmailBody(payload).body,'Entrega até amanhã.');
});

test('attachments don\'t replace the body, mixed parts are preserved and missing content is partial',()=>{
  const payload={mimeType:'multipart/mixed',parts:[
    part('text/plain','Segredo do anexo',{filename:'anexo.txt'}),
    {mimeType:'multipart/alternative',parts:[part('text/html','<p>Primeiro</p>'),part('text/plain','Primeiro')]},
    part('text/plain','Segundo'),
    {mimeType:'message/rfc822',parts:[part('text/plain','Mensagem anexada')]},
  ]};
  assert.equal(extractGmailBody(payload),'Primeiro\n\nSegundo');
  const missing=readGmailBody({mimeType:'text/html',body:{attachmentId:'unloaded'}});
  assert.equal(missing.body,'');assert.equal(missing.truncated,true);
});

test('cut happens only after normalization; a truly large text and the parser\'s limits stay declared',()=>{
  const read=readGmailBody(part('text/plain','a'.repeat(7000)));
  assert.equal(read.body.length,6000);assert.equal(read.chars,7000);assert.equal(read.truncated,true);
  const capped=limitEmailBody(normalizeEmailBody('<p>'+'a'.repeat(EMAIL_BODY_INPUT_LIMIT)+'</p>','html'));
  assert.equal(capped.truncated,true);
  const deep=limitEmailBody(normalizeEmailBody('<div>'.repeat(200)+'inside'+'</div>'.repeat(200),'html'));
  assert.equal(deep.truncated,true);
});

test('links come from the content, without inventing a domain or following images; entities and fragments are preserved',()=>{
  const read=limitEmailBody(normalizeEmailBody(`<p>Confirma&ccedil;&atilde;o &#x2713;</p>
    <a href="javascript:alert(1)">Ruim</a><a href="data:text/plain,x">Dado</a>
    <a href="/orders">Relativo</a><a href="https://user:password@example.invalid/">Credencial</a>
    <a href="https://shop.example.invalid/order?a=1&amp;b=2#status">Rastrear</a>
    <a href="https://shop.example.invalid/order?a=1&amp;b=2#status">Rastrear novamente</a>`, 'HTML'));
  assert.ok(read.body.includes('Confirmação ✓'));assert.equal(read.links.length,1);
  assert.equal(read.links[0].url,'https://shop.example.invalid/order?a=1&b=2#status');
  assert.ok(!read.body.includes('javascript:'));assert.ok(!read.body.includes('password'));
});

test('useful links aren\'t lost among footer links; the links list cut is explicit',()=>{
  const h=Array.from({length:25},(_,i)=>`<a href="https://shop.example.invalid/footer/${i}">Rodapé</a>`).join('')+`<a href="${orderUrl}">Acompanhe seu pedido</a>`;
  const read=limitEmailBody(normalizeEmailBody(h,'html'));
  assert.equal(read.links.length,20);assert.equal(read.links[0].url,orderUrl);assert.equal(read.links_truncated,true);
});

test('real Gmail connector with a simulated API: the deadline reaches the worker and the link reaches the main thread',async()=>{
  const urls=[];
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.method || 'GET','GET');urls.push(String(url));
    return {ok:true,json:async()=>({id:'synthetic',payload:part('text/html',html)})};
  };
  const tracked=trackEmailPagination(googleTools({token:async()=> 'fixture',account:'work@example.invalid',caps:{gmail:{read:true}}}));
  const read=JSON.parse(await find(tracked.tools,'gmail_read').run({id:'synthetic'}));
  assert.equal(urls.length,1);assert.ok(urls[0].includes('gmail.googleapis.com'));
  assert.ok(read.body.includes('17/09/2026'));assert.equal(tracked.hasPartial(),false);
  const synthesis=tracked.finish('Prazo informado: 17/09.');
  assert.ok(synthesis.includes(orderUrl));assert.ok(synthesis.includes('Acompanhe seu pedido'));
  assert.ok(synthesis.includes('não páginas consultadas'));assert.equal(tracked.evidence()[0].account,'work@example.invalid');
});

test('Outlook shares normalization without losing the email\'s webLink',async()=>{
  globalThis.fetch=async()=>({ok:true,json:async()=>({id:'ms',webLink:'https://outlook.office.com/mail/id/ms',body:{contentType:'HTML',content:html}})});
  const m=JSON.parse(await find(microsoftTools({token:async()=> 'fixture'}),'hotmail_read').run({id:'ms'}));
  assert.ok(m.corpo.includes('17/09/2026'));assert.equal(m.truncated,false);
  assert.equal(m.links[0].url,orderUrl);assert.equal(m.link,'https://outlook.office.com/mail/id/ms');
});

test('a typed routine uses normalized text and flags the body cut separately from the list',async()=>{
  const fetchImpl=async url=>({ok:true,json:async()=>String(url).includes('/messages?')
    ? {messages:[{id:'fixture'}]} : {id:'fixture',payload:part('text/html',html)}});
  const c={provider:'gmail',terms:['Loja'],days:7};
  const r=await executeEmailSearch(c,{fetchImpl,token:async()=> 'fixture'});
  assert.equal(r.partial,false);assert.ok(r.items[0].body.includes('17/09/2026'));
  assert.ok(emailSearchPromptBlock(c,r).includes(orderUrl));
  const cut=await executeEmailSearch(c,{fetchImpl,token:async()=> 'fixture',bodyChars:10});
  assert.equal(cut.truncated,false);assert.equal(cut.partial,true);assert.equal(cut.items[0].truncated,true);
  assert.ok(emailSearchPromptBlock(c,cut).includes('Partial read:'));
});
