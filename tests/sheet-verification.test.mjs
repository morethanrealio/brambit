// Real editSpreadsheet with in-memory dependencies. No XLSX/customer/API writes.
import assert from 'node:assert/strict';
const { editSpreadsheet } = await import(process.env.SHEET_MODULE_URL || '../web/planilha-edit.mjs');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const ok=(x,msg)=>{assert(x,msg);checks++;};
const MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function fixture(mode,{retry=false,noEvidence=false}={}){
 const original=Buffer.from(JSON.stringify({rows:62,sheets:3,tag:'original'}));
 const state={loads:[],edits:0,reads:0,saved:[],renamed:[],buf:null};
 const asset={id:'source',s3_key:'synthetic/original',caption:'Synthetic.xlsx',mime:MIME,created_at:'2026-09-09T00:00:00Z'};
 const deps={
  listAssets:async()=>[asset],getAsset:async()=>asset,fetchBytes:async()=>({buffer:original}),
  loadIntoSandbox:async(uid,buf)=>{state.loads.push(Buffer.from(buf));state.buf=Buffer.from(buf);return {ok:true,path:'/synthetic/file.xlsx'};},
  inspect:buf=>({...JSON.parse(buf.toString()),text:'',parts:['xl/workbook.xml'],formulas:0}),
  runEditor:async()=>{state.edits++;state.buf=Buffer.from(JSON.stringify({rows:retry&&state.edits===1?1:63,sheets:3,tag:'edited-'+state.edits}));return noEvidence?'adicionei uma linha':'adicionei uma linha\nEVIDENCIA: Aba!A1=alpha; Aba!B1=beta';},
  readBytes:async()=>({ok:true,buffer:state.buf}),
  saveAsset:async(a)=>{state.saved.push(a);return {assetId:'new',key:'synthetic/new',url:'https://example.invalid/new'};},
  renameAsset:async(...a)=>{state.renamed.push(a);},
 };
 const matching=[{ref:'Aba!A1',exists:true,value:'alpha'},{ref:'Aba!B1',exists:true,value:'beta'}];
 if(mode!=='missing')deps.readCells=async()=>{
  state.reads++;
  if(mode==='throw')throw Error('PRIVATE_SYNTHETIC_FAILURE');
  if(mode==='null')return null;
  if(mode==='undefined')return undefined;
  if(mode==='malformed')return {unexpected:'PRIVATE_SYNTHETIC_FAILURE'};
  if(mode==='empty')return [];
  if(mode==='partial')return [matching[0]];
  if(mode==='invalid')return [{ref:'Aba!A1',invalid:true},{ref:'Aba!B1',invalid:true}];
  if(mode==='formula')return [{ref:'Aba!A1',exists:true,formula:'1+1',value:''},{ref:'Aba!B1',exists:true,formula:'2+2',value:''}];
  if(mode==='mismatch')return [{ref:'Aba!A1',exists:true,value:'wrong'},matching[1]];
  if(mode==='mismatch-then-null'&&state.reads===1)return [{ref:'Aba!A1',exists:true,value:'wrong'},matching[1]];
  if(mode==='mismatch-then-null')return null;
  if(mode==='mismatch-then-ok'&&state.reads===1)return [{ref:'Aba!A1',exists:true,value:'wrong'},matching[1]];
  return matching;
 };
 return {state,original,deps};
}
let sequence=0;
async function execute(mode,opts){const f=fixture(mode,opts);const r=await editSpreadsheet({userId:'synthetic-'+sequence++,objetivo:'adicionar linha sem mudar as antigas',deps:f.deps});return {...f,r};}
for(const mode of ['missing','throw','null','undefined','malformed','empty','partial','invalid','formula','ok']){
 for(const retry of [false,true]){
  const {state,original,r}=await execute(mode,{retry});const text=r.avisos.join('\n');
  eq(r.ok,true);eq(r.tentativas,retry?2:1);eq(state.saved.length,1);eq(state.renamed.length,1);
  ok(state.loads.every(x=>x.equals(original)),'each attempt starts from original');
  ok(!text.includes('O resultado final está conferido'));ok(!text.includes('O resto conferiu'));ok(!text.includes('mesmas abas, linhas e fórmulas'));ok(!text.includes('PRIVATE_SYNTHETIC_FAILURE'));
  eq(text.includes('Precisei de 2 tentativas'),retry);
  if(mode==='ok'){
   eq(r.evidencia.conferidas,2);ok(text.includes('Conferido por código'));ok(text.includes('2 de 2'));ok(text.includes('não valida células não declaradas nem a autenticidade das fontes'));ok(!text.includes('NÃO consegui conferir'));
  }else{
   ok(text.includes('NÃO consegui conferir célula a célula toda a alteração'));ok(text.includes('não apresente o resultado como integralmente conferido'));
   if(mode==='partial'){eq(r.evidencia.conferidas,1);ok(text.includes('1 de 2'));}
   else ok(!text.includes('Conferido por código'));
   if(mode==='missing')ok(text.includes('não está disponível'));
   if(['throw','null','undefined','malformed'].includes(mode)){eq(r.evidencia,null);ok(text.includes('Não consegui reler'));}
   if(['empty','invalid','formula'].includes(mode)){eq(r.evidencia.conferidas,0);ok(text.includes('Não deu pra conferir por código'));}
  }
 }
}
{
 const {r,state}=await execute('ok',{noEvidence:true});eq(r.ok,true);eq(r.tentativas,2);eq(state.reads,0);eq(state.saved.length,1);
 ok(r.avisos.join('\n').includes('O editor não declarou'));ok(!r.avisos.join('\n').includes('Conferido por código'));
}
{
 const {r,state}=await execute('mismatch');eq(r.ok,false);eq(r.tentativas,2);eq(state.saved.length,0);eq(state.renamed.length,0);ok(r.error.includes('não conferem'));
}
for(const mode of ['mismatch-then-null','mismatch-then-ok']){
 const {r,state,original}=await execute(mode);eq(r.ok,true);eq(r.tentativas,2);eq(state.saved.length,1);ok(state.loads.every(x=>x.equals(original)));
 const text=r.avisos.join('\n');ok(!text.includes('O resultado final está conferido'));
 if(mode==='mismatch-then-null'){eq(r.evidencia,null);ok(text.includes('Não consegui reler'));ok(!text.includes('Conferido por código'));}
 else {eq(r.evidencia.erros.length,0);eq(r.evidencia.conferidas,2);ok(text.includes('2 de 2'));ok(!text.includes('NÃO consegui conferir'));}
}
console.log(`${checks} verificações aprovadas: ausência/falha/parcialidade de conferência, reset por tentativa, prova limitada às células e persistência simulada. Zero DB/S3/Drive/cliente real.`);
