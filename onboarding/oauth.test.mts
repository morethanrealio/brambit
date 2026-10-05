import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const source=readFileSync('web/server.mjs','utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function callback(provider:string,valid=true,flow='connect'){
 const google=provider==='google';
 const a=source.indexOf(google?"  if (req.method === 'GET' && url.pathname === '/api/auth/google/callback')":"  const provMatch = url.pathname.match(");
 const b=source.indexOf(google?"  // Config pro frontend":"  if (req.method === 'POST' && url.pathname === '/api/disconnect/provider')",a);
 // Stop at the next route for Google, keeping its full callback block.
 const end=google?source.indexOf("  if (req.method === 'GET' && url.pathname === '/api/config')",a):b;
 assert(a>0&&end>a);const handler=source.slice(a,end);
 let location='';let exchanges=0;
 const deps={req:{method:'GET'},res:{writeHead:(_s:number,h:{Location:string})=>{location=h.Location},end:()=>{}},url:new URL(`https://example.test/api/${google?'auth':'connect'}/${provider}/callback?error=access_denied&state=${valid?'expected':'wrong'}`),process:{env:{GOOGLE_REDIRECT_URI:'https://example.test/api/auth/google/callback'}},readCookie:(_r:unknown,key:string)=>key==='oflow'?flow:key==='ostate'?'expected':null,clearStateCookie:()=>'',clearFlowCookie:()=>'',clearVerifierCookie:()=>'',currentUser:async()=>({id:'fixture'}),providerHome:()=> 'https://example.test/',providerEnabled:()=>true,googleExchange:async()=>{exchanges++;throw Error('Unexpected exchange')},console:{error:()=>{}}};
 await new AsyncFunction(...Object.keys(deps),handler)(...Object.values(deps));assert.equal(exchanges,0);return new URL(location);
}
test('OAuth cancellation has its own outcome only with matching state, without exchanging a code',async()=>{for(const p of ['google','microsoft']){assert.equal((await callback(p)).searchParams.get('connection_outcome'),'cancelled');assert.equal((await callback(p,false)).searchParams.get('connection_outcome'),'failed')}});
test('Google login errors do not become connector cancellation events',async()=>{assert.equal((await callback('google',true,'login')).searchParams.get('connection_outcome'),null)});
