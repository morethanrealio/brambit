// ── Prova de vida no fim da tarefa de app (Fase 2 do item 3, frustrações 16/09) ──
// O que está sob teste é o GANCHO, não o container: o host roda a prova sozinho
// quando a edição fecha validada, anexa o veredito ao recibo e NUNCA deixa a prova
// mudar o desfecho da tarefa. O container de verdade vive no `probe` do ctl.py.
import test from 'node:test';import assert from 'node:assert/strict';
import crypto from 'node:crypto';import fs from 'node:fs';import net from 'node:net';import tls from 'node:tls';
import {runAppTask} from './web/app-task-runner.mjs';
import {validateDraft,draftRevision} from './web/app-draft-validation.mjs';
import {appTaskReceipt} from './web/app-review-receipt.mjs';
import {ToolRegistry} from './core-proto/core.mjs';
net.Socket.prototype.connect=()=>{throw Error('Network forbidden');};tls.connect=()=>{throw Error('Network forbidden');};globalThis.fetch=()=>{throw Error('Network forbidden');};
const b64=s=>Buffer.from(s).toString('base64'),hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const scope=JSON.stringify(['session','demo','']);
const HTML='<html>\n<script>\nasync function ping(){ const r = await fetch("/api/ping"); return r.ok; }\n</script>\n</html>';
const call=(name,args,id)=>({id,name,args});const batch=(...toolCalls)=>({stop:'tool',toolCalls,usage:{in:3,out:2}});
const end={stop:'end',text:'Pronto, testei tudo e está funcionando!',usage:{in:3,out:2}};

// Fixture mínima: um app de um arquivo, edição que grava e valida, e um `provar_app`
// de mentira cujo retorno cada teste escolhe. Nada aqui fala com host nem com rede.
function fixture({prova,semProva=false}={}) {
 let record={id:crypto.randomUUID(),targetIdentity:'owner:demo',mode:'edicao',objective:'Corrigir e validar, sem publicar.',
  status:'paused',history:[],calls:0,tokens:0,elapsed:0,journal:[],evidence:[],report:[],signatures:[],progress:[],pending:null,reviewFiles:null,
  readCoverage:[{arquivo:'public/index.html',hash:hash(HTML),intervalos:[[0,HTML.length]],total_chars:HTML.length}]};
 const store={withTask:async(k,fn)=>fn({id:hash(k),record:structuredClone(record),save:async r=>{record=structuredClone(r);}})};
 const files={'public/index.html':b64(HTML)};
 let provas=0,vistaPeloModelo=false;
 const tools=new ToolRegistry();
 tools.add({name:'listar_arquivos_do_app',parameters:{},run:async()=>({ok:true,alvo_validacao:'owner:demo',revisao:draftRevision(files),
  arquivos:Object.entries(files).map(([caminho,b])=>({caminho,hash:hash(Buffer.from(b,'base64'))}))})});
 tools.add({name:'escrever_arquivo_do_app',parameters:{},run:async args=>{files[args.caminho]=b64(args.conteudo);
  return {ok:true,arquivo:args.caminho,hash:hash(args.conteudo),alvo_validacao:'owner:demo',revisao:draftRevision(files)};}});
 tools.add({name:'validar_rascunho_do_app',parameters:{},run:async()=>({...validateDraft(files),alvo_validacao:'owner:demo'})});
 if(!semProva)tools.add({name:'provar_app',parameters:{type:'object',properties:{}},run:async()=>{provas++;
  return typeof prova==='function'?prova():prova;}});
 const provider=(...results)=>{let n=0;return {complete:async input=>{
  if(input.tools.some(x=>x.name==='provar_app'))vistaPeloModelo=true;return results[n++]||end;}};};
 return {store,tools,provider,files,
  get provas(){return provas;},get vistaPeloModelo(){return vistaPeloModelo;},
  leitura:()=>store.withTask(scope,async({record})=>record),
  run:(p)=>runAppTask({store,scope,mode:'edicao',objetivo:'Continue',userRequest:'Continue',system:'synthetic',tools,provider:p})};
}
const edicaoBoa=f=>f.provider(batch(call('escrever_arquivo_do_app',{caminho:'public/index.html',conteudo:HTML.replace('/api/ping','/api/pong')},'w'),
 call('validar_rascunho_do_app',{},'v')),end);

test('edição validada dispara a prova de vida uma vez e anexa o veredito ao recibo',async()=>{
 const f=fixture({prova:{ok:true,prova:'rodou',veredito:'passou',efemero:true,app:'tst-deadbeef',health:'healthy'}});
 const out=await f.run(edicaoBoa(f));
 assert.equal(out.app_build.estado,'consistencia_validada');
 assert.equal(f.provas,1);
 assert.equal(out.app_build.prova_de_vida.veredito,'passou');
 assert.equal(out.app_build.prova_de_vida.efemero,true);
 const saved=await f.leitura();
 assert.deepEqual(saved.journal.filter(x=>x.event==='prova_de_vida').map(x=>[x.ok,x.prova,x.veredito]),[[true,'rodou','passou']]);
});

test('a prova é do HOST: nunca aparece no schema que vai pro modelo',async()=>{
 const f=fixture({prova:{ok:true,prova:'rodou',veredito:'passou'}});
 await f.run(edicaoBoa(f));
 assert.equal(f.vistaPeloModelo,false);
});

