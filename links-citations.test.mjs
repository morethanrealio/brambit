// Pure text + fake HTTP; real sockets and subprocesses forbidden before imports.
import assert from 'node:assert/strict';
import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
const {conferirLinks,fontesEConferencia,omitBrokenLinks}=await import('./web/links.mjs');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},ok=a=>{assert.ok(a);checks++;};
let requests=[],serial=0;const plans=new Map();
// Plano por URL: número = status; 'throw' = timeout; 'dns'/'refused' = erro de rede
// que prova falha; 'mixed' = um endereço recusou e outro deu timeout;
// {to:url,status} = redirect.
function url(status=200,getStatus=status){const u=`https://links.example.invalid/${++serial}`;plans.set(u,{HEAD:status,GET:getStatus});return u;}
const netErr=(...codes)=>Object.assign(new TypeError('fetch failed'),{cause:codes.length>1
 ?Object.assign(new AggregateError(codes.map(code=>Object.assign(Error(code),{code}))),{code:codes[0]})
 :Object.assign(Error(codes[0]),{code:codes[0]})});
globalThis.fetch=async(u,opts={})=>{
 eq(new URL(u).hostname,'links.example.invalid');ok(plans.has(u));eq(opts.redirect,'manual');ok(['HEAD','GET'].includes(opts.method));
 requests.push([u,opts.method]);const status=plans.get(u)[opts.method];
 if(status==='throw')throw Object.assign(Error('MOCK_TIMEOUT'),{name:'TimeoutError'});
 if(status==='dns')throw netErr('ENOTFOUND');if(status==='refused')throw netErr('ECONNREFUSED');
 if(status==='mixed')throw netErr('ECONNREFUSED','ETIMEDOUT');
 const loc=typeof status==='object'?status.to:null,code=typeof status==='object'?status.status||301:status;
 return {ok:code>=200&&code<300,status:code,headers:{get:k=>k.toLowerCase()==='location'?loc:null},body:{cancel:async()=>{}}};
};
const redirectTo=(target,status=301)=>({to:target,status});
// Falha real repetida no GET: 404/410, 5xx, DNS inexistente, conexão recusada.
for(const status of [404,410,500,503,'dns','refused'])for(const language of ['pt-BR','en','es']){
 const bad=url(status),good=url(),result=await fontesEConferencia(`Seleção:\n• Falhou ${bad}\n  Resumo que não deve ser recomendado.\n• Bom ${good}`,[],{language});
 eq(result.quebrados,[bad]);ok(!result.texto.includes(bad));ok(!result.texto.includes('Resumo que não deve'));ok(result.texto.includes(good));ok(result.texto.includes({'pt-BR':'Removi 1 link',en:'I removed 1 link',es:'Quité 1 enlace'}[language]));
 eq(requests.filter(x=>x[0]===bad),[[bad,'HEAD'],[bad,'GET']]);
 const repeat=await conferirLinks(bad);eq(repeat.quebrados,[bad]);eq(requests.filter(x=>x[0]===bad).length,2);
}
// Falha no HEAD e no GET, mesmo de tipos diferentes, também é falha repetida.
for(const [head,get] of [[404,500],[500,404],['dns',503],[405,405]]){
 const link=url(head,get),r=await fontesEConferencia(`Link ${link}`,[],{});
 if(head===405){eq(r.quebrados,[]);eq(r.indefinidos,[link]);ok(r.texto.includes(link));continue;}
 eq(r.quebrados,[link]);ok(!r.texto.includes(link));
}
// A segunda tentativa desmente ou não confirma: o link fica.
for(const head of [404,410,500,'dns','refused'])for(const get of [200,401,403,429,'throw','mixed']){
 const link=url(head,get),result=await fontesEConferencia(`Link ${link}`,[],{});eq(result.quebrados,[]);ok(result.texto.includes(link));eq(result.indefinidos.length,get===200?0:1);
}
// Sem prova no HEAD: fica no texto com aviso, sem GET.
for(const status of [401,403,429,405,302,'throw','mixed']){
 const link=url(status),result=await fontesEConferencia(`Link ${link}`);eq(result.indefinidos,[link]);eq(result.quebrados,[]);ok(!result.texto.includes('⚠️'));ok(result.texto.includes(link));eq(requests.filter(x=>x[0]===link).length,1);
}
// Redirect é seguido: 200 no fim é link bom; qualquer outra coisa depois de um
// redirect fica sem veredito (não prova página morta).
{
 const final=url(200),link=url(redirectTo(final)),r=await fontesEConferencia(`Link ${link}`);
 eq(r.quebrados,[]);eq(r.indefinidos,[]);ok(r.texto.includes(link));ok(!r.texto.includes('⚠️'));
 eq(requests.filter(x=>x[0]===final),[[final,'HEAD']]);
 const rel=`https://links.example.invalid/${++serial}`;plans.set(rel,{HEAD:redirectTo('/destino-relativo-'+serial,308)});
 plans.set(`https://links.example.invalid/destino-relativo-${serial}`,{HEAD:200});
 eq((await conferirLinks(rel)).indefinidos,[]);
}
for(const status of [404,410,500,403]){
 const final=url(status),link=url(redirectTo(final,302)),r=await fontesEConferencia(`Link ${link}`);
 eq(r.quebrados,[]);eq(r.indefinidos,[link]);ok(r.texto.includes(link));eq(requests.filter(x=>x[0]===link),[[link,'HEAD']]);
}
{
 // Redirect pra rede interna não é seguido; laço de redirect para no teto.
 const before=requests.length;
 const internal=url(redirectTo('http://169.254.169.254/latest/meta-data/')),r=await conferirLinks(internal);
 eq(r.indefinidos,[internal]);eq(requests.slice(before),[[internal,'HEAD']]);
 const loop=`https://links.example.invalid/${++serial}`;plans.set(loop,{HEAD:redirectTo(loop)});
 eq((await conferirLinks(loop)).indefinidos,[loop]);ok(requests.filter(x=>x[0]===loop).length<=6);
}
// Native sources are checked too, and independently respect the eight-link budget.
{
 const bad=url(404),good=url(),r=await fontesEConferencia('Resposta.',[{title:'Bad',uri:bad},{title:'Good',uri:good}],{});
 eq(r.quebrados,[bad]);ok(!r.texto.includes(bad));ok(r.texto.includes(good));eq(r.fontes,2);
}
{
 const links=Array.from({length:11},()=>url());const r=await fontesEConferencia(links.join('\n'));
 eq(r.naoChecados,links.slice(8));eq(requests.filter(x=>links.includes(x[0])).length,8);ok(!r.texto.includes('⚠️'));eq(r.quebrados,[]);
}
// No probing of literal code, local targets, presigned attachments or truncated parentheses.
for(const input of ['`https://code.example.invalid/x`','```\nhttps://code.example.invalid/x\n```','```\nhttps://code.example.invalid/x',
'https://127.0.0.1/x','http://localhost/x','http://10.0.0.1/x','http://192.168.1.1/x','http://172.16.1.1/x',
'https://signed.example.invalid/x?X-Amz-Signature=mock','https://wiki.example.invalid/Foo_(bar)']){
 const count=requests.length;eq(await conferirLinks(input),{quebrados:[],indefinidos:[],naoChecados:[],checados:0,authenticatedSources:[]});eq(requests.length,count);
}
{
 const bad=url(404),good=url();
 for(const original of [`Texto [fonte](${bad}).`,`Uma frase ${bad}, continua.`,`| título | ${bad} |`,`• Dois links ${bad} e ${good}`,`Fonte: <${bad}>`]){
  const result=omitBrokenLinks(original,[bad],'pt-BR');ok(!result.includes(bad));ok(!result.includes('](['));
  if(original.includes(good))ok(result.includes(good));
 }
 const code='```\n'+bad+'\n```';eq(omitBrokenLinks(code,[bad]),code);eq(omitBrokenLinks('`'+bad+'`',[bad]),'`'+bad+'`');
 const intact=`Texto [fonte](${good}).`;eq(omitBrokenLinks(intact,[bad]),intact);
}
// Rotina (strictLinks) não tira mais link sem prova de falha: fica com o aviso.
for (const status of [403,429,302,'throw']) {
 const link=url(status),good=url();
 const r=await fontesEConferencia(`• Item ${link}\n• Bom ${good}`,[],{strictLinks:true});
 eq(r.quebrados,[]);eq(r.indefinidos,[link]);ok(r.texto.includes(link));ok(r.texto.includes(good));ok(!r.texto.includes('⚠️'));ok(!r.texto.includes('link não verificado'));ok(!r.texto.includes('Removi'));
}
{
 const links=Array.from({length:10},()=>url());const r=await fontesEConferencia(links.map(u=>'• '+u).join('\n'),[],{strictLinks:true});
 for(const u of links)ok(r.texto.includes(u));ok(!r.texto.includes('⚠️'));
 const bad=url(404),s=await fontesEConferencia(`• Item ${bad}`,[],{strictLinks:true});eq(s.quebrados,[bad]);ok(!s.texto.includes(bad));
}
// Limpeza final que o server usa (citacoes.mjs), importada de verdade.
const {stripCitationMarkers:strip,limparTextoFinal,registroDeFontes,citarFontes}=await import('./web/citacoes.mjs');
for(const marker of ['[cite: 1]','[cite: 1.1.3]','[cite: 1, 2]','[CITE: 7]']){
 eq(strip('Texto '+marker+'.'),'Texto.');eq(strip('Um '+marker+' texto'),'Um texto');eq(strip(marker+' Texto'),'Texto');
 eq(strip('Texto '+marker+'.\nFontes:\n[1] Fonte https://source.example.invalid/'),'Texto.\nFontes:\n[1] Fonte https://source.example.invalid/');
 const block='```\n'+marker+'\n```';eq(strip(block),block);const unclosed='```\n'+marker;eq(strip(unclosed),unclosed);eq(strip('`'+marker+'`'),'`'+marker+'`');
}
for(const text of ['[1] Sim\n[2] Não','DDD [11] 98888-7777','Intervalo [0, 1]','[1](https://x.invalid)','Código `a[1]`','Lista:\n• [1] Sim','Texto [1].\nFontes:\n[1] Fonte https://source.example.invalid/'])eq(strip(text),text);
eq(strip('Texto [1]. `inline`\nFontes:\n[1] Fonte https://x.invalid/'),'Texto [1]. `inline`\nFontes:\n[1] Fonte https://x.invalid/');
eq(strip('Texto [1].'),'Texto.');eq(strip('Texto [1, 7].'),'Texto.');ok(!strip('Texto default_api:buscar_web:0').includes('default_api'));
// Gate: ordinary non-search conversation keeps explicit literals untouched.
const sanitize=(t,o)=>limparTextoFinal(t,o).trim();
eq(sanitize('Texto [cite: 1].',{comFontes:false}),'Texto [cite: 1].');eq(sanitize('Texto [cite: 1].',{comFontes:true}),'Texto.');
// Tool-call vazado: sai só o pedaço técnico, o texto depois dele fica (29/09/2026).
eq(sanitize('Vou conferir.\n<tool_call>buscar_web\n<arg_key>q</arg_key>\n<arg_value>voo GRU</arg_value>\n</tool_call>\nO voo sai às 10h.'),'Vou conferir.\n\nO voo sai às 10h.');
eq(sanitize('Vou conferir. <tool_call>buscar_web <arg_key>q</arg_key><arg_value>voo</arg_value> O voo sai às 10h.'),'Vou conferir. O voo sai às 10h.');
eq(sanitize('Pronto.\n<tool_call>status_conta\nSeu saldo é 300 créditos.'),'Pronto.\n\nSeu saldo é 300 créditos.');
eq(sanitize('<tool_call>a</tool_call>Texto <tool_call>b<arg_key>k</arg_key><arg_value>v</arg_value></tool_call> final.'),'Texto final.');
eq(sanitize('Sem vazamento aqui.'),'Sem vazamento aqui.');
// Fontes por referência: a lista sai do registro do turno, não do texto do modelo.
{
 const reg=registroDeFontes();const u1='https://a.example.invalid/x',u2='https://b.example.invalid/y';
 eq(reg.add({title:'A',uri:u1}),1);eq(reg.add({title:'B',uri:u2}),2);eq(reg.add({title:'A de novo',uri:u1}),1);eq(reg.add({title:'x',uri:'ftp://z'}),0);
 // [7] não existe no registro: some; a lista traz só o que foi citado, numerada de 1
 eq(citarFontes('Chove [2] e venta [7].',reg),'Chove [1] e venta.\n\nFontes:\n[1] B — '+u2);
 // registro grande (pesquisa a fundo): numera na ordem do texto e lista TODAS as citadas
 const grande=registroDeFontes();for(let i=1;i<=120;i++)grande.add({title:'F'+i,uri:'https://f'+i+'.example.invalid/'});
 const muitas=citarFontes([85,3,114,2,110,7,9,11,13,15,17,19].map(n=>'Fato ['+n+'].').join(' ')+' De novo [85][3].',grande);
 eq(muitas.split('Fontes:')[0].trim(),[1,2,3,4,5,6,7,8,9,10,11,12].map(n=>'Fato ['+n+'].').join(' ')+' De novo [1, 2].');
 eq(muitas.split('\n').filter(l=>/^\[\d+\] F\d+ — /.test(l)).length,12);
 // [n] que os portões não trocam e que existe no registro: numeração do registro fica
 eq(citarFontes('Item [5].\n[3] Sim',grande),'Item [5].\n[3] Sim\n\nFontes:\n[5] F5 — https://f5.example.invalid/');
 // lista do modelo com as mesmas fontes é trocada pela nossa
 eq(citarFontes('Chove [1].\n\nFontes:\n[1] A — '+u1+'\n[2] B — '+u2,reg),'Chove [1].\n\nFontes:\n[1] A — '+u1);
 // lista do modelo com endereço que nenhuma ferramenta mostrou fica como está
 const propria='Chove [1].\n\nFontes:\n[1] Outra — https://c.example.invalid/';eq(citarFontes(propria,reg),propria);
 // menu numerado, DDD e código não são citação
 for(const t of ['[1] Sim\n[2] Não','DDD [11] 98888-7777','Código `a[1]`'])eq(citarFontes(t,reg),t);
 // sem registro, volta ao comportamento antigo
 eq(citarFontes('Texto [1].',registroDeFontes()),'Texto.');
 eq(citarFontes('It rains [1].',reg,{language:'en'}),'It rains [1].\n\nSources:\n[1] A — '+u1);
}
console.log(`OK: ${checks} verificações de links/citações; HTTP falso, sockets/processos bloqueados.`);
