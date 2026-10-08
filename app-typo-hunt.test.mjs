import test from 'node:test';import assert from 'node:assert/strict';
import {huntTypos,LIMIAR_TYPO,MAX_AVISOS} from './web/app-typo-hunt.mjs';
import {lintApp} from './web/applint.mjs';
import {validateDraft,lintDiagnostics} from './web/app-draft-validation.mjs';

const b64=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,Buffer.from(v,'utf8').toString('base64')]));

test('a 1-character typo in a long name becomes a warning with a suggestion',()=>{
 const avisos=huntTypos({'public/app.js':`
   function calcularTotais(itens){ return itens.length; }
   function render(){ document.body.textContent = calcularTotal(lista); }
 `});
 assert.deepEqual(avisos,[{tipo:'nome_parecido',funcao:'calcularTotal',sugestao:'calcularTotais',arquivo:'public/app.js'}]);
});

test('a handler called from HTML is also covered',()=>{
 const avisos=huntTypos({
  'public/index.html':'<button onclick="salvarTarefaa()">ok</button>',
  'public/app.js':'function salvarTarefa(){ }',
 });
 assert.equal(avisos.length,1);assert.equal(avisos[0].funcao,'salvarTarefaa');assert.equal(avisos[0].sugestao,'salvarTarefa');
});

test('a name that exists never becomes a warning',()=>{
 assert.deepEqual(huntTypos({'public/app.js':'function calcularTotais(){} calcularTotais();'}),[]);
});

test('an external library never becomes a warning: it doesn\'t resemble anything declared in the app',()=>{
 const files={'public/app.js':`
   function calcularTotais(){ }
   const g = dayjs(); const c = new Chart(ctx,{}); Swal.fire('oi'); _.debounce(fn,100);
   document.getElementById('x').addEventListener('click',calcularTotais);
   window.localStorage.setItem('k','v');
 `};
 assert.deepEqual(huntTypos(files),[]);
});

test('Node globals don\'t become a warning in the server file',()=>{
 const files={'server.js':`
   const express=require('express'); const app=express();
   function responderTudo(res){ res.json({ok:true}); }
   app.get('/api/status',(req,res)=>responderTudo(res));
   app.listen(process.env.PORT||3000,()=>console.log('up'));
 `};
 assert.deepEqual(huntTypos(files),[]);
});

test('bias toward silence: if the name appears outside call position, it stays quiet',()=>{
 // `calcularTotal` is also passed as a reference, so it's part of the
 // app's vocabulary and the chance of it being a typo plummets.
 const files={'public/app.js':`
   function calcularTotais(){ }
   const handlers={ total: calcularTotal };
   calcularTotal();
 `};
 assert.deepEqual(huntTypos(files),[]);
});

test('a method typo is compared against declared methods',()=>{
 const files={'public/app.js':`
   const tela={ atualizarLista(){ }, limpar(){ } };
   function init(){ tela.atualizarListas(); }
 `};
 assert.deepEqual(huntTypos(files),[{tipo:'nome_parecido',funcao:'atualizarListas',sugestao:'atualizarLista',arquivo:'public/app.js'}]);
});

test('a short name never becomes a warning: /api/pign is Type 2, not this rule\'s job',()=>{
 const files={
  'public/app.js':'function chamar(){ return fetch("/api/pign"); } function ping(){}',
  'server.js':'app.get("/api/pign",(req,res)=>res.json({ok:1}));',
 };
 assert.deepEqual(huntTypos(files),[]);
});

test('a comment and a URL don\'t confuse the hunter',()=>{
 const files={'public/app.js':`
   // antes isso chamava calcularTotais()
   /* bloco com calcularTotais() dentro */
   const doc='https://exemplo.com/api/x';
   function calcularTotais(){ return doc; }
   calcularTotais();
 `};
 assert.deepEqual(huntTypos(files),[]);
});

test('the warning cap is respected',()=>{
 let src='';for(let i=0;i<20;i++)src+=`function processarRegistro${i}(){}\nprocessarRegistros${i}();\n`;
 assert.equal(huntTypos({'public/app.js':src}).length,MAX_AVISOS);
});

test('high threshold: genuinely different names aren\'t suggestions for each other',()=>{
 assert.ok(LIMIAR_TYPO>=0.85);
 const files={'public/app.js':'function salvarCliente(){} function listarProdutos(){} removerPedido();'};
 assert.deepEqual(huntTypos(files),[]);
});

test('enters the lint as a WARNING and NEVER fails the draft',()=>{
 const files={'public/app.js':'function calcularTotais(){}\nfunction usar(){ return calcularTotal(); }'};
 const {erros,avisos}=lintApp(files);
 assert.deepEqual(erros,[]);
 assert.ok(avisos.some(a=>a.tipo==='nome_parecido'));
 const v=validateDraft(b64(files));
 assert.equal(v.validacao,'aprovado');
 assert.ok(v.lint_avisos.some(a=>a.tipo==='nome_parecido'));
});

test('the sugestao field survives the diagnostics sanitizer',()=>{
 const d=lintDiagnostics({lint_avisos:[{tipo:'nome_parecido',funcao:'calcularTotal',sugestao:'calcularTotais',arquivo:'public/app.js',segredo:'NAO_PASSA'}]});
 assert.deepEqual(d.lint_avisos,[{tipo:'nome_parecido',funcao:'calcularTotal',sugestao:'calcularTotais',arquivo:'public/app.js'}]);
});

// A tester's real app exports a top-level function inside an object and calls
// it with a dot. Comparing dotted calls only against methods silenced 17 of
// the 22 planted typos that slipped through in the 20/09 calibration.
test('a top-level function exported in an object: a dotted call is also compared',()=>{
 const files={'public/chat.js':`
   function criarChat(){ return 1; }
   function enviarChat(){ return 2; }
   window.Chat = { criarChat, enviarChat };
 `,'public/app.js':`
   function entrar(){ Chat.criaaChat(); }
 `};
 assert.deepEqual(huntTypos(files),[{tipo:'nome_parecido',funcao:'criaaChat',sugestao:'criarChat',arquivo:'public/app.js'}]);
});

// Calibration guard: 0.85 is the floor of the range approved in the design and what was
// measured on 2026-09-20 (24 published apps + 18 drafts, 1 warning, and it was a real typo).
test('threshold locked at 0.85, the value calibrated against production',()=>{
 assert.equal(LIMIAR_TYPO,0.85);
});
