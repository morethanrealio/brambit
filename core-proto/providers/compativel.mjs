import {wrapProvider,providerAttempt,throwIfAttemptControl,chatAttemptUsage} from '../provider-attempt.mjs';
import {STOP} from '../provider.mjs';
import {parseGlmToolCalls,parseDsmlToolCalls,stripDsml,hasDsmlResidue} from './ferramenta-em-texto.mjs';
import {validarChamadas,mensagemProtocolo,comRetentativa} from './regras.mjs';
// ── Single engine for any OpenAI-compatible provider ──
// Together, DeepInfra, OpenAI, Nemotron and any address from modelos.yaml speak
// the same protocol: POST /chat/completions with a Bearer key. What changes between
// them is configuration (address, key, body fields) and MODEL quirks
// (writing the tool call as text, reasoning until it exhausts the output). Each
// adapter (together.mjs, deepinfra.mjs, openai.mjs, nemotron.mjs) became just a
// preset of these options, with the SAME signature as before.
//
//   provedor            name in the logs, in the HTTP error and in the provider's name
//   url, chave          null key = provider with no key (no auth header)
//   campos(comTools)    body fields after model/messages, in order
//   camposDiretos()     fields for retries with reasoning turned off
//   limiteTools         { max, aviso(n) }: trims the tool list
//   extras              merged into the body last
//   visao               false = images don't become image_url parts
//   stream               { inatividadeMs, diagnosticoRecusa } = SSE transport
//   contarEntrada       input estimate for credit reservation
//   limparTexto         strips reasoning from the final text (Nemotron)
//   usoSemCache         provider that doesn't report cache: logs it and records cached 0
//   cortePorTeto        finish 'length' becomes protocolError (default true)
//   ferramentaEmTexto   'sempre' | 'comTools' | false: recovers GLM/DSML from the text
//   reamostrarResiduo   reasoning-less re-samples when there's leftover residue (Together)
//   residuoGlmLanca     GLM residue in the final text throws (DeepInfra)
//   vazioSemUsoLanca    empty response AND no measured usage throws (Together)
//   retryVazio          'completo' | 'simples' | false: redoes an empty response
//   erroSemUrl          message when the address wasn't configured
//   semProntidao        doesn't report readiness to the credit layer (own server)
//
// Common rules (regras.mjs), the same for everyone: malformed call (broken JSON,
// missing/duplicate id) refuses the whole batch without executing anything; a name outside the
// catalog passes through and the core warns the model; a transient refusal (429/5xx) retries.

const GLM_RESIDUO=/<tool_call>|<\/?arg_key>|<\/?arg_value>/;
const temGlm=s=>GLM_RESIDUO.test(String(s??''));
const temResiduo=s=>temGlm(s)||hasDsmlResidue(s);

