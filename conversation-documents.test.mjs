import assert from 'node:assert/strict';import fs from 'node:fs';import zlib from 'node:zlib';
import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
const {readGoogleDocument}=await import('./web/document-read.mjs');const {generateDocument}=await import('./web/docgen.mjs');const {googleTools}=await import('./web/connectors.mjs');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},ok=(v,m)=>{assert.ok(v,m);checks++;};
const p=text=>({paragraph:{elements:[{textRun:{content:text}}]}});
const table={table:{tableRows:[{tableCells:[{content:[p('Nome')]},{content:[p('Valor')]}]},{tableCells:[{content:[p('Café')]},{content:[p('R$ 42')]}]}]}};
const doc={title:'Sintético',tabs:[{tabProperties:{title:'Principal'},documentTab:{body:{content:[p('Introdução\n'),table,p('a'.repeat(8050)+'😀fim')] }},childTabs:[{tabProperties:{title:'Anexo'},documentTab:{body:{content:[p('Última aba\n'),{tableOfContents:{content:[p('Sumário')]}}, {paragraph:{elements:[{inlineObjectElement:{inlineObjectId:'fake'}}]}}]}}}]}]};
const all=readGoogleDocument(doc,{max_chars:16000});ok(all.text.includes('Café\tR$ 42'));eq(all.tables,1);ok(all.text.includes('Última aba'));ok(all.warnings.length>0);eq(all.has_more,false);eq(all.partial,true);
let result='',offset=0,revision=null,n=0;
do {const page=readGoogleDocument(doc,{offset,max_chars:97,revision});result+=page.text;revision=page.revision;n++;if(!page.has_more)break;ok(page.next_offset>offset);offset=page.next_offset;}while(n<200);
eq(result,all.text);ok(n>2);
const first=readGoogleDocument(doc);eq(first.has_more,true);eq(first.text.length,8000);ok(first.continuation);const changed=structuredClone(doc);changed.title='same content';eq(readGoogleDocument(changed,{offset:8000,revision:first.revision}).changed,undefined);changed.tabs[0].documentTab.body.content.unshift(p('change'));eq(readGoogleDocument(changed,{offset:8000,revision:first.revision}).changed,true);eq(readGoogleDocument(doc,{offset:1}).changed,true);
for(const opt of [{offset:-1},{offset:1.5},{max_chars:0},{max_chars:16001}]){assert.throws(()=>readGoogleDocument(doc,opt));checks++;}
const small={title:'normal',body:{content:[p('Olá 😀!')]}};eq(readGoogleDocument(small).partial,false);eq(readGoogleDocument(small).text,'Olá 😀!');eq(readGoogleDocument({body:{content:[]}}).text,'');
const emoji=readGoogleDocument({body:{content:[p('😀x')]}},{max_chars:1});eq(emoji.text,'😀');eq(emoji.next_offset,2);
let called=0;
globalThis.fetch=async(url,options)=>{called++;ok(url.startsWith('https://docs.googleapis.com/v1/documents/fixture%2Fid?includeTabsContent=true'));eq(options.headers.Authorization,'Bearer MOCK_ONLY');return {ok:true,json:async()=>doc};};
const tool=googleTools({token:async()=> 'MOCK_ONLY',caps:{docs:{read:true}}}).find(t=>t.name==='docs_read');ok(tool);const rr=JSON.parse(await tool.run({id:'fixture/id'}));eq(rr.text,first.text);ok(rr.has_more);const continued=JSON.parse(await tool.run({id:'fixture/id',offset:rr.next_offset,revision:rr.revision}));ok(continued.text.includes('Última aba'));eq(called,2);await assert.rejects(()=>tool.run({id:'fixture/id',max_chars:0}));checks++;eq(called,2);globalThis.fetch=denied;
// Actual generated ZIP, not just a regular-expression assertion on source.
const controls=String.fromCharCode(...Array.from({length:32},(_,i)=>i).filter(i=>![9,10,13].includes(i)))+'\uFFFE\uFFFF\uD800';
const output=await generateDocument({format:'docx',content:'# Título\n\nTexto '+controls+' preservado Café 😀 & < >\n\n| Coluna | Dado |\n| --- | --- |\n| A | '+controls+'válido |'});
let at=0,xmls=[];
while(output.buffer.readUInt32LE(at)===0x04034b50){const size=output.buffer.readUInt32LE(at+18),nl=output.buffer.readUInt16LE(at+26),el=output.buffer.readUInt16LE(at+28),name=output.buffer.subarray(at+30,at+30+nl).toString(),start=at+30+nl+el;const text=zlib.inflateRawSync(output.buffer.subarray(start,start+size)).toString();if(name.endsWith('.xml'))xmls.push([name,text]);at=start+size;}
ok(xmls.length>0);const body=xmls.find(x=>x[0]==='word/document.xml')[1];ok(body.includes('Café 😀'));ok(body.includes('válido'));for(const [name,text] of xmls){ok(!/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(text),name);}
if(process.env.DOCUMENT_TEST_OUTPUT)fs.writeFileSync(process.env.DOCUMENT_TEST_OUTPUT,output.buffer);
console.log(`PASS ${checks}: Docs tables/tabs/pagination/revision + real connector + generated DOCX; synthetic/offline only`);
