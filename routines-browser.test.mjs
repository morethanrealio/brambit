// Actual SPA in Chromium; every response is fixture/local file, all external requests blocked.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {screenTexts} from './web/screen-texts.mjs';import {translatePage,carregaCatalogos} from './web/page-i18n.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const out=process.env.ROUTINES_TEST_OUTPUT||'/tmp/routines-browser';fs.mkdirSync(out,{recursive:true});
const root=path.resolve('web/public');const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:1000},locale:'pt-BR'});let rows=[],failGet=false,failWrite=false;const writes=[],errors=[];let checks=0;
const check=(value)=>{assert.ok(value);checks++;};page.on('pageerror',e=>errors.push(e.message));
const base={id:'routine-test',agent_id:'agent-test',agent_name:'Assistente Teste',title:'Artigos sobre energia solar',prompt:'Busque artigos recentes. Até três resultados, sem repetir links.',hour:8,days:'[1,4]',tz:'America/Sao_Paulo',channel:'email',enabled:true,config:{curation:{version:2}},repeat_every_min:null,repeat_until:null};rows=[structuredClone(base)];
await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='localhost')return r.abort();if(u.pathname.startsWith('/api/')){
 const method=r.request().method(),data=method==='POST'?r.request().postDataJSON():null;if(method!=='GET')writes.push({path:u.pathname,data});let d={};
 if(u.pathname==='/api/me')d={name:'Pessoa de Teste',timezone:'America/Sao_Paulo',locale:{definido:true,language:'pt-BR'},agents:[{id:'agent-test',name:'Assistente Teste'},{id:'agent-2',name:'Outra Assistente'}],connected:[],providers:[],apps:[]};
 if(u.pathname==='/api/texts/routines')d=screenTexts('routines',u.searchParams.get('lang'));
 if(u.pathname==='/api/routines')d=failGet?{error:'fixture unavailable'}:{routines:rows};
 if(u.pathname==='/api/routine/update'||u.pathname==='/api/routine/delete'){
  if(failWrite)return r.fulfill({status:409,json:{error:'A rotina mudou. Atualize a lista.'}});
  const i=rows.findIndex(x=>x.id===data.id);if(i>=0){if(u.pathname.endsWith('delete'))rows.splice(i,1);else rows[i].enabled=data.enabled;}d={ok:true};
 }
 return r.fulfill({json:d});
 }
 let f=path.resolve(root,'.'+u.pathname);if(!f.startsWith(root+path.sep)||!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(root,'index.html');
 const html=path.extname(f)==='.html';
 await r.fulfill({body:html?translatePage(fs.readFileSync(f,'utf8'),'pt-BR',carregaCatalogos('web/site-textos'),{vars:{brand:'__MARCA__'}}):fs.readFileSync(f),contentType:({'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'})[path.extname(f)]||'application/octet-stream'});
});
const box=page.locator('#routinesBox'),cards=box.locator('article'),rw=()=>writes.filter(w=>w.path.startsWith('/api/routine/'));
async function load(){await page.goto('http://localhost/habilidades-apps');await box.getByRole('button',{name:'Atualizar',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('#routinesBox').getAttribute('aria-busy')==='false');}
async function refresh(){await box.getByRole('button',{name:'Atualizar',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#routinesBox').getAttribute('aria-busy')==='false');}
async function confirm(action){await page.getByRole('dialog').getByRole('button',{name:action,exact:true}).click();await page.waitForFunction(()=>document.querySelector('#routinesBox').getAttribute('aria-busy')==='false');}
try{
 await load();check(await cards.count()===1);check((await box.innerText()).includes('segunda-feira, quinta-feira · 08:00'));check((await box.innerText()).includes('E-mail pela plataforma __MARCA__ (não usa Gmail)'));check(rw().length===0);
 for(const [name,width,height] of [['desktop',1280,1000],['tablet',768,1024],['mobile',390,844]]){
  await page.setViewportSize({width,height});await box.scrollIntoViewIfNeeded();await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  check(await box.locator('button').evaluateAll(bs=>bs.every(b=>b.getBoundingClientRect().height>=43)));
 }
 await cards.getByRole('button',{name:'Pausar:',exact:false}).click();check(await page.getByRole('dialog').isVisible());check(await page.evaluate(()=>document.activeElement.textContent==='Cancelar'));
 await page.keyboard.press('Escape');check(rw().length===0);
 await cards.getByRole('button',{name:'Pausar:',exact:false}).click();await confirm('Pausar');check(rw().length===1&&rw()[0].data.enabled===false);check((await cards.innerText()).includes('Pausada'));check(rw()[0].data.expected.config.curation.version===2);
 await cards.getByRole('button',{name:'Retomar:',exact:false}).click();await confirm('Retomar');check(rows[0].enabled===true);check(!writes.some(w=>/routine\/run/.test(w.path)));
 failWrite=true;await cards.getByRole('button',{name:'Pausar:',exact:false}).click();await confirm('Pausar');check((await box.getByRole('alert').innerText()).includes('mudou'));check(rows[0].enabled);check(await cards.getByRole('button',{name:'Pausar:',exact:false}).isDisabled());failWrite=false;await refresh();
 await cards.getByRole('button',{name:'Excluir:',exact:false}).click();await page.getByRole('dialog').getByRole('button',{name:'Cancelar',exact:true}).click();check(rows.length===1);
 await cards.getByRole('button',{name:'Excluir:',exact:false}).click();await confirm('Excluir');check(rows.length===0);check((await box.innerText()).includes('Você ainda não tem rotinas'));
 failGet=true;await refresh();check(await cards.count()===0);check(await box.getByRole('alert').isVisible());failGet=false;
 rows=[{...base,title:'<img src=x onerror=alert(1)>',prompt:'<script>bad()</script>',days:'invalid'},{...base,id:'expired',enabled:false,title:'Prazo encerrado',repeat_until:'2020-01-01T00:00:00Z'}];await refresh();check(await box.locator('img,script').count()===0);check((await cards.first().innerText()).includes('Cadência a revisar'));check(await cards.nth(1).getByRole('button',{name:'Retomar:',exact:false}).isDisabled());
 rows=[structuredClone(base)];await refresh();await page.setViewportSize({width:1280,height:1000});await box.locator('select').selectOption('agent-2');await box.getByRole('button',{name:'Nova rotina',exact:true}).click();check(page.url().endsWith('/conversas'));check((await page.locator('#taskInput').inputValue()).includes('Quero criar uma rotina'));check(await page.locator('#taskAgent').inputValue()==='agent-2');
 check(!writes.some(w=>/\/api\/(thread|message|routine\/create)/.test(w.path)));
 await page.evaluate(()=>navigate('/habilidades-apps'));await page.waitForFunction(()=>document.querySelector('#routinesBox').getAttribute('aria-busy')==='false');await cards.getByRole('button',{name:'Editar na conversa:',exact:false}).click();await page.locator('#cmodal').waitFor({state:'visible'});check((await page.locator('#cmodal').innerText()).includes('Substituir rascunho?'));await page.locator('#cmodal').getByRole('button',{name:'Cancelar',exact:true}).click();check((await page.locator('#taskInput').inputValue()).includes('Quero criar'));
 await cards.getByRole('button',{name:'Editar na conversa:',exact:false}).click();await page.locator('#cmodal').waitFor({state:'visible'});await page.locator('#cmodal').getByRole('button',{name:'Substituir',exact:true}).click();await page.waitForURL('**/conversas');check((await page.locator('#taskInput').inputValue()).includes('Quero editar'));check(await page.locator('#taskAgent').inputValue()==='agent-test');check(!writes.some(w=>/\/api\/(thread|message|routine\/create)/.test(w.path)));
 rows=[{...base,config:{execution:{status:'failed',phase:'finished',content:{status:'failed'},delivery:{status:'accepted',channel:'email'}}}}];await load();check((await box.innerText()).includes('Conteúdo: falhou'));check((await box.innerText()).includes('Entrega: aceita pela plataforma'));check(!(await box.innerText()).includes('Entrega: falhou'));
 for(const status of ['failed','uncertain']){
  rows=[{...base,config:{execution:{status:'completed',content:{status:'complete'},delivery:{status:'accepted',channel:'email',notification:{channel:'whatsapp',status}}}}}];await load();
  check((await box.innerText()).includes('Entrega: aceita pela plataforma; não confirma leitura (email)'));
  check((await box.innerText()).includes(`Aviso adicional no whatsapp: ${status==='failed'?'falhou':'não confirmado'}`));
  check(await cards.getByRole('button',{name:'Revisar falha na conversa',exact:true}).isVisible());
  if(status==='uncertain'){await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await box.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'secondary-notice-mobile.png'),fullPage:true});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1280,height:1000});}
 }
 rows=[{...base,config:{execution:{status:'uncertain',phase:'delivering',token:'private-runtime-token',startedAt:'2026-09-11T17:00:00Z'}}}];await load();
 check((await box.innerText()).includes('Entrega não confirmada'));check(!(await box.innerText()).includes('private-runtime-token'));
 for(const [name,width,height] of [['health-desktop',1280,1000],['health-tablet',768,1024],['health-mobile',390,844]]){await page.setViewportSize({width,height});await box.scrollIntoViewIfNeeded();await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(width===390){await box.getByRole('button',{name:'Revisar falha na conversa',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'health-mobile-actions.png'),fullPage:true});}}
 await page.setViewportSize({width:1280,height:1000});await box.getByRole('button',{name:'Revisar falha na conversa',exact:true}).click();await page.waitForURL('**/conversas');check((await page.locator('#taskInput').inputValue()).includes('Não repita ações ou envios sem minha confirmação'));
 check(!writes.some(w=>/\/api\/(thread|message|routine\/create|routine\/run)/.test(w.path)));
 check(errors.length===0);console.log(`PASS ${checks} browser checks; isolated full SPA, 3 viewports, confirmation/cancel, errors, drafts, XSS, no auto-send`);
}finally{fs.writeFileSync(path.join(out,'browser-audit.json'),JSON.stringify({checks,errors,writes},null,2));await browser.close();}