export function makeCompativel({
  provedor,model,url,chave,
  campos,camposDiretos,limiteTools,extras,visao=true,
  stream,contarEntrada,
  limparTexto=s=>s||'',usoSemCache=false,cortePorTeto=true,
  ferramentaEmTexto=false,reamostrarResiduo=0,residuoGlmLanca=false,vazioSemUsoLanca=false,retryVazio=false,
  erroSemUrl,semProntidao=false,
}){
  const chamar=body=>stream?chamarStream(body,{provedor,url,chave,contarEntrada,semProntidao,stream})
    :chamarJson(body,{provedor,url,chave,contarEntrada,semProntidao});
  const lerUso=data=>usoDe(data,model,provedor,usoSemCache);
  return wrapProvider({
    name:`${provedor}:${model}`,
    async complete({system,messages,tools}){
      if(!url&&erroSemUrl)throw new Error(erroSemUrl);
      const omsgs=mensagens(system,messages,visao);
      const body={model,messages:omsgs,...campos(!!tools?.length)};
      if(tools?.length){
        let ts=tools;
        if(limiteTools&&ts.length>limiteTools.max){console.error(limiteTools.aviso(ts.length));ts=ts.slice(0,limiteTools.max);}
        body.tools=ts.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}));
        body.tool_choice='auto';
      }
      if(extras)Object.assign(body,extras);

      const data=await chamar(body);
      let usage=lerUso(data);
      try{return await interpretar(data);}
      catch(e){
        if(!(e instanceof Recusa))throw e;
        return {stop:STOP.END,usage,text:mensagemProtocolo(e.code),protocolError:{code:e.code,retryable:true}};
      }
      async function interpretar(data){
        const lote=(toolCalls,text)=>({stop:STOP.TOOL,toolCalls:conferir(toolCalls),text:text||undefined,usage});
        const pendente=data?.creditReconciliationPending===true;
        const msg=data.choices?.[0]?.message??{};
        const finish=data.choices?.[0]?.finish_reason;
        if(cortePorTeto&&finish==='length')return {stop:STOP.END,usage,protocolError:{code:'output_truncated',retryable:true},text:''};

        let toolCalls=estruturadas(msg);
        let text=limparTexto(msg.content);
        if(ferramentaEmTexto==='sempre'||(ferramentaEmTexto==='comTools'&&tools?.length))
          ({toolCalls,text}=recuperar(toolCalls,text,provedor));

        // Call residue that the reader couldn't recover (e.g.: just loose
        // <arg_key>/<arg_value> pairs, with no function name): re-samples on the same
        // model with reasoning turned off, which tends to fill in tool_calls. If it doesn't
        // resolve, THROWS, so the fallback chain takes over; residue never goes to the
        // user (instalar_skill bug, 2026-08-14).
        if(reamostrarResiduo&&!toolCalls.length&&tools?.length&&temResiduo(text)&&!pendente){
          for(let i=0;i<reamostrarResiduo&&!toolCalls.length;i++){
            console.log(`[${provedor} malformed-toolcall] resíduo sem chamada estruturada; retry ${i+1}/${reamostrarResiduo} sem raciocínio`);
            try{
              const d=await chamar({model,messages:omsgs,...camposDiretos(),tools:body.tools,tool_choice:'auto'});
              usage=somarUso(usage,lerUso(d));
              const rm=d.choices?.[0]?.message??{};
              const r=recuperar(estruturadas(rm),rm.content||'');
              if(r.toolCalls.length){toolCalls=r.toolCalls;text=r.text;}
              else if(!temResiduo(r.text)){text=r.text;break;}
            }catch(e){
              throwIfAttemptControl(e);
              if(e instanceof Recusa)throw e;
              console.log(`[${provedor} malformed-toolcall] retry ${i+1}/${reamostrarResiduo} falhou: ${e.message}`);
              continue;
            }
          }
          if(!toolCalls.length&&temResiduo(text))throw new Error(`${provedor}: tool-call malformada não recuperável após ${reamostrarResiduo} re-amostragens`);
        }
        if(reamostrarResiduo&&pendente&&!toolCalls.length&&temResiduo(text))text='';
        // Stream that ended without the usage trailer AND without anything usable. The
        // credit layer already stored the exact response and kept the reservation, so throwing here
        // doesn't repeat the physical request: the fallback chain can proceed, and a
        // restart reuses the same bytes and reaches the same decision. With text or
        // a call, it doesn't throw: the output can only be consumed once.
        if(vazioSemUsoLanca&&pendente&&!toolCalls.length&&!text.trim()){
          const meta=data?._streamMeta||{};
          console.error(`[${provedor} unusable unmetered]`,JSON.stringify({
            model,finish:finish??null,
            chunks:meta.chunks??null,events:meta.events??null,
            done:meta.done??null,reasoningChars:meta.reasoningChars??null,
            unknownDeltaKeys:Array.isArray(meta.unknownDeltaKeys)?meta.unknownDeltaKeys:[],
            responseId:meta.responseId||null,
          }));
          const error=new Error(`${provedor}: resposta sem conteúdo, ação, conclusão ou uso`);
          error.code='PROVIDER_UNUSABLE_UNMETERED_RESPONSE';
          error.providerResponseUnusable=true;
          throw error;
        }
        if(toolCalls.length)return lote(toolCalls,text);

        // Empty response (typically reasoning consumed the entire output cap):
        // redoes without reasoning and without tools. Never deliver empty (bug from the
        // 2026-07-02 case). 'completo' still recovers the action written as text (Naval
        // Strike case: the retry brought back `<｜DSML｜ invoke ...>`) and measures the cache.
        if(retryVazio&&!text.trim()&&!pendente){
          console.log(`[${provedor} empty] finish=${finish} out=${usage.out}; retry sem raciocínio`);
          try{
            const d2=await chamar({model,messages:omsgs,...camposDiretos()});
            const m2=d2.choices?.[0]?.message??{};
            const t2=m2.content||'';
            if(retryVazio==='simples'){
              const u2=d2.usage??{};
              usage.in+=u2.prompt_tokens??0;usage.out+=u2.completion_tokens??0;usage.total+=u2.total_tokens??0;
              if(t2.trim())text=t2;
            }else{
              usage=somarUso(usage,lerUso(d2));
              let tc2=estruturadas(m2);
              if(!tc2.length&&t2.includes('<tool_call>'))tc2=parseGlmToolCalls(t2);
              if(!tc2.length&&hasDsmlResidue(t2))tc2=parseDsmlToolCalls(t2);
              if(tc2.length){toolCalls=tc2;text=hasDsmlResidue(t2)?stripDsml(t2):t2.split('<tool_call>')[0].trim();}
              else if(t2.trim())text=t2;
            }
          }catch(e){
            throwIfAttemptControl(e);
            if(e instanceof Recusa)throw e;
            console.log(`[${provedor} empty] retry falhou: ${e.message}`);
          }
        }
        if(toolCalls.length)return lote(toolCalls,text);
        // Last barrier: no call residue goes out as a final response.
        if(reamostrarResiduo&&temResiduo(text))throw new Error(`${provedor}: resíduo de tool-call não recuperável após retry vazio`);
        if(residuoGlmLanca&&tools?.length&&temGlm(text)){
          if(pendente)text='';
          else throw new Error(`${provedor}: tool-call malformada (GLM vazou como texto)`);
        }
        return {stop:STOP.END,text,usage};
      }
    },
  });
}

