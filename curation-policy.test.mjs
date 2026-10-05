// Apenas dados sintéticos e núcleo puro; nenhuma rotina/conta/entrega real.
import assert from 'node:assert/strict';
import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
const {curationArticleKey:key,normalizeCurationSections:sections,evaluateCuration:evaluate}=await import('./web/curation-policy.mjs');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},ok=a=>{assert.ok(a);checks++;},bad=f=>{assert.throws(f);checks++;};
const spec=[{id:'market',min:1,max:2},{id:'cases',min:1,max:2},{id:'papers',min:2,max:2}];
const item=(n,section='papers')=>({url:`https://example.invalid/article/${n}`,section});
const args={userId:'synthetic-user',routineId:'synthetic-routine',sections:spec,items:[],delivered:[],historyAvailable:true};
const run=extra=>evaluate({...args,...extra});
for(const v of [null,undefined,3,{},'', 'javascript:alert(1)','data:text/plain,x','ftp://example.invalid/x','https://user:pass@example.invalid/x','https://example.invalid/a b','https://example.invalid/'+ 'a'.repeat(4096)])eq(key(v),null);
eq(key('https://EXAMPLE.invalid:443/a?utm_source=x&b=2&a=1#section'),'https://example.invalid/a?a=1&b=2');
for(const track of ['utm_source','utm_campaign','UTM_MEDIUM','gclid','fbclid'])eq(key(`https://example.invalid/a?${track}=x`),key('https://example.invalid/a'));
for(const [a,b] of [['?id=1','?id=2'],['?v=1','?v=2'],['?signature=a','?signature=b'],['#/article/1','#/article/2'],['#!/one','#!/two']])ok(key('https://example.invalid/'+a)!==key('https://example.invalid/'+b));
for(const [a,b] of [['http://example.invalid/a','https://example.invalid/a'],['https://www.example.invalid/a','https://example.invalid/a'],['https://example.invalid/A','https://example.invalid/a'],['https://example.invalid/a','https://example.invalid/a/']])ok(key(a)!==key(b));
for(const s of [null,[],[spec[0],spec[0]],[{id:'bad id',min:1,max:2}],[{id:'x',min:3,max:2}],[{id:'x',min:1.2,max:2}],[{id:'x',min:0,max:51}],Array(21).fill(spec[0])])bad(()=>sections(s));
for(const change of [{userId:''},{routineId:null},{items:null},{items:Array(1001).fill(item(1))},{delivered:null},{delivered:Array(10001).fill({})}])bad(()=>run(change));
for(const historyAvailable of [false,undefined,null,'true']){const r=run({historyAvailable,items:[item(1)]});eq(r.state,'blocked');eq(r.accepted,[]);eq(r.coverageSatisfied,false);}
let r=run({items:[item(1),item(2),item(3)]});eq(r.coverageSatisfied,false);eq(r.coverage.map(s=>[s.id,s.count,s.missing]),[['market',0,1],['cases',0,1],['papers',2,0]]);eq(r.rejected[0].reason,'section_limit');
const full=[item(1,'market'),item(2,'cases'),item(3),item(4)];r=run({items:full});eq(r.coverageSatisfied,true);eq(r.accepted.length,4);eq(r.rejected,[]);
const max=[item(1,'market'),item(2,'market'),item(3,'cases'),item(4,'cases'),item(5),item(6)];r=run({items:max});eq(r.coverageSatisfied,true);eq(r.accepted.length,6);
const snapshot=JSON.stringify(full);run({items:full});eq(JSON.stringify(full),snapshot);
const delivered={userId:args.userId,routineId:args.routineId,url:item(1).url,confirmed:true};
for(const [row,rejected] of [[delivered,true],[{...delivered,userId:'other'},false],[{...delivered,routineId:'other'},false],[{...delivered,confirmed:false},false],[{...delivered,confirmed:'true'},false]]){
 const r=run({items:[item(1,'market')],delivered:[row]});eq(r.accepted.length,rejected?0:1);eq(r.rejected[0]?.reason,rejected?'already_delivered':undefined);
}
r=run({items:[{...item(1),url:item(1).url+'?utm_source=another#part'}],delivered:[delivered]});eq(r.rejected[0].reason,'already_delivered');
r=run({items:[item(1,'market'),item(1,'cases')]});eq(r.accepted.length,1);eq(r.rejected[0].reason,'duplicate_in_edition');eq(r.coverageSatisfied,false);
r=run({items:[{url:'no-url',section:'market'},item(1,'unknown'),item(2)]});eq(r.rejected.map(x=>x.reason),['invalid_url','unknown_section']);eq(r.accepted[0].index,2);
r=run({items:full,delivered:[{...delivered,url:'bad'}]});eq(r.state,'blocked');eq(r.reason,'invalid_history');eq(r.coverageSatisfied,false);
r=run({items:full,delivered:[{...delivered,url:'bad',userId:'other'}]});eq(r.coverageSatisfied,true);
// Failed/uncertain delivery must not poison next edition; confirmed one must.
const pending={...delivered,confirmed:false};eq(run({items:[item(1)],delivered:[pending]}).accepted.length,1);
eq(run({items:[item(1)],delivered:[{...pending,confirmed:true}]}).accepted.length,0);
// Removing repeats may reveal missing sections; don't report success before filtering.
r=run({items:full,delivered:[{...delivered,url:item(3).url}]});eq(r.coverageSatisfied,false);eq(r.coverage.find(s=>s.id==='papers').missing,1);
console.log(`OK: ${checks} verificações do núcleo de curadoria; puro, offline, sem integração ou efeitos reais.`);
