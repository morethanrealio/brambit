import {wrapProvider,providerAttempt,throwIfAttemptControl,chatAttemptUsage} from '../provider-attempt.mjs';
import {STOP} from '../provider.mjs';
import {parseGlmToolCalls,parseDsmlToolCalls,stripDsml,hasDsmlResidue} from './ferramenta-em-texto.mjs';
import {validarChamadas,mensagemProtocolo,comRetentativa} from './regras.mjs';
// ── Motor único pra qualquer provedor compatível com OpenAI ──
// Together, DeepInfra, OpenAI, Nemotron e qualquer endereço do modelos.yaml falam
// o mesmo protocolo: POST /chat/completions com chave Bearer. O que muda entre
// eles é configuração (endereço, chave, campos do corpo) e manias de MODELO
// (escrever a ferramenta como texto, raciocinar até esgotar a saída). Cada
// adaptador (together.mjs, deepinfra.mjs, openai.mjs, nemotron.mjs) virou só uma
// predefinição destas opções, com a MESMA assinatura de antes.
//
//   provedor            nome nos logs, no erro HTTP e no nome do provider
//   url, chave          chave null = provedor sem chave (sem cabeçalho de auth)
//   campos(comTools)    campos do corpo depois de model/messages, na ordem
//   camposDiretos()     campos das novas tentativas com o raciocínio desligado
//   limiteTools         { max, aviso(n) }: corta a lista de ferramentas
//   extras              mesclados no corpo por último
//   visao               false = imagens não viram partes image_url
//   stream              { inatividadeMs, diagnosticoRecusa } = transporte SSE
//   contarEntrada       estimativa de entrada pra reserva de crédito
//   limparTexto         tira raciocínio do texto final (Nemotron)
//   usoSemCache         provedor que não informa cache: loga e grava cached 0
//   cortePorTeto        finish 'length' vira protocolError (default true)
//   ferramentaEmTexto   'sempre' | 'comTools' | false: recupera GLM/DSML do texto
//   reamostrarResiduo   re-amostragens sem raciocínio quando sobra resíduo (Together)
//   residuoGlmLanca     resíduo GLM no texto final lança (DeepInfra)
//   vazioSemUsoLanca    resposta vazia E sem uso medido lança (Together)
//   retryVazio          'completo' | 'simples' | false: refaz resposta vazia
//   erroSemUrl          mensagem quando o endereço não foi configurado
//   semProntidao        não informa prontidão à camada de crédito (servidor próprio)
//
// Regras comuns (regras.mjs), iguais pra todos: chamada malformada (JSON quebrado,
// id faltando/repetido) recusa o lote sem executar nada; nome fora do catálogo
// passa e o core avisa o modelo; recusa passageira (429/5xx) tenta de novo.

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

        // Resíduo de chamada que o leitor não conseguiu recuperar (ex.: só os
        // <arg_key>/<arg_value> soltos, sem nome de função): re-amostra no próprio
        // modelo com o raciocínio desligado, que tende a preencher tool_calls. Se não
        // resolver, LANÇA, pra cadeia de fallback assumir; resíduo nunca vai pro
        // usuário (bug do instalar_skill, 14/08).
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
        // Stream que terminou sem o trailer de uso E sem nada utilizável. A camada de
        // crédito já guardou a resposta exata e manteve a reserva, então lançar aqui
        // não repete a requisição física: a cadeia de fallback pode seguir, e um
        // restart reaproveita os mesmos bytes e chega na mesma decisão. Com texto ou
        // chamada, não lança: a saída pode ser consumida uma vez só.
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

        // Resposta vazia (tipicamente o raciocínio consumiu todo o teto de saída):
        // refaz sem raciocínio e sem ferramentas. Nunca entregar vazio (bug do
        // caso de 02/07). 'completo' ainda recupera a ação escrita como texto (caso
        // Naval Strike: o retry trouxe `<｜DSML｜ invoke ...>`) e mede o cache.
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
        // Última barreira: nenhum resíduo de chamada sai como resposta final.
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
      // Visão: content vira array com o texto + cada imagem como data URL.
      const parts=[];
      if(m.content)parts.push({type:'text',text:m.content});
      for(const im of m.images)if(im?.data)parts.push({type:'image_url',image_url:{url:`data:${im.mimeType||'image/jpeg'};base64,${im.data}`}});
      omsgs.push({role:m.role==='assistant'?'assistant':'user',content:parts});
    }else omsgs.push({role:m.role,content:m.content});
  }
  return omsgs;
}

// Lote recusado por regra comum: vira protocolError, nada é executado.
class Recusa{constructor(code){this.code=code;}}
function estruturadas(msg){
  const v=validarChamadas(msg.tool_calls);
  if(v.code)throw new Recusa(v.code);
  return v.calls;
}
// Chamada recuperada do texto passa pelas MESMAS regras (nome oferecido, id único).
function conferir(calls){
  const v=validarChamadas(calls.map(c=>({id:c.id,function:{name:c.name,arguments:c.args}})));
  if(v.code)throw new Recusa(v.code);
  return v.calls;
}

// Chamada que veio escrita no texto, nos dois dialetos (GLM e DSML do DeepSeek).
// Preserva o texto que veio ANTES da marcação. Com `provedor`, loga a recuperação.
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

// completion_tokens já inclui o raciocínio: think=0 (não somar de novo no custo).
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

// Uma invocação de providerAttempt = UMA requisição física (a camada de crédito
// conta cada uma). chave null = provedor sem chave: sem auth e sempre pronto;
// semProntidao = nem informa prontidão (o observador trata ausência como pronto).
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

// Streaming com timeout de INATIVIDADE (não de request total): o cronômetro rearma
// a cada pedaço recebido, então resposta longa legítima nunca é cortada, só conexão
// pendurada.
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

// Consome o SSE e reconstrói o formato non-stream (choices[0].message + usage), pra
// o resto do motor não depender do transporte. `onChunk` rearma o watchdog.
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
    // Só metadado: o bastante pra diagnosticar deriva de protocolo sem guardar
    // frames SSE crus nem texto de raciocínio em checkpoint/log.
    _streamMeta:{chunks,events,done:doneMarker,reasoningChars,unknownDeltaKeys:[...unknownDeltaKeys],responseId},
  };
}