// Msg[] -> formato OpenAI Chat Completions.
function mensagens(system,messages,visao){
  const omsgs=[];
  if(system)omsgs.push({role:'system',content:system});
  for(const m of messages){
    if(m.role==='tool')omsgs.push({role:'tool',tool_call_id:m.toolCallId,content:m.content});
    else if(m.role==='assistant'&&m.toolCalls?.length)omsgs.push({
      role:'assistant',content:m.content||null,
      tool_calls:m.toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}})),
    });
    else if(visao&&m.images?.length){
      // Vision: content becomes an array with the text + each image as a data URL.
      const parts=[];
      if(m.content)parts.push({type:'text',text:m.content});
      for(const im of m.images)if(im?.data)parts.push({type:'image_url',image_url:{url:`data:${im.mimeType||'image/jpeg'};base64,${im.data}`}});
      omsgs.push({role:m.role==='assistant'?'assistant':'user',content:parts});
    }else omsgs.push({role:m.role,content:m.content});
  }
  return omsgs;
}

// Batch refused by a common rule: becomes protocolError, nothing is executed.
class Recusa{constructor(code){this.code=code;}}
function estruturadas(msg){
  const v=validarChamadas(msg.tool_calls);
  if(v.code)throw new Recusa(v.code);
  return v.calls;
}
// Call recovered from the text goes through the SAME rules (name offered, unique id).
function conferir(calls){
  const v=validarChamadas(calls.map(c=>({id:c.id,function:{name:c.name,arguments:c.args}})));
  if(v.code)throw new Recusa(v.code);
  return v.calls;
}

// Call that came written in the text, in both dialects (GLM and DeepSeek's DSML).
// Preserves the text that came BEFORE the marking. With `provedor`, logs the recovery.
function recuperar(toolCalls,text,provedor){
  if(!toolCalls.length&&text.includes('<tool_call>')){
    const p=parseGlmToolCalls(text);
    if(p.length){toolCalls=p;text=text.split('<tool_call>')[0].trim();}
  }
  if(!toolCalls.length&&hasDsmlResidue(text)){
    const p=parseDsmlToolCalls(text);
    if(p.length){
      if(provedor)console.log(`[${provedor} dsml-toolcall] recuperei ${p.length} chamada(s) do formato nativo do DeepSeek`);
      toolCalls=p;text=stripDsml(text);
    }
  }
  return {toolCalls,text};
}

// completion_tokens already includes reasoning: think=0 (don't add it again to the cost).
function usoDe(data,model,provedor,semCache){
  const u=data.usage??{};
  const inTok=u.prompt_tokens??0;
  const outTok=u.completion_tokens??0;
  const total=u.total_tokens??(inTok+outTok);
  if(semCache){
    console.log(`[${provedor} cost] model=${model} in=${inTok} out=${outTok} total=${total}`);
    return {model,in:inTok,cached:0,out:outTok,think:0,total};
  }
  const cached=u.prompt_tokens_details?.cached_tokens??0;
  const reason=u.completion_tokens_details?.reasoning_tokens??0;
  console.log(`[${provedor} cost] model=${model} in=${inTok} cached=${cached} out=${outTok} reason=${reason} total=${total}`);
  return {model,in:inTok,cached,out:outTok,think:0,total};
}
const somarUso=(a,b)=>({model:a.model,in:a.in+b.in,cached:a.cached+b.cached,out:a.out+b.out,think:0,total:a.total+b.total});

// One invocation of providerAttempt = ONE physical request (the credit layer
// counts each one). null key = provider with no key: no auth and always ready;
// semProntidao = doesn't even report readiness (the observer treats absence as ready).
function tentativa(body,{provedor,chave,contarEntrada,semProntidao},dispatch){
  return providerAttempt({provider:provedor,model:body.model,body,
    ...(semProntidao?{}:{ready:()=>chave===null||!!chave}),
    ...(contarEntrada?{countInput:contarEntrada}:{}),
    readUsage:data=>chatAttemptUsage(data,body.model)},dispatch);
}
function cabecalhos(chave){
  const headers={'content-type':'application/json'};
  if(chave)headers.authorization='Bearer '+chave;
  return headers;
}
function recusa(provedor,status){
  const e=new Error(provedor+' HTTP '+status);e.httpStatus=status;e.providerRejected=true;return e;
}

