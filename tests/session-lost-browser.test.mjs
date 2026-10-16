import {chromiumPath,browserAvailableOrSkip} from '../test-support/chromium.mjs';
import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync('web/public/index.html','utf8');
// Execute the real application functions and DOM, omitting automatic login/boot.
const html=source.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/g,(all,open,body,close)=>body.includes('// ── Boot ──')?open+body.slice(0,body.indexOf('// ── Boot ──'))+'\nwindow.fixtureReady=true;'+close:all);
// Skips (with reason) when no local Chromium exists; see test-support/chromium.mjs.
if(browserAvailableOrSkip('tests/session-lost-browser.test.mjs')){
const browser=await chromium.launch({executablePath:chromiumPath(),headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:html});
  if(url.pathname==='/page-texts.js')return route.fulfill({contentType:'text/javascript',body:readFileSync('web/public/page-texts.js','utf8')});
  if(url.pathname==='/api/login')return route.fulfill({status:401,json:{error:'server.incorrect_email_or_password'}});
  if(url.pathname==='/api/thread')return route.fulfill({status:401,json:{error:'server.log_in_first'}});
  if(url.pathname==='/login')return route.fulfill({contentType:'text/html',body:'<p>login page</p>'});
  return route.fulfill({json:{}});
 });
 await page.goto('https://fixture.invalid/fixture');await page.waitForFunction(()=>window.fixtureReady);
 // On the auth screen a 401 is a wrong password: it must come back as an error, not reload the page.
 assert.deepEqual(await page.evaluate(()=>api('api/login',{email:'a@b.c',password:'x'})),{error:'server.incorrect_email_or_password'});
 assert.equal(new URL(page.url()).pathname,'/fixture');
 // Inside the app a 401 means the session is gone: go to the login form.
 await page.evaluate(()=>{showApp(true);api('api/thread?id=A');});
 await page.waitForURL(u=>u.pathname==='/login');
 assert.equal(new URL(page.url()).search,'?modo=entrar');
 assert.deepEqual(errors,[]);
 console.log('Session lost: 401 in the app goes to /login?modo=entrar; 401 on the auth screen stays an error.');
}finally{await browser.close();}
}
