import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {chromium} from 'playwright-core';
import {chromiumPath,chromiumSkipReason} from '../test-support/chromium.mjs';

test('existing agent dropdown in Chromium: select, save, reload, unavailable selection, responsive',{skip:chromiumSkipReason()},async()=>{
 const source=readFileSync('web/public/index.html','utf8');
 const css=source.match(/<style[^>]*>([\s\S]*?)<\/style>/)![1];
 const field=source.match(/<div class="m-field" id="pModelField"[\s\S]*?id="pModelHint"[\s\S]*?<\/div>\s*<\/div>/)![0];
 const start=source.indexOf('  function fillModelField(');const fill=source.slice(start,source.indexOf('\n  }',start)+4);
 const serverSource=readFileSync('web/server.mjs','utf8');
 const a=serverSource.indexOf('function assignableAgentModels(');const assign=serverSource.slice(a,serverSource.indexOf('\n}',a)+2);
 const ctx=vm.createContext({marca:()=>({nome:'Brambit'}),GEMINI_COMPARISON_ID:'gemini37flash',GEMINI_COMPARISON_MODEL:'gemini-3.7-flash',geminiEnabled:()=>true,DEEPSEEK_AGENT_MODEL:'deepseek41flash',deepseekFlashReady:true,kimiAvailable:()=>true});vm.runInContext(assign,ctx);
 let current='auto', saved=0;
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/') {
   res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configurações do assistente, teste sintético</title><style>${css}</style><body><main id="panel-memoria" style="max-width:700px;margin:24px auto;padding:20px"><h1>Configurações do assistente</h1><form id="fixture">${field}<button type="submit">Salvar</button><p id="status" role="status"></p></form></main><script>const $=id=>document.getElementById(id);${fill}
   async function load(){const a=await fetch('/api/agent/get').then(r=>r.json());fillModelField(a.models,a.model);}
   $('pModel').onchange=()=>{$('pModelHint').textContent=$('pModel').selectedOptions[0].dataset.desc||'';};
   $('fixture').onsubmit=async e=>{e.preventDefault();await fetch('/api/agent/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:$('pModel').value})});$('status').textContent='Salvo';};load();</script></body></html>`);
  }
  if(req.url==='/api/agent/get'){ctx.current=current;return res.end(JSON.stringify({model:current,models:vm.runInContext('assignableAgentModels(current)',ctx)}));}
  if(req.url==='/api/agent/update'&&req.method==='POST'){let body='';for await(const c of req)body+=c;current=JSON.parse(body).model;saved++;return res.end('{"ok":true}');}
  res.statusCode=404;res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();if(!addr||typeof addr==='string')throw Error('fixture');
 const dir=process.env.DEEPSEEK_BROWSER_OUTPUT||`${tmpdir()}/deepseek-dropdown-browser`;mkdirSync(dir,{recursive:true});
 const browser=await chromium.launch({executablePath:chromiumPath()!,headless:true,args:['--no-sandbox']}).catch(e=>{server.close();throw e;});
 try {
  const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${addr.port}/`);await page.locator('#pModelField').waitFor({state:'visible'});
  assert.deepEqual(await page.locator('#pModel option').allTextContents(),['Padrão (automático)','DeepSeek V4.1 Flash','Gemini 3.7 Flash','Kimi 3']);
  await page.locator('#pModel').selectOption('deepseek41flash');await page.getByRole('button',{name:'Salvar',exact:true}).click();await page.getByRole('status').filter({hasText:'Salvo'}).waitFor();assert.equal(saved,1);assert.equal(current,'deepseek41flash');
  await page.reload();await page.locator('#pModelField').waitFor({state:'visible'});assert.equal(await page.locator('#pModel').inputValue(),'deepseek41flash');
  assert.match(await page.locator('#pModelHint').innerText(),/tarifa econômica/);
  await page.locator('#pModel').selectOption('gemini37flash');await page.getByRole('button',{name:'Salvar',exact:true}).click();await page.getByRole('status').filter({hasText:'Salvo'}).waitFor();assert.equal(current,'gemini37flash');
  await page.reload();await page.locator('#pModelField').waitFor({state:'visible'});assert.equal(await page.locator('#pModel').inputValue(),'gemini37flash');assert.match(await page.locator('#pModelHint').innerText(),/texto e imagens/);
  ctx.geminiEnabled=()=>false;await page.reload();await page.locator('#pModelField').waitFor({state:'visible'});assert.equal(await page.locator('#pModel').inputValue(),'gemini37flash');
  for(const width of [1280,768,390]) {await page.setViewportSize({width,height:800});await page.screenshot({path:`${dir}/${width}.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);}
  current='deepseek41flash';ctx.deepseekFlashReady=false;await page.reload();await page.locator('#pModelField').waitFor({state:'visible'});assert.equal(await page.locator('#pModel').inputValue(),'deepseek41flash');
  await page.locator('#pModel').selectOption('auto');await page.getByRole('button',{name:'Salvar',exact:true}).click();await page.getByRole('status').filter({hasText:'Salvo'}).waitFor();assert.equal(current,'auto');assert.deepEqual(errors,[]);
  writeFileSync(`${dir}/results.json`,JSON.stringify({synthetic:true,widths:[1280,768,390],saved,errors}));
 }finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
});
