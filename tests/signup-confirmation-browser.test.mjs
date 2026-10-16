import {chromiumPath,browserAvailableOrSkip} from '../test-support/chromium.mjs';
import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {fillPage} from '../web/page-i18n.mjs';
// The page as the server serves it in English (texts filled from the catalog).
const source=fillPage(readFileSync('web/public/index.html','utf8'),'en',{vars:{brand:'Brambit'}});
// Execute the real application functions and DOM, omitting automatic login/boot.
const html=source.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/g,(all,open,body,close)=>body.includes('// ── Boot ──')?open+body.slice(0,body.indexOf('// ── Boot ──'))+'\nwindow.fixtureReady=true;'+close:all);
// Skips (with reason) when no local Chromium exists; see test-support/chromium.mjs.
if(browserAvailableOrSkip('tests/signup-confirmation-browser.test.mjs')){
const browser=await chromium.launch({executablePath:chromiumPath(),headless:true});
try{
 const page=await browser.newPage(),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
 let confirmed=false;
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:html});
  if(url.pathname==='/page-texts.js')return route.fulfill({contentType:'text/javascript',body:readFileSync('web/public/page-texts.js','utf8')});
  if(url.pathname.startsWith('/api/'))posts.push([url.pathname,route.request().postDataJSON?.()]);
  if(url.pathname==='/api/signup')return route.fulfill({json:{confirmEmail:true,email:'new@example.invalid',sent:true}});
  if(url.pathname==='/api/signup/resend')return route.fulfill({json:{ok:true,sent:true}});
  if(url.pathname==='/api/signup/confirm')return route.fulfill({json:{ok:true,email:'new@example.invalid'}});
  if(url.pathname==='/api/login')return confirmed
   ?route.fulfill({json:{name:'New Person',agents:[]}})
   :route.fulfill({status:403,json:{error:'Confirm your email first.',confirmEmail:true,email:'new@example.invalid'}});
  return route.fulfill({json:{}});
 });
 await page.goto('https://fixture.invalid/fixture');await page.waitForFunction(()=>window.fixtureReady);
 const visible=id=>page.evaluate(id=>!E(id).classList.contains('hidden'),id);
 await page.evaluate(()=>{showApp(false);showAuthCard('login');reveal();window.signedUp=[];ganchosDoApp.aoCadastrar.push(m=>signedUp.push(m));});
 // Sign-up with a password: no account yet, the screen says where the link went.
 await page.evaluate(()=>{if(!signupMode)E('toggleLink').click();E('auName').value='New Person';E('auEmail').value='new@example.invalid';E('auPass').value='a-long-password-1';E('auTerms').checked=true;E('authBtn').click();});
 await page.waitForFunction(()=>!E('confirmEmailCard').classList.contains('hidden'));
 assert.match(await page.textContent('#ceText'),/new@example\.invalid/);
 assert.deepEqual(await page.evaluate(()=>signedUp),[]); // not an account yet: no sign-up mark
 // "Resend" carries the sign-up's password (the server only answers to whoever knows it).
 await page.click('#ceResend');await page.waitForFunction(()=>!E('ceOk').classList.contains('hidden'));
 assert.deepEqual(posts.find(p=>p[0]==='/api/signup/resend')[1],{email:'new@example.invalid',password:'a-long-password-1'});
 // A login before confirming is the same screen, not an error on the login form.
 await page.evaluate(()=>backToLogin('new@example.invalid'));
 await page.evaluate(()=>{E('auPass').value='a-long-password-1';E('authBtn').click();});
 await page.waitForFunction(()=>!E('confirmEmailCard').classList.contains('hidden'));
 assert.equal(await visible('authErr'),false);
 // The link's page: only the button confirms; then the login form, e-mail filled, with the message.
 await page.evaluate(()=>{history.replaceState(null,'','/confirm-email?token=tok-1');showAuthCard('confirmLink');});
 assert.equal(posts.some(p=>p[0]==='/api/signup/confirm'),false);
 await page.click('#clBtn');await page.waitForFunction(()=>!E('authcard').classList.contains('hidden'));
 assert.deepEqual(posts.find(p=>p[0]==='/api/signup/confirm')[1],{token:'tok-1'});
 assert.equal(await page.inputValue('#auEmail'),'new@example.invalid');
 assert.equal(await visible('authOk'),true);assert.equal(await visible('nameRow'),false);
 assert.equal(new URL(page.url()).pathname+new URL(page.url()).search,'/login?modo=entrar');
 // The first login after confirming is when the account starts (sign-up mark, once).
 confirmed=true;
 await page.evaluate(()=>{E('auPass').value='a-long-password-1';E('authBtn').click();});
 await page.waitForFunction(()=>signedUp.length>0);
 assert.deepEqual(await page.evaluate(()=>[signedUp,localStorage.getItem(SIGNUP_MARK)]),[['email'],null]);
 assert.deepEqual(errors,[]);
 console.log('Sign-up confirmation: sign-up/login show the confirm card, the link page confirms only by button, first login starts the account.');
}finally{await browser.close();}
}
