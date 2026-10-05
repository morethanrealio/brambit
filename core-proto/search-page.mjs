// Keep the small facts needed to continue a search when an old result is pruned.
// Erasing its cursor made workers replay earlier pages and forget located files.
const fieldsByTool = {
  drive_search: ['id','name','mimeType','modifiedTime','webViewLink','driveId','shortcutDetails'],
  onedrive_search: ['id','nome','tipo','tamanho','modificado','link'],
  slack_search: ['user','channel','text','text_truncated','ts','link'],
  github_search_repos: ['full_name','description','stars','language','url','private'],
  github_search_issues: ['number','title','state','author','comments','isPR','url','repo'],
};
const descriptiveFields = new Set(['name','nome','title','text','description']);

export function retainedSearchPage(text, tool) {
  const fields = fieldsByTool[tool];
  if(!fields)return null;
  let row;try{row=JSON.parse(text);}catch{return null;}
  if(!row?.search_id||!Array.isArray(row.items)||typeof row.partial!=='boolean')return null;
  const out={};
  for(const key of ['search_id','query','page','page_size','start_page','pages_completed','returned','reported_total','has_more','next_cursor','partial','incomplete_search','completion_reason','evidence_limited','retained_items'])if(row[key]!==undefined)out[key]=row[key];
  const limited = () => {out.evidence_limited=true;out.partial=true;out.completion_reason='evidence_limited';};
  out.items=row.items.map(item=>{
    const kept=Object.fromEntries(fields.filter(k=>item?.[k]!==undefined).map(k=>{
      let value=item[k];
      // IDs and links must stay exact. Only descriptive excerpts may be shortened,
      // and the coverage tracker must know when useful evidence was removed.
      if(descriptiveFields.has(k)&&typeof value==='string'&&value.length>1000){value=value.slice(0,1000);limited();}
      if(k==='shortcutDetails')value=Object.fromEntries(['targetId','targetMimeType','targetResourceKey'].filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
      return [k,value];
    }));
    if(tool==='slack_search'&&typeof item?.text==='string'&&item.text!==kept.text)kept.text_truncated=true;
    return kept;
  });
  out.note='Metadados e continuação preservados. Use o último next_cursor da cadeia; não volte a páginas anteriores. Não conclua ausência fora desta consulta.';
  if(out.evidence_limited)out.retained_items=out.items.length;
  while(JSON.stringify(out).length>16000&&out.items.length){out.items.pop();limited();out.retained_items=out.items.length;}
  return JSON.stringify(out);
}