function chamarJson(body,cfg){
  return comRetentativa(()=>tentativa(body,cfg,async wire=>{
    const res=await fetch(cfg.url,{method:'POST',headers:cabecalhos(cfg.chave),body:JSON.stringify(wire)});
    if(!res.ok)throw recusa(cfg.provedor,res.status);
    return res.json();
  }));
}

// Streaming with an INACTIVITY timeout (not total request time): the timer rearms
// with every chunk received, so a legitimately long reply is never cut, only a hung
// connection.
function chamarStream(body,{provedor,url,chave,contarEntrada,semProntidao,stream}){
  const streamBody={...body,stream:true,stream_options:{include_usage:true}};
  return comRetentativa(()=>tentativa(streamBody,{provedor,chave,contarEntrada,semProntidao},async wire=>{
    const ctrl=new AbortController();let watchdog;
    const arm=()=>{clearTimeout(watchdog);watchdog=setTimeout(()=>ctrl.abort(Object.assign(new Error(provedor+' idle'),{code:'PROVIDER_IDLE_TIMEOUT'})),stream.inatividadeMs);};
    try{
      arm();
      const res=await fetch(url,{method:'POST',headers:cabecalhos(chave),body:JSON.stringify(wire),signal:ctrl.signal});
      if(!res.ok){
        if(stream.diagnosticoRecusa){const diagnostic=await stream.diagnosticoRecusa(res);console.error(`[${provedor} rejection]`,JSON.stringify({status:res.status,model:body.model,...diagnostic}));}
        throw recusa(provedor,res.status);
      }
      return await lerStream(res.body,arm);
    }catch(error){if(ctrl.signal.aborted&&ctrl.signal.reason?.code==='PROVIDER_IDLE_TIMEOUT')throw ctrl.signal.reason;throw error;}finally{clearTimeout(watchdog);}
  }));
}

// Consumes the SSE and rebuilds the non-stream format (choices[0].message + usage), so
// the rest of the engine doesn't depend on the transport. `onChunk` rearms the watchdog.
async function lerStream(body,onChunk){
  const reader=body.getReader();
  const decoder=new TextDecoder();
  let buf='',content='',finish=null,usage=null;
  let chunks=0,events=0,doneMarker=false,reasoningChars=0,responseId=null;
  const unknownDeltaKeys=new Set();
  const toolAcc={}; // index -> { id, name, args (string acumulada) }
  for(;;){
    const {value,done}=await reader.read();
    if(done)break;
    chunks++;
    if(onChunk)onChunk();
    buf+=decoder.decode(value,{stream:true});
    let nl;
    while((nl=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,nl).trim();
      buf=buf.slice(nl+1);
      if(!line.startsWith('data:'))continue;
      const payload=line.slice(5).trim();
      if(payload==='[DONE]'){doneMarker=true;continue;}
      let j;try{j=JSON.parse(payload);}catch{continue;}
      events++;
      if(!responseId&&typeof j.id==='string')responseId=j.id.slice(0,200);
      if(j.usage)usage=j.usage;
      const ch=j.choices?.[0];
      if(!ch)continue;
      if(ch.finish_reason)finish=ch.finish_reason;
      const d=ch.delta||{};
      if(d.content)content+=d.content;
      if(typeof d.reasoning_content==='string')reasoningChars+=d.reasoning_content.length;
      for(const key of Object.keys(d))if(!['role','content','reasoning_content','tool_calls'].includes(key)&&unknownDeltaKeys.size<20)unknownDeltaKeys.add(key);
      if(d.tool_calls)for(const tc of d.tool_calls){
        const i=tc.index??0;
        const slot=toolAcc[i]||(toolAcc[i]={id:tc.id,name:'',args:''});
        if(tc.id)slot.id=tc.id;
        if(tc.function?.name)slot.name+=tc.function.name;
        if(tc.function?.arguments)slot.args+=tc.function.arguments;
      }
    }
  }
  const tool_calls=Object.keys(toolAcc).sort((a,b)=>a-b).map(i=>({
    id:toolAcc[i].id,type:'function',
    function:{name:toolAcc[i].name,arguments:toolAcc[i].args},
  }));
  return {
    choices:[{message:{content,tool_calls:tool_calls.length?tool_calls:undefined},finish_reason:finish}],
    usage:usage||{},
    // Metadata only: enough to diagnose protocol drift without storing
    // raw SSE frames or reasoning text in checkpoint/log.
    _streamMeta:{chunks,events,done:doneMarker,reasoningChars,unknownDeltaKeys:[...unknownDeltaKeys],responseId},
  };
}
