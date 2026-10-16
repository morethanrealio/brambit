import {createHash} from 'node:crypto';
import {ToolRegistry} from '../../core-proto/core.mjs';
import {filePage} from '../../core-proto/file-page.mjs';
export const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
export function memory(){const data=new Map();return {data,read:async s=>structuredClone(data.get(s)||null),withTask:async(s,fn)=>fn({id:s,record:structuredClone(data.get(s)||null),save:async r=>data.set(s,structuredClone(r))})};}
export function fixture(){
 const files={'server.js':'SERVER_CODE_'.repeat(1100),'game.js':'GAME_CODE_'.repeat(2100)};let writes=0,reads=0,access=true;
 const revision=()=>createHash('sha256').update(JSON.stringify(files)).digest('hex');
 const listing=async()=>access?{ok:true,alvo_validacao:'fixture:app',revisao:revision(),arquivos:Object.entries(files).map(([caminho,s])=>({caminho,hash:hash(s)}))}:{ok:false};
 const tools=new ToolRegistry().add({name:'listar_arquivos_do_app',run:listing})
 .add({name:'ler_arquivo_do_app',repeatRevision:revision,run:async a=>{reads++;return {...filePage({content:files[a.caminho],hash:hash(files[a.caminho]),arquivo:a.caminho,bytes:files[a.caminho].length,inicio:a.inicio||0,limite:a.limite||6000,hash_esperado:a.hash_esperado}),alvo_validacao:'fixture:app',revisao:revision()}}})
 .add({name:'editar_arquivo_do_app',run:async()=>{writes++;files['server.js']+='\n// patched';return {ok:true,arquivo:'server.js',hash:hash(files['server.js']),alvo_validacao:'fixture:app',revisao:revision()}}})
 .add({name:'validar_rascunho_do_app',run:async()=>({ok:true,validacao:'aprovado',alvo_validacao:'fixture:app',revisao:revision()})});
 return {files,tools,listing,revision,get reads(){return reads},get writes(){return writes},revoke(){access=false}};
}
export const step=(calls,n)=>({stop:'tool',toolCalls:calls.map((x,i)=>({...x,id:`${n}:${i}`})),usage:{in:10,out:3}});
export const read=(f,path,start,size=6000)=>({name:'ler_arquivo_do_app',args:{caminho:path,inicio:start,limite:size,hash_esperado:hash(f.files[path])}});
export const options=(f,store,provider,extra={})=>({store,scope:'fixture',executionId:'job',mode:'edicao',objetivo:'Fix integration',userRequest:'Fix the code without publishing',tools:f.tools,provider,system:'Synthetic regression, no external systems',...extra});
