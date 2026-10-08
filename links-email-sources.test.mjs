import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

// Real HTTP is forbidden; every link response below is a local fixture.
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};
net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
const { fontesEConferencia, conferirLinks }=await import('./web/links.mjs');
const { turnSearchCoverage }=await import('./web/turn-search-coverage.mjs');
const { emailSource }=await import('./web/email-evidence.mjs');
const plans=new Map(),requests=[],unexpected=[];
globalThis.fetch=async(url,options)=>{
  requests.push([url,options.method]);
  if (!plans.has(url)) {unexpected.push(url);throw Error('Unplanned URL');}
  assert.equal(options.redirect,'manual');
  assert.ok(['HEAD','GET'].includes(options.method));
  const status=plans.get(url);
  // Redirect to the login screen: following it lands on a 302 with no destination, no verdict.
  if (status==='redirect') return {ok:false,status:302,headers:{get:()=>null},body:{cancel:async()=>{}}};
  return {ok:status>=200 && status<300,status,headers:{get:()=>null},body:{cancel:async()=>{}}};
};
const gmail=id=>`https://mail.google.com/mail/?authuser=work%40example.invalid#all/${id}`;

test('exact links from observed messages skip public HTTP without being marked validated',async()=>{
  const coverage=turnSearchCoverage();
  const messages=[
    emailSource('gmail',{id:'observed-403',account:'work@example.invalid'}),
    emailSource('outlook',{id:'observed-redirect',webLink:'https://outlook.office365.com/owa/?ItemID=observed-redirect&exvsurl=1&viewmodel=ReadMessageItem'}),
  ];
  const tracking='https://tracking.example.invalid/included-in-email';
  messages[0].links=[{url:tracking,label:'Acompanhar'}];
  coverage.observeEmail(messages);
  assert.deepEqual([...coverage.emailSourceLinks()],messages.map(m=>m.link));
  const snapshot=coverage.emailSourceLinks();snapshot.add(tracking);
  assert.equal(coverage.emailSourceLinks().has(tracking),false,'returned Set cannot change turn evidence');
  const original=messages.map(m=>`[Mensagem](${m.link})`).join('\n');
  plans.set(messages[0].link,403);plans.set(messages[1].link,'redirect');
  const before=requests.length;
  const result=await fontesEConferencia(original,[],{mostrarFontes:false,authenticatedEmailSources:coverage.emailSourceLinks()});
  assert.equal(result.texto,original);
  assert.deepEqual(result.authenticatedSources,messages.map(m=>m.link));
  assert.deepEqual(result.indefinidos,[]);assert.deepEqual(result.quebrados,[]);assert.deepEqual(result.naoChecados,[]);
  assert.equal(requests.length,before);
  const checked=await conferirLinks(original,{authenticatedEmailSources:coverage.emailSourceLinks()});
  assert.equal(checked.checados,0,'authenticated source is distinct from a verified public URL');
  assert.deepEqual(checked.authenticatedSources,messages.map(m=>m.link));
});

test('the exception requires a known format and exact equality, without freeing the domain or body link',async()=>{
  const known=gmail('known-only');
  const invented=gmail('invented-404');
  const otherAccount=known.replace('work%40','other%40');
  const tracking='https://tracking.example.invalid/public-404';
  const unknownPath='https://mail.google.com/unknown-path';
  const lookalike='https://mail.google.com.evil.invalid/mail/#all/known-only';
  const candidates=[invented,otherAccount,tracking,unknownPath,lookalike];
  for (const url of candidates)plans.set(url,url===otherAccount ? 403 : 404);
  const result=await fontesEConferencia([known,...candidates].join('\n'),[],{
    authenticatedEmailSources:new Set([known,tracking,unknownPath,lookalike]),
  });
  assert.deepEqual(result.authenticatedSources,[known]);
  assert.deepEqual(result.indefinidos,[otherAccount]);
  assert.deepEqual(result.quebrados,candidates.filter(url=>url!==otherAccount));
  assert.ok(result.texto.includes(known));assert.ok(result.texto.includes('Removi 4 links'));
  for (const url of candidates)assert.deepEqual(requests.filter(([u])=>u===url).map(([,method])=>method),url===otherAccount ? ['HEAD'] : ['HEAD','GET']);
});

test('known Outlook and Gmail read formats accepted only if observed',async()=>{
  const urls=[
    'https://mail.google.com/mail/u/0/#all/observed-browser',
    'https://outlook.office.com/mail/deeplink/read/AAMk%2Bmessage%3D',
    'https://outlook.live.com/mail/0/inbox/id/AAMk%2Bmessage%3D',
  ];
  const before=requests.length;
  const result=await conferirLinks(urls.join('\n'),{authenticatedEmailSources:urls});
  assert.deepEqual(result.authenticatedSources,urls);assert.equal(result.checados,0);assert.equal(requests.length,before);
});

test('authenticated state stays in the turn; unobserved private links remain undefined',async()=>{
  for (const [id,status] of [['new-turn-403',403],['new-turn-redirect','redirect']]) {
    const url=gmail(id);plans.set(url,status);
    const result=await fontesEConferencia(`[Mensagem](${url})`,[],{authenticatedEmailSources:turnSearchCoverage().emailSourceLinks()});
    assert.deepEqual(result.authenticatedSources,[]);assert.deepEqual(result.indefinidos,[url]);
    assert.ok(!result.texto.includes('⚠️'));assert.equal(requests.filter(([u])=>u===url).length,1);
  }
});

test('strict routines keep the public verification requirement, even with an authenticated source',async()=>{
  // Since 2026-09-29 a link without proof of failure stays in the text, with the notice.
  const url=gmail('strict-observed');plans.set(url,403);
  const result=await fontesEConferencia(`• [Mensagem](${url})`,[],{strictLinks:true,authenticatedEmailSources:[url]});
  assert.deepEqual(result.authenticatedSources,[]);assert.deepEqual(result.indefinidos,[url]);
  assert.ok(result.texto.includes(url));assert.ok(!result.texto.includes('⚠️'));assert.ok(!result.texto.includes('link não verificado'));
  assert.equal(requests.filter(([u])=>u===url).length,1);
});

test('authenticated sources do not consume the eight-public-link budget',async()=>{
  const mail=Array.from({length:10},(_,i)=>gmail('budget-'+i));
  const publicUrl='https://tracking.example.invalid/budget-check';plans.set(publicUrl,200);
  const result=await conferirLinks([...mail,publicUrl].join('\n'),{authenticatedEmailSources:mail});
  assert.equal(result.checados,1);assert.deepEqual(result.authenticatedSources,mail);assert.deepEqual(result.naoChecados,[]);
  assert.deepEqual(requests.filter(([u])=>u===publicUrl),[[publicUrl,'HEAD']]);
  assert.deepEqual(unexpected,[]);
});