test('app que sobe quebrado INFORMA, não bloqueia: tarefa segue concluída e validada',async()=>{
 const f=fixture({prova:{ok:true,prova:'rodou',veredito:'quebrado',rotas_quebradas:'/api/pong (404)',
  agente:'Status 404 numa rota de API costuma ser erro de DIGITAÇÃO no caminho.'}});
 const out=await f.run(edicaoBoa(f));
 assert.equal(out.ok,true);                                   // o gate estático continua sendo o gate
 assert.equal(out.app_build.estado,'consistencia_validada');
 assert.equal(out.app_build.motivo,'completed');
 assert.equal((await f.leitura()).status,'completed');
 assert.equal(out.app_build.prova_de_vida.veredito,'quebrado');
 assert.match(out.app_build.prova_de_vida.rotas_quebradas,/pong/);
});

test('crash no boot vira veredito com log, sem mexer em ok nem em status',async()=>{
 const f=fixture({prova:{ok:true,prova:'rodou',veredito:'crashou',exit_code:1,log_do_crash:'ReferenceError: pign is not defined'}});
 const out=await f.run(edicaoBoa(f));
 assert.equal(out.ok,true);
 assert.equal(out.app_build.prova_de_vida.veredito,'crashou');
 assert.match(out.app_build.prova_de_vida.log_do_crash,/ReferenceError/);
});

test('prova que não roda registra exatamente isso, nunca aprovado nem reprovado',async()=>{
 const f=fixture({prova:{ok:false,prova:'nao_rodou',error:'Já existe uma prova de vida rodando pra este usuário (restam ~120s).',
  agente:'A prova de vida NÃO chegou a rodar, então ela não diz NADA sobre o app.'}});
 const out=await f.run(edicaoBoa(f));
 assert.equal(out.ok,true);
 assert.equal(out.app_build.prova_de_vida.prova,'nao_rodou');
 assert.equal(out.app_build.prova_de_vida.veredito,undefined);
 assert.equal((await f.leitura()).journal.findLast(x=>x.event==='prova_de_vida').ok,false);
});

test('prova que estoura é normalizada pro mesmo contrato e a tarefa não quebra',async()=>{
 const f=fixture({prova:()=>{throw Error('docker indisponível');}});
 const out=await f.run(edicaoBoa(f));
 assert.equal(out.ok,true);
 assert.equal(out.app_build.prova_de_vida.prova,'nao_rodou');
 assert.match(out.app_build.prova_de_vida.error,/docker indispon/);
});

test('sem validação estática aprovada a prova NÃO roda (nada a provar ainda)',async()=>{
 const f=fixture({prova:{ok:true,prova:'rodou',veredito:'passou'}});
 const out=await f.run(f.provider(batch(call('escrever_arquivo_do_app',{caminho:'public/index.html',conteudo:HTML+'\n<!-- x -->'},'w')),end));
 assert.equal(out.app_build.motivo,'edit_validation_pending');
 assert.equal(f.provas,0);
 assert.equal(out.app_build.prova_de_vida,undefined);
});

test('host sem a tool (registry antigo) segue funcionando sem prova nenhuma',async()=>{
 const f=fixture({semProva:true});
 const out=await f.run(edicaoBoa(f));
 assert.equal(out.ok,true);
 assert.equal(out.app_build.estado,'consistencia_validada');
 assert.equal(out.app_build.prova_de_vida,undefined);
 assert.equal((await f.leitura()).journal.filter(x=>x.event==='prova_de_vida').length,0);
});

test('o recibo determinístico segue sem prometer o que o modelo disse',async()=>{
 const f=fixture({prova:{ok:true,prova:'rodou',veredito:'quebrado',rotas_quebradas:'/api/pong (404)'}});
 const out=await f.run(edicaoBoa(f));
 for(const lang of ['pt-BR','en','es']){
  const texto=appTaskReceipt(out.app_build,lang,{technicalDetails:true});
  assert.ok(!texto.includes('testei tudo'));
 }
});

// Roteamento no servidor real: a tool tem que SAIR do assistente principal e ENTRAR
// no sub-agente de app, senão ela vira 1 schema a mais no piso de todo turno.
test('roteamento: provar_app está em APP_BUILD_TOOLS e fora do inline do principal',()=>{
 const server=fs.readFileSync('web/server.mjs','utf8');
 const build=server.match(/const APP_BUILD_TOOLS = new Set\(\[([\s\S]*?)\]\)/)[1];
 const inline=server.match(/const APPS_INLINE = new Set\(\[([\s\S]*?)\]\)/)[1];
 assert.ok(build.includes("'provar_app'"));
 assert.ok(!inline.includes("'provar_app'"));
 // O filtro do registry principal é NEGATIVO: quem não está num dos dois conjuntos cai lá.
 assert.ok(server.includes('!APPS_INLINE.has(t.name) && !APP_BUILD_TOOLS.has(t.name)'));
 // E o sub-agente de app é APP_BUILD_TOOLS + as inline, então a tool chega lá.
 assert.ok(server.includes('const APP_SUB_TOOLS = new Set([...APP_BUILD_TOOLS'));
});

// O runner só enxerga READS ∪ EDITS pra montar o registry do modelo; provar_app fica
// de fora dos dois de propósito, e é isso que a torna inchamável em loop.
test('runner: provar_app não está nem em READS nem em EDITS',()=>{
 const src=fs.readFileSync('web/app-task-runner.mjs','utf8');
 const reads=src.match(/const READS=new Set\(\[([\s\S]*?)\]\)/)[1];
 const edits=src.match(/const EDITS=new Set\(\[([\s\S]*?)\]\)/)[1];
 assert.ok(!reads.includes('provar_app'));
 assert.ok(!edits.includes('provar_app'));
});
