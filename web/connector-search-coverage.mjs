const services={drive_search:'Drive',onedrive_search:'OneDrive',slack_search:'Slack',github_search_repos:'GitHub',github_search_issues:'GitHub',calendar_list:'Google Agenda',outlook_calendar_list:'Outlook Agenda'};
const clean=value=>String(value||'').replace(/[\r\n\[\]<>]/g,' ').slice(0,150);
export function guardConnectorSearchClaims(text, {partial=false,language='pt-BR'}={}) {
  if(!partial)return String(text??'');
  const replacement=/^en/.test(language)?'These are the results I could check.':/^es/.test(language)?'Estos son los resultados que pude revisar.':'Estes são os resultados que consegui consultar.';
  const unsupported=/^\s*(?:(?:portanto|também|tambem|então|entao)[,:]?\s+)?(?:lista completa(?=[\s.!?:]|$)|(?:esta|essa|a) (?:é a )?(?:lista|busca|consulta) (?:completa|exaustiva)(?=[\s.!?:]|$)|n[aã]o (?:h[aá]|existe[m]?|tem)\s+(?:(?:uma?|nenhuma?|qualquer)\s+)?(?:arquiv[oa]s?|planilhas?)(?=[\s.!?:]|$)|nenhum[a]?\s+(?:arquiv[oa]s?|planilhas?)\s+(?:existe|foi encontrad[oa])|n[aã]o vi nada compartilhado|(?:complete|exhaustive) (?:list|search)|(?:there (?:is|are) no|no hay)\s+(?:files?|archivos?|spreadsheets?))/i;
  return String(text??'').split('\n').map(line=>{
    if(/^\s*(?:>|```)/.test(line))return line;
    return line.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú])/).map(sentence=>unsupported.test(sentence.replace(/\[[^\]]*\]\(https?:\/\/[^\s)]+\)/g,'FONTE'))?replacement:sentence).filter((v,i,a)=>!i||v!==a[i-1]).join(' ');
  }).join('\n');
}
export const SEARCH_FALLBACK={
  'pt-BR':'Não consegui concluir parte da busca; pode haver outros resultados.',
  en:'I could not finish part of the search; there may be other results.',
  es:'No pude terminar parte de la búsqueda; puede haber otros resultados.',
};
export function connectorSearchLimitations(rows,language='pt-BR') {
  const lang=String(language).startsWith('en')?'en':String(language).startsWith('es')?'es':'pt-BR';
  const groups=new Map();
  for(const row of rows)if(row.status!=='complete'){
    const service=services[row.tool]||'conector',key=service+'\0'+(row.account||'');
    if(!groups.has(key))groups.set(key,{service,account:row.account,reasons:new Set()});
    groups.get(key).reasons.add(row.reason||'search_incomplete');
  }
  return [...groups.values()].map(({service,account,reasons})=>{
    const where=clean(service)+(account?` (${clean(account)})`:''),failed=reasons.has('query_failed')||reasons.has('page_failed');
    const pages=[...reasons].some(r=>['more_pages','page_limit'].includes(r));
    const analysis=reasons.has('evidence_limited');
    const incomplete=[...reasons].some(r=>!['query_failed','page_failed','more_pages','page_limit','evidence_limited'].includes(r));
    const phrases=lang==='en'?[failed&&'I could not complete a query',pages&&'some results remain to be checked',analysis&&'part of the results could not be included in the analysis',incomplete&&'the service did not return the complete search']:
      lang==='es'?[failed&&'no pude completar una consulta',pages&&'quedan resultados por revisar',analysis&&'parte de los resultados quedó fuera del análisis',incomplete&&'el servicio no devolvió la búsqueda completa']:
      [failed&&'não consegui concluir uma consulta',pages&&'ainda há resultados por conferir',analysis&&'parte dos resultados ficou fora da análise',incomplete&&'o serviço não devolveu a consulta completa'];
    return `${where}: ${phrases.filter(Boolean).join('; ')}.`;
  });
}
export function findConnectorSearchLimitations(text) {
  return String(text||'').split(/\n\s*\n/).map(p=>p.trim()).filter(p=>Object.values(SEARCH_FALLBACK).includes(p)||/^(?:Drive|OneDrive|Slack|GitHub|Google Agenda|Outlook Agenda|conector)(?: \([^\n]{1,150}\))?: (?:parte dos resultados ficou fora da análise|part of the results could not be included in the analysis|parte de los resultados quedó fuera del análisis|não consegui concluir uma consulta|ainda há resultados por conferir|o serviço não devolveu a consulta completa|I could not complete a query|some results remain to be checked|the service did not return the complete search|no pude completar una consulta|quedan resultados por revisar|el servicio no devolvió la búsqueda completa)[^\n]*\.$/.test(p));
}
