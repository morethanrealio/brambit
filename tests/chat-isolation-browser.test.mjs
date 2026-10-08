import {chromiumPath,browserAvailableOrSkip} from '../test-support/chromium.mjs';
import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync('web/public/index.html','utf8');
// Execute the real application functions and DOM, omitting automatic login/boot.
const html=source.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/g,(all,open,body,close)=>body.includes('// ── Boot ──')?open+body.slice(0,body.indexOf('// ── Boot ──'))+'\nwindow.fixtureReady=true;'+close:all);
// Skips (with reason) when no local Chromium exists; see test-support/chromium.mjs.
if(browserAvailableOrSkip('tests/chat-isolation-browser.test.mjs')){
const browser=await chromium.launch({executablePath:chromiumPath(),headless:true});
try{for(const width of [390,1280]){
 const page=await browser.newPage({viewport:{width,height:900}}),errors=[],posts=[],reads=[],gets=[];let createCount=0,createResolve,createFail=false;
 const answers=new Map();page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:html});
  if(url.pathname==='/page-texts.js')return route.fulfill({contentType:'text/javascript',body:readFileSync('web/public/page-texts.js','utf8')});
  if(url.pathname==='/api/chat'){
   const body=req.postDataJSON();posts.push(body);const result=await new Promise(r=>answers.set(body.message,r));return result.netFail?route.abort('failed'):route.fulfill({json:result});
  }
  if(url.pathname==='/api/thread/read'){reads.push(req.postDataJSON().id);return route.fulfill({json:{ok:true}});}
  if(url.pathname==='/api/thread'&&req.method()==='POST'){
   createCount++;await new Promise(r=>createResolve=r);return route.fulfill({json:createFail?{error:'Synthetic create failure'}:{id:'created-'+createCount,agentName:'Teste'}});
  }
  if(url.pathname==='/api/thread'){gets.push(url.searchParams.get('id'));return route.fulfill({json:{id:url.searchParams.get('id'),messages:[]}});}
  return route.fulfill({json:{}});
 });
 await page.goto('https://fixture.invalid/fixture');await page.waitForFunction(()=>window.fixtureReady);
 await page.evaluate(()=>{showApp(true);reveal();loadCredits=()=>{};loadHomeItems=()=>{};openChatThread('A','A','Assistant A',[]);});
 async function waitPost(message){for(let i=0;i<100&&!answers.has(message);i++)await page.waitForTimeout(10);assert(answers.has(message),message);}
 await page.evaluate(()=>{window.first=sendThread('from-A');});await waitPost('from-A');
 await page.evaluate(()=>openChatThread('B','B','Assistant B',[]));answers.get('from-A')({reply:'answer-A',attachments:[{type:'doc',name:'private-A'}]});await page.evaluate(()=>window.first);
 assert.equal(await page.locator('#msgs').innerText(),'');assert.deepEqual(reads,[]);assert.equal(await page.evaluate(()=>chatSending),false);
 await page.evaluate(()=>{openChatThread('A','A','Assistant A',[]);window.second=sendThread('A-again');});await waitPost('A-again');
 await page.evaluate(()=>{openChatThread('B','B','Assistant B',[]);openChatThread('A','A','Assistant A',[{role:'assistant',content:'authoritative-history'}]);});answers.get('A-again')({reply:'stale-A'});await page.evaluate(()=>window.second);
 assert.equal(await page.locator('#msgs').innerText(),'authoritative-history');assert.deepEqual(reads,[]);
 await page.evaluate(()=>{window.third=sendThread('background-error');});await waitPost('background-error');await page.evaluate(()=>openChatThread('B','B','Assistant B',[]));answers.get('background-error')({error:'should stay with A'});await page.evaluate(()=>window.third);assert.equal(await page.locator('#msgs').innerText(),'');
 await page.evaluate(()=>{openChatThread('A','A','A',[]);window.drop=sendThread('drop-A');});await waitPost('drop-A');await page.evaluate(()=>openChatThread('B','B','B',[]));answers.get('drop-A')({netFail:true});await page.evaluate(()=>window.drop);assert(!gets.includes('B'),'a dropped A request must not resync B');
 // Capture destination before async image packing.
 await page.evaluate(()=>{openChatThread('A','A','A',[]);packImages=()=>new Promise(r=>window.releasePack=r);window.packed=sendThread('image-A',[{mimeType:'image/png',data:'AA==',url:'data:image/png;base64,AA=='}]);openChatThread('B','B','B',[]);releasePack([{mimeType:'image/png',data:'AA=='}]);});await waitPost('image-A');assert.equal(posts.at(-1).threadId,'A');answers.get('image-A')({reply:'image result'});await page.evaluate(()=>window.packed);assert.equal(await page.locator('#msgs').innerText(),'');
 // Enter and click share the same synchronous guard.
 await page.evaluate(()=>{switchTab('inicio');E('taskAgent').innerHTML='<option value="agent">Teste</option>';E('taskInput').value='new-task';window.start1=startTask();window.start2=startTask();E('taskInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
 for(let i=0;i<100&&!createResolve;i++)await page.waitForTimeout(10);assert.equal(createCount,1);createResolve();await waitPost('new-task');answers.get('new-task')({reply:'new result'});await page.evaluate(()=>Promise.all([window.start1,window.start2]));assert.equal(createCount,1);assert.equal(posts.filter(x=>x.message==='new-task').length,1);assert.equal(await page.locator('#taskStart').isDisabled(),false);
 // Failure releases the creation guard and keeps the user's draft.
 createResolve=null;createFail=true;await page.evaluate(()=>{switchTab('inicio');E('taskInput').value='retry-draft';window.badStart=startTask();});for(let i=0;i<100&&!createResolve;i++)await page.waitForTimeout(10);createResolve();await page.evaluate(()=>window.badStart);assert.equal(await page.locator('#taskInput').inputValue(),'retry-draft');assert.equal(await page.evaluate(()=>taskStarting),false);
 assert.deepEqual(errors,[]);await page.close();
}console.log('Chat isolation: desktop/mobile, stale success/error/network/attachments, A→B→A and duplicate creation passed.');}finally{await browser.close();}
}
