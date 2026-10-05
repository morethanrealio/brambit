import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
import {microsoftOnboardingScope,microsoftContextServices,microsoftToolAllowed,onboardingSources} from './connections.mjs';
const providers=await import(pathToFileURL(process.cwd()+'/web/providers.mjs').href);
const auth=await import(pathToFileURL(process.cwd()+'/web/auth.mjs').href);
test('calendar scope does not request email or files, optional email is explicit',()=>{
 for(const services of ['calendar','calendar,gmail']){
  const ms=new URL(providers.providerAuthUrl('microsoft','test',{services})).searchParams.get('scope')!;
  assert.equal(ms,microsoftOnboardingScope(services));assert(ms.includes('Calendars.ReadWrite'));assert(!ms.includes('Files.'));assert.equal(ms.includes('Mail.Read'),services.includes('gmail'));
  const google=auth.scopesFor(services.split(','));assert(google.some((s:string)=>s.endsWith('calendar.events')));assert(!google.some((s:string)=>/drive|documents/.test(s)));assert.equal(google.some((s:string)=>s.endsWith('gmail.readonly')),services.includes('gmail'));
 }
 assert(new URL(providers.providerAuthUrl('microsoft','test')).searchParams.get('scope')!.includes('Files.ReadWrite'),'existing full connector remains available');
 for(const s of ['', 'gmail','calendar,drive','calendar,Mail.Read','calendar,'])assert.throws(()=>microsoftOnboardingScope(s));
});
test('Microsoft tools and source context respect partial consent',()=>{
 assert.deepEqual(microsoftContextServices('openid User.Read'),[]);assert.deepEqual(microsoftContextServices('https://graph.microsoft.com/Calendars.ReadWrite'),['calendar']);
 assert.equal(microsoftToolAllowed('hotmail_search','Calendars.ReadWrite'),false);assert.equal(microsoftToolAllowed('hotmail_send','Mail.Read'),false);assert.equal(microsoftToolAllowed('outlook_calendar_list','Calendars.Read'),true);assert.equal(microsoftToolAllowed('outlook_calendar_create','Calendars.Read'),false);
 assert.equal(microsoftToolAllowed('hotmail_read',null),true);
 const prompt=onboardingSources(['calendar'],[]);assert.match(prompt,/Google: calendar\. Microsoft: nenhuma/);assert.match(prompt,/Não crie/);assert.match(prompt,/agenda estiver vazia/);
});
test('Microsoft token refresh does not silently request mail/files',async()=>{
 const original=globalThis.fetch;let body:URLSearchParams|undefined;
 globalThis.fetch=(async(_url:unknown,opts:{body:URLSearchParams})=>{body=opts.body;return new Response(JSON.stringify({access_token:'fixture',scope:'Calendars.ReadWrite',expires_in:3600}),{status:200})}) as typeof fetch;
 try{await providers.providerRefresh('microsoft','fixture-refresh');assert.equal(body?.get('grant_type'),'refresh_token');assert.equal(body?.has('scope'),false)}finally{globalThis.fetch=original}
});
test('actual connector start routes keep calendar-only scopes and reject invalid MS services',async()=>{
 const source=readFileSync('web/server.mjs','utf8'),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const provider of ['google','microsoft'])for(const services of ['calendar','calendar,gmail',...(provider==='microsoft'?['calendar,drive']:[])]){
  const a=source.indexOf(provider==='google'?"  if (req.method === 'GET' && url.pathname === '/api/connect/google/start')":"  const provMatch = url.pathname.match(");
  const b=source.indexOf(provider==='google'?"  if (req.method === 'GET' && url.pathname === '/api/auth/google/callback')":"    // callback",a);
  const handler=source.slice(a,b)+(provider==='microsoft'?'\n}':'');let status=0,location='';
  const deps={req:{method:'GET'},res:{writeHead:(s:number,h:{Location:string})=>{status=s;location=h.Location},end:()=>{}},url:new URL(`https://fixture.test/api/connect/${provider}/start?services=${services}`),googleEnabled:()=>true,providerEnabled:()=>true,currentUser:async()=>({id:'fixture'}),newToken:()=> 'fixture-state',scopesFor:auth.scopesFor,googleAuthUrl:auth.googleAuthUrl,providerAuthUrl:providers.providerAuthUrl,microsoftOnboardingScope,providerUsesPkce:()=>false,stateCookie:()=> 'state',flowCookie:()=> 'connect',send:(_r:unknown,s:number)=>{status=s}};
  await new AsyncFunction(...Object.keys(deps),handler)(...Object.values(deps));
  if(services.includes('drive'))assert.equal(status,400);else{assert.equal(status,302);const scope=new URL(location).searchParams.get('scope')!;assert(!/Files\.|drive|documents/.test(scope));assert.equal(/Mail.Read|gmail.readonly/.test(scope),services.includes('gmail'))}
 }
});
test('actual Microsoft connector does not expose mail operations to a calendar-only token',async()=>{
 const {microsoftTools}=await import(pathToFileURL(process.cwd()+'/web/connectors-ext.mjs').href);
 const tools=microsoftTools({token:async()=>{throw new Error('Network token must not be requested in this test')},scopes:'Calendars.ReadWrite'});
 assert(tools.some((t:{name:string})=>t.name==='outlook_calendar_list'));assert(!tools.some((t:{name:string})=>t.name.startsWith('hotmail_')));
});
test('me context metadata distinguishes absent, legacy and identity-only Microsoft tokens',async()=>{
 const source=readFileSync('web/server.mjs','utf8');const a=source.indexOf('async function microsoftServicesFor('),b=source.indexOf('// Tools dos conectores OAuth',a);assert(a>0&&b>a);
 for(const [token,expected] of [[null,[]],[{scope:null},['calendar','gmail']],[{scope:'User.Read'},[]],[{scope:'Calendars.ReadWrite'},['calendar']]] as const){
  const fn=new Function('getOAuthToken','microsoftContextServices',source.slice(a,b)+';return microsoftServicesFor;')(async()=>token,microsoftContextServices);
  assert.deepEqual(await fn('fixture'),expected);
 }
});
