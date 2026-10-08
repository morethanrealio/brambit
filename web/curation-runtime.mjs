import { curationArticleKey, normalizeCurationSections, evaluateCuration } from './curation-policy.mjs';
import { ROUTINE_NO_NEWS } from './routine-delivery.mjs';
import { CURATION_EVIDENCE_CONTRACT, validateCurationEvidence } from './curation-evidence.mjs';
const plain=(v,max,label='texto',{empty=false}={})=>{
 if(typeof v!=='string'||(!empty&&!v.trim())||v.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))throw Error(`${label} inválido`);
 // Extra URLs don't sneak into the summary/author/title unnoticed.
 if(/https?:\/\/|www\./i.test(v))throw Error(`${label} contém URL`);
 const clean=v.replace(/[\r\n\t]+/g,' ').replace(/[<>`]/g,'').trim();
 if(!empty&&!clean)throw Error(`${label} inválido`);
 return clean;
};
const articleAuthor=(value,url)=>{
 try {return plain(value,160,'autor');}catch{return new URL(url).hostname.replace(/^www\./i,'');}
};
const safeCheckDetail=(_v,status,language)=>{
 // `detail` is auxiliary diagnostic info, not article content. A real case
 // generated 567/658 characters here; the old 400 ceiling dropped the whole
 // edition. We keep the status, but don't render the free-form prose: in the
 // simulation it said "2 items delivered" when the deterministic filter had
 // only accepted one.
 if(status==='complete')return '';
 const failed=status==='failed';
 return ({
  en:failed?'The search for this section failed; no unvalidated item was included':'I could not finish the search for this section; I kept only items checked against their sources',
  es:failed?'La búsqueda de esta sección falló; no se incluyó ningún elemento sin validar':'No pude terminar la búsqueda de esta sección; conservé solo los elementos comprobados en sus fuentes',
 })[language]||(failed?'A pesquisa desta seção falhou; nenhum item sem validação foi incluído':'Não consegui concluir a busca desta seção; mantive apenas os itens conferidos nas fontes');
};
// Providers that support tool use sometimes wrap the final JSON in a code
// fence, a <think> block or one short explanatory sentence even when asked for
// JSON only. Rejecting an otherwise valid manifest made the whole curation fail
// after the expensive search had already completed. Extract exactly one balanced
// JSON object and keep the existing field/link/source validation as the trust
// boundary; arbitrary prose is never rendered or delivered.
export function extractCurationManifest(text) {
 const raw=String(text??'').replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi,'').trim();
 if(!raw||raw.length>128000)throw Error('resposta inválida');
 const fenced=raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
 const source=fenced||raw;
 try{return JSON.parse(source);}catch{}
 let start=-1,depth=0,inString=false,escape=false;
 for(let i=0;i<source.length;i++){
  const ch=source[i];
  if(start<0){if(ch==='{'){start=i;depth=1;}continue;}
  if(inString){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')inString=false;continue;}
  if(ch==='"'){inString=true;continue;}
  if(ch==='{')depth++;
  else if(ch==='}'&&--depth===0){
   const candidate=source.slice(start,i+1);
   const tail=source.slice(i+1).trim();
   // A second object is ambiguous; one sentence/fence after the object is safe
   // to ignore because only the validated object is ever used.
   if(tail.includes('{'))throw Error('mais de um manifesto');
   return JSON.parse(candidate);
  }
 }
 throw Error('JSON ausente ou incompleto');
}
export function normalizeCurationConfig(raw) {
 if(![1,2].includes(raw?.version)||Object.keys(raw).some(k=>!['version','sections','excludeUrls','source','summaryBullets','includeWhy','language'].includes(k)))throw Error('Configuração de curadoria inválida.');
 if(raw.version===2&&(!['web','gmail'].includes(raw.source)||![1,2,3].includes(raw.summaryBullets)||typeof raw.includeWhy!=='boolean'||!['pt-BR','en','es'].includes(raw.language)))throw Error('Fonte/formato da curadoria inválidos.');
 const specs=normalizeCurationSections(raw.sections);
 const excludes=raw.excludeUrls??[];
 if(!Array.isArray(excludes)||excludes.length>200||excludes.some(u=>!curationArticleKey(u)))throw Error('Exclusões inválidas.');
 if(specs.reduce((n,s)=>n+s.max,0)>8)throw Error('Curadoria excede oito itens verificáveis.');
 return {version:raw.version,...(raw.version===2?{source:raw.source,summaryBullets:raw.summaryBullets,includeWhy:raw.includeWhy,language:raw.language}:{}),excludeUrls:[...new Set(excludes.map(curationArticleKey))],sections:specs.map((s,i)=>{
  const maxAgeDays=raw.sections[i].maxAgeDays??30;
  if(!Number.isInteger(maxAgeDays)||maxAgeDays<1||maxAgeDays>365)throw Error('Janela de publicação inválida.');
  return {...s,label:plain(raw.sections[i].label,120,'rótulo da seção'),maxAgeDays};
 })};
}
export function curationPrompt(config,history,now=new Date().toISOString()) {
 const c=normalizeCurationConfig(config);
 const today=new Date(String(now).slice(0,10)+'T00:00:00Z').getTime();
 if(!Number.isFinite(today))throw Error('Relógio inválido.');
 const intervals=c.sections.map(s=>({section:s.id,data_inicio:new Date(today-(s.maxAgeDays-1)*86400000).toISOString().slice(0,10),data_fim:new Date(today).toISOString().slice(0,10)}));
 const selection=c.source==='gmail'?'':`PLANO DE SELEÇÃO: the publication intervals are inclusive: ${JSON.stringify(intervals)}. Pass the section's data_inicio and data_fim in every buscar_web call, along with the topic; keep the interval when rephrasing the query. The search filter may reflect updates, so confirm the original publication on the page. Spread searches and readings across the sections before going deep on just one. In the results, prefer an individual article/post/abstract with a compatible date; open the direct link. Do not spend readings on homepages, indexes or categories when the search already offers individual pages. Discard, before opening, candidates whose observed date or identifier shows publication before the window (in arXiv IDs YYMM.*, the prefix gives the initial month; an update does not make the initial publication recent). Do not infer a date from the URL; if there is no eligible dated candidate, refine the search keeping the interval. Never fill the quantity with old material.\n`;
 return selection+`[STRUCTURED CURATION — output contract]\nCarry out the requested research. Deliver ONLY a JSON object with items and checks, with no surrounding markdown. Each item: {section,url,title,author,date,summary:[${c.summaryBullets||3} summaries],why${c.source==='gmail'?',sourceId (real id from gmail_read)':',dateQuote,sourceQuotes'}}. All text fields must be strings, never null; if the source does not give an author, use the publication name or domain. ${c.source==='gmail'?'Use ONLY the emails/newsletters from the Gmail account linked to the assistant. Read them with google/gmail_read. Without a public link, url must be https://mail.google.com/mail/u/0/#all/REAL_ID; never make up an ID. date is the date the message was received. Do not run a web search to replace Gmail.':CURATION_EVIDENCE_CONTRACT} Write in ${c.language||'pt-BR'}. ${c.includeWhy===false?'why must be empty; do not add impact that was not asked for.':''} date in YYYY-MM-DD; use only verified information, do not make anything up to meet minimums. Each checks entry: {section,status:"complete"|"partial"|"failed",detail}; detail may be "" only when status is complete. Declare partial/failed if any required search was incomplete. The section labels do NOT replace checking the requested sources, dates and content.\nSections: ${JSON.stringify(c.sections)}.\nURLs already delivered (do not repeat): ${JSON.stringify(history.map(r=>r.url).slice(0,200))}. The final filter considers the full history, not just these 200. Additional approved exclusions (they do not prove delivery): ${JSON.stringify(c.excludeUrls)}. Failures or lack of items must result in empty items and checks explaining the limitation. NEVER reply ${ROUTINE_NO_NEWS}: curations always return the JSON, even with nothing new. Do not announce sending/drafts.`;
}
export function curationRepairPrompt(config,diagnostic='') {
 const c=normalizeCurationConfig(config);
 return `[CURATION FORMAT CORRECTION]${diagnostic?'\nValidation of this attempt: '+String(diagnostic).slice(0,500):''}. Keep the valid items already gathered. For summary_quote_not_observed or summary_evidence_missing, copy one CONTIGUOUS, literal passage per bullet; shorten the summary to what that passage proves. Do not concatenate passages or insert ellipses that do not exist in the source.\nThe previous answer did not follow the structured contract. Without running new searches and using ONLY the sources already collected in this turn, re-emit the answer as ONE valid JSON object, with no markdown or surrounding text. Format: {"items":[{"section":"id","url":"https://...","title":"...","author":"...","date":"YYYY-MM-DD","summary":[${Array.from({length:c.summaryBullets||3},(_,i)=>`"summary ${i+1}"`).join(',')}],"why":"..."${c.source==='gmail'?',"sourceId":"real id"':',"dateQuote":"date as written in the publication","sourceQuotes":["one passage per summary"]'}}],"checks":[{"section":"id","status":"partial","detail":"..."}]}. All text fields must be strings, never null; if the source does not give an author, use the publication name or domain. In each check, status must be exactly "complete", "partial" or "failed"; detail may be "" only when status is complete. Include exactly one check for each section: ${JSON.stringify(c.sections.map(s=>s.id))}. Do not make up items to meet minimums. If the data already collected is not enough, use empty items or only the proven items and mark the affected checks as partial/failed, explaining the gap. ${c.source==='gmail'?'':CURATION_EVIDENCE_CONTRACT} NEVER reply ${ROUTINE_NO_NEWS}.`;
}
// A formatting retry must not throw away useful content already validated.
// Select one complete result; never merge model prose or weaken validation.
export function preferCurationRepair(original,repaired) {
 if(!repaired||!Array.isArray(repaired.urls))return original;
 const kept=new Set(repaired.urls.map(curationArticleKey));
 if((original?.urls||[]).some(url=>!kept.has(curationArticleKey(url))))return original;
 if(repaired.executionStatus==='failed')return original;
 return repaired;
}
export async function finalizeCuration({text,config,userId,routineId,history,partial=false,now=new Date().toISOString()},{checkLinks,checkMail,sourceEvidence}) {
 const c=normalizeCurationConfig(config),failure=(reason,failureCode='validation_failed',repairable=false,diagnostic='')=>({text:`Curadoria não concluída: ${reason}. Nenhum artigo foi confirmado como novo ou entregue.`,urls:[],coverageSatisfied:false,executionStatus:'failed',failureCode,repairable,...(diagnostic?{diagnostic}:{} )});
 if(String(text??'').trim()===ROUTINE_NO_NEWS)return failure('o assistente encerrou como “sem novidades”, mas esta rotina exige um relatório mesmo sem itens','unexpected_no_news_signal',true);
 let stage='manifest';
 try {
  const parsed=extractCurationManifest(text);
  if(!Array.isArray(parsed.items)||parsed.items.length>30||!Array.isArray(parsed.checks)||parsed.checks.length>40)throw Error('manifesto inválido');
  // A missing optional field or a bad candidate must not wipe out every valid
  // article from an expensive search. We validate each item in isolation,
  // omit only the invalid candidate, and force the report to come out as
  // partial. The author may be missing from the page; in that case the
  // verified hostname is a factual, deterministic source, not an invented
  // authorship.
  const rejectedItems=[],rejectedSections=new Set(),repairableEvidence=[];let missingWhyCount=0;
  const evidence=typeof sourceEvidence?.snapshot==='function'?sourceEvidence.snapshot():sourceEvidence;
  let items=parsed.items.flatMap((i,index)=>{
   try{
    if(!i||typeof i!=='object'||Array.isArray(i)||!curationArticleKey(i.url)||/[<>()[\]"'`]/.test(i.url))throw Error('link inválido');
    const u=new URL(i.url);
    // The legacy probe skips local destinations; never interpret that omission as OK.
    if(u.protocol!=='https:'||u.port||!u.hostname.includes('.')||/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i.test(u.hostname)||/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)||/\.(?:local|localhost|internal)$/i.test(u.hostname)||/[?&]X-Amz-Signature=/i.test(i.url)||(u.pathname==='/'&&!(c.source==='gmail'&&u.hostname==='mail.google.com')))throw Error('link não elegível');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(i.date||'')||!Number.isFinite(Date.parse(i.date))||new Date(i.date).toISOString().slice(0,10)!==i.date)throw Error('data inválida');
    if(!Array.isArray(i.summary)||i.summary.length!==(c.summaryBullets||3))throw Error('resumo inválido');
    const title=plain(i.title,240,'título');
    // Missing/oversized attribution is not a reason to discard an otherwise
    // useful article. Use the actual publication domain, never invented names.
    const author=articleAuthor(i.author,i.url);
    const why=c.includeWhy===false?'':typeof i.why==='string'&&i.why.trim()?plain(i.why,600,'justificativa'):(missingWhyCount++,'');
    const summary=i.summary.map((s,n)=>plain(s,700,`resumo ${n+1}`));
    const item={...i,title,author,why,summary};
    if(c.source!=='gmail'&&sourceEvidence!==undefined){
     const reason=validateCurationEvidence(item,evidence);
     if(reason){
      // One existing formatting pass can recover observed content whose quotes
      // were omitted/concatenated. It cannot waive provenance or add searches.
      const section=c.sections.find(s=>s.id===i.section);
      const age=(Date.parse(String(now).slice(0,10)+'T00:00:00Z')-Date.parse(i.date+'T00:00:00Z'))/86400000;
      if(['summary_evidence_missing','summary_quote_not_observed'].includes(reason)&&section&&age>=0&&age<section.maxAgeDays&&!c.excludeUrls.includes(curationArticleKey(i.url)))repairableEvidence.push(`item${index+1}:${reason}`);
      throw Error(reason);
     }
    }
    return [item];
   }catch(e){rejectedItems.push(`item${index+1}:${String(e?.message||e).slice(0,80)}`);rejectedSections.add(i?.section);return [];}
  });
  const checks=new Map(),rejectedChecks=[];
  for(const [index,row] of parsed.checks.entries()){
   try{
    if(!row||typeof row!=='object'||Array.isArray(row)||checks.has(row.section)||!c.sections.some(s=>s.id===row.section)||!['complete','partial','failed'].includes(row.status))throw Error('estrutura inválida');
    const detail=safeCheckDetail(row.detail,row.status,c.language);
    checks.set(row.section,{status:row.status,detail});
   }catch(e){rejectedChecks.push(`check${index+1}:${String(e?.message||e).slice(0,80)}`);}
  }
  stage='source';
  if(c.source==='gmail') {
   if(typeof checkMail!=='function')throw Error('Verificação Gmail indisponível');
   const verified=[];
   for(const i of items){
    if(!/^[a-f0-9]{8,40}$/i.test(i.sourceId||''))throw Error('ID Gmail inválido');
    const source=await checkMail(i.sourceId);
    if(!source||typeof source.body!=='string'||!source.body.trim()||!Number.isFinite(Date.parse(source.receivedAt)))throw Error('Fonte Gmail não lida');
    const privateUrl=`https://mail.google.com/mail/u/0/#all/${i.sourceId}`;
    if(i.url!==privateUrl&&!source.body.includes(i.url))throw Error('Link não consta da fonte Gmail');
    verified.push({...i,date:new Date(source.receivedAt).toISOString().slice(0,10),receivedAt:source.receivedAt});
   }
   items=verified;
  }
  const today=new Date(String(now).slice(0,10)+'T00:00:00Z').getTime();
  if(!Number.isFinite(today))throw Error('Relógio inválido.');
  const excluded=new Set(c.excludeUrls);
  const candidates=items.filter(i=>{const age=c.source==='gmail'?(Date.parse(now)-Date.parse(i.receivedAt))/86400000:(today-Date.parse(i.date+'T00:00:00Z'))/86400000;const s=c.sections.find(s=>s.id===i.section);return s && age>=0 && age<s.maxAgeDays && !excluded.has(curationArticleKey(i.url));});
  const first=evaluateCuration({userId,routineId,sections:c.sections,items:candidates,delivered:history,historyAvailable:true});
  if(first.state==='blocked')return failure('histórico indisponível','history_unavailable');
  // First removes duplicates; only then spends verification effort on up to 8 selected ones.
  const selected=first.accepted.map(a=>candidates[a.index]);
  const publicItems=selected.filter(i=>!(c.source==='gmail'&&i.url===`https://mail.google.com/mail/u/0/#all/${i.sourceId}`));
  stage='links';
  const probe=publicItems.length?await checkLinks(publicItems.map(i=>i.url).join('\n')):{checados:0,quebrados:[],indefinidos:[],naoChecados:[]};
  if(probe.checados!==new Set(publicItems.map(i=>i.url)).size) return failure('não foi possível conferir todos os links selecionados','link_check_incomplete');
  const bad=new Set([...probe.quebrados,...probe.indefinidos,...probe.naoChecados]);
  const unavailableSections=new Set(selected.filter(i=>bad.has(i.url)).map(i=>i.section));
  const kept=selected.filter(i=>!bad.has(i.url));
  const result=evaluateCuration({userId,routineId,sections:c.sections,items:kept,delivered:history,historyAvailable:true});
  const structuralPartial=rejectedItems.length>0||rejectedChecks.length>0||missingWhyCount>0||c.sections.some(s=>!checks.has(s.id));
  const incomplete=partial||evidence?.limited===true||structuralPartial||!result.coverageSatisfied||c.sections.some(s=>checks.get(s.id)?.status!=='complete');
  // Useful content leads. Missing sections get one plain explanation, while
  // candidate counts, discarded fields and link diagnostics stay in the audit.
  const lines=[],notes=[];
  for(const s of result.coverage){
   const label=c.sections.find(c=>c.id===s.id).label;
   const accepted=result.accepted.filter(a=>a.section===s.id);
   const searchStatus=checks.get(s.id)?.status;
   if(!accepted.length){
    // Search failure is not evidence that nothing new exists. Keep useful
    // sections first and explain each gap once, without empty headings.
    notes.push(searchStatus==='failed'||searchStatus==='partial'||!searchStatus||rejectedSections.has(s.id)||unavailableSections.has(s.id)
     ? `${label}: não consegui concluir a pesquisa com conteúdo suficiente para esta edição.`
     : `${label}: nenhum conteúdo novo qualificado nesta edição.`);
    continue;
   }
   lines.push(`## ${label}`);
   for(const a of accepted){
    const i=kept[a.index];lines.push(`${i.title}\nAutor/Fonte: ${i.author}\n${c.source==='gmail'?'Recebido em':'Data de publicação'}: ${i.date}\n${i.url}\n${i.summary.map(s=>'- '+s).join('\n')}${c.includeWhy===false||!i.why?'':'\nPor que importa: '+i.why}`);
   }
   if(s.missing>0)notes.push(`${label}: consegui validar ${s.count} de ${s.min} itens solicitados.`);
  }
  if(incomplete&&!notes.length)notes.push('A pesquisa ficou incompleta; esta edição inclui somente o conteúdo que consegui validar.');
  if(notes.length)lines.push(notes.join('\n'));
  if(!lines.length)lines.push('Nenhum conteúdo novo qualificado nesta edição.');
  const structuralDiagnostic=structuralPartial?[...rejectedItems,...rejectedChecks,...(missingWhyCount?['why:missing']:[]),...c.sections.filter(s=>!checks.has(s.id)).map(s=>`check:${s.id}:missing`)].join(',').slice(0,500):'';
  const allSearchesFailed=!result.accepted.length&&c.sections.every(s=>checks.get(s.id)?.status==='failed');
  const audit={version:1,status:allSearchesFailed?'failed':incomplete?'partial':'complete',generatedCandidates:parsed.items.length,validCandidates:items.length,acceptedBySection:result.coverage.map(s=>({section:s.id,accepted:s.count,requestedMin:s.min,requestedMax:s.max,searchStatus:checks.get(s.id)?.status||'missing'})),discarded:{invalidFields:rejectedItems.length,windowSectionOrExclusion:Math.max(0,items.length-candidates.length),duplicateSectionOrLimit:first.rejected.length,linkCheck:bad.size,invalidChecks:rejectedChecks.length,missingWhy:missingWhyCount},executionHadToolLimit:!!partial,...(sourceEvidence!==undefined?{observedWebSources:evidence?.sources?.length||0,evidenceLimitReached:evidence?.limited===true}:{})};
  return {text:lines.join('\n\n'),urls:result.accepted.map(a=>kept[a.index].url),coverageSatisfied:!incomplete,executionStatus:allSearchesFailed?'failed':incomplete?'partial':'completed',repairable:repairableEvidence.length>0,...(repairableEvidence.length?{failureCode:'evidence_format'}:{}),audit,...(structuralDiagnostic?{diagnostic:structuralDiagnostic}:{})};
 } catch(e) {const diagnostic=`${stage}:${String(e?.message||e).slice(0,120)}`;return stage==='manifest'
   ? failure('a resposta do assistente não veio no formato estruturado exigido','invalid_manifest',true,diagnostic)
   : failure('resposta estruturada, histórico ou conferência de links inválidos',stage==='links'?'link_validation_failed':'source_validation_failed',false,diagnostic);}
}
