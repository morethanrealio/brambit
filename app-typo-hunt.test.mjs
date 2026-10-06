import test from 'node:test';import assert from 'node:assert/strict';
import {huntTypos,LIMIAR_TYPO,MAX_AVISOS} from './web/app-typo-hunt.mjs';
import {lintApp} from './web/applint.mjs';
import {validateDraft,lintDiagnostics} from './web/app-draft-validation.mjs';

const b64=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,Buffer.from(v,'utf8').toString('base64')]));

test('typo de 1 caractere em nome longo vira aviso com sugestão',()=>{
 const avisos=huntTypos({'public/app.js':`
   function calcularTotais(itens){ return itens.length; }
   function render(){ document.body.textContent = calcularTotal(lista); }
 `});
 assert.deepEqual(avisos,[{tipo:'nome_parecido',funcao:'calcularTotal',sugestao:'calcularTotais',arquivo:'public/app.js'}]);
});

test('handler chamado do HTML também é coberto',()=>{
 const avisos=huntTypos({
  'public/index.html':'<button onclick="salvarTarefaa()">ok</button>',
  'public/app.js':'function salvarTarefa(){ }',
 });
 assert.equal(avisos.length,1);assert.equal(avisos[0].funcao,'salvarTarefaa');assert.equal(avisos[0].sugestao,'salvarTarefa');
});

test('nome que existe nunca vira aviso',()=>{
 assert.deepEqual(huntTypos({'public/app.js':'function calcularTotais(){} calcularTotais();'}),[]);
});

test('biblioteca externa não vira aviso: não parece com nada declarado no app',()=>{
 const files={'public/app.js':`
   function calcularTotais(){ }
   const g = dayjs(); const c = new Chart(ctx,{}); Swal.fire('oi'); _.debounce(fn,100);
   document.getElementById('x').addEventListener('click',calcularTotais);
   window.localStorage.setItem('k','v');
 `};
 assert.deepEqual(huntTypos(files),[]);
});

test('globais de Node não viram aviso no arquivo de servidor',()=>{
 const files={'server.js':`
   const express=require('express'); const app=express();
   function responderTudo(res){ res.json({ok:true}); }
   app.get('/api/status',(req,res)=>responderTudo(res));
   app.listen(process.env.PORT||3000,()=>console.log('up'));
 `};
 assert.deepEqual(huntTypos(files),[]);
});

test('viés para o silêncio: se o nome aparece fora de posição de chamada, cala',()=>{
 // `calcularTotal` também é passado como referência, logo faz parte do
 // vocabulário do app e a chance de ser erro de digitação despenca.
 const files={'public/app.js':`
   function calcularTotais(){ }
   const handlers={ total: calcularTotal };
   calcularTotal();
 `};
 assert.deepEqual(huntTypos(files),[]);
});

test('typo de método é comparado com os métodos declarados',()=>{
 const files={'public/app.js':`
   const tela={ atualizarLista(){ }, limpar(){ } };
   function init(){ tela.atualizarListas(); }
 `};
 assert.deepEqual(huntTypos(files),[{tipo:'nome_parecido',funcao:'atualizarListas',sugestao:'atualizarLista',arquivo:'public/app.js'}]);
});

test('nome curto nunca vira aviso: /api/pign é Tipo 2, não é trabalho desta regra',()=>{
 const files={
  'public/app.js':'function chamar(){ return fetch("/api/pign"); } function ping(){}',
  'server.js':'app.get("/api/pign",(req,res)=>res.json({ok:1}));',
 };
 assert.deepEqual(huntTypos(files),[]);
});

test('comentário e URL não confundem o caçador',()=>{
 const files={'public/app.js':`
   // antes isso chamava calcularTotais()
   /* bloco com calcularTotais() dentro */
   const doc='https://exemplo.com/api/x';
   function calcularTotais(){ return doc; }
   calcularTotais();
 `};
 assert.deepEqual(huntTypos(files),[]);
});

test('teto de avisos respeitado',()=>{
 let src='';for(let i=0;i<20;i++)src+=`function processarRegistro${i}(){}\nprocessarRegistros${i}();\n`;
 assert.equal(huntTypos({'public/app.js':src}).length,MAX_AVISOS);
});

test('limiar alto: nomes diferentes de verdade não são sugestão um do outro',()=>{
 assert.ok(LIMIAR_TYPO>=0.85);
 const files={'public/app.js':'function salvarCliente(){} function listarProdutos(){} removerPedido();'};
 assert.deepEqual(huntTypos(files),[]);
});

test('entra como AVISO no lint e NUNCA reprova o rascunho',()=>{
 const files={'public/app.js':'function calcularTotais(){}\nfunction usar(){ return calcularTotal(); }'};
 const {erros,avisos}=lintApp(files);
 assert.deepEqual(erros,[]);
 assert.ok(avisos.some(a=>a.tipo==='nome_parecido'));
 const v=validateDraft(b64(files));
 assert.equal(v.validacao,'aprovado');
 assert.ok(v.lint_avisos.some(a=>a.tipo==='nome_parecido'));
});

test('o campo sugestao sobrevive ao saneador de diagnósticos',()=>{
 const d=lintDiagnostics({lint_avisos:[{tipo:'nome_parecido',funcao:'calcularTotal',sugestao:'calcularTotais',arquivo:'public/app.js',segredo:'NAO_PASSA'}]});
 assert.deepEqual(d.lint_avisos,[{tipo:'nome_parecido',funcao:'calcularTotal',sugestao:'calcularTotais',arquivo:'public/app.js'}]);
});

// A tester's real app exports a top-level function inside an object and calls
// it with a dot. Comparing dotted calls only against methods silenced 17 of
// the 22 planted typos that slipped through in the 20/09 calibration.
test('função de topo exportada em objeto: chamada com ponto também é comparada',()=>{
 const files={'public/chat.js':`
   function criarChat(){ return 1; }
   function enviarChat(){ return 2; }
   window.Chat = { criarChat, enviarChat };
 `,'public/app.js':`
   function entrar(){ Chat.criaaChat(); }
 `};
 assert.deepEqual(huntTypos(files),[{tipo:'nome_parecido',funcao:'criaaChat',sugestao:'criarChat',arquivo:'public/app.js'}]);
});

// Trava de calibração: 0,85 é o piso da faixa aprovada no desenho e o que foi
// medido em 20/09 (24 apps publicados + 18 rascunhos, 1 aviso, e era typo real).
test('limiar travado em 0,85, o valor calibrado contra a produção',()=>{
 assert.equal(LIMIAR_TYPO,0.85);
});
