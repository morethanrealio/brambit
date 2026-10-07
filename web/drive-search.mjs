// Model arguments are values, not Drive query syntax. The adapter owns escaping
// and filters, so a failed filter can never masquerade as a successful empty search.
const types = {
  spreadsheet: ['application/vnd.google-apps.spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.ms-excel.sheet.macroEnabled.12', 'text/csv'],
  document: ['application/vnd.google-apps.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  pdf: ['application/pdf'], folder: ['application/vnd.google-apps.folder'],
};
const quote = value => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
export const DRIVE_SEARCH_RULE = 'To locate a file, start with the name (search_in=name) and the requested type (file_type=spreadsheet for spreadsheets), using short terms in terms as alternatives. The search includes shared Drives accessible to the account. Do not use Google/Gmail/SQL syntax in query: filters have their own fields. If you do not find it by name, search the content while keeping the type. Only broaden to all types if there is a reason. complete=true completes the bounded query within the limit; do not sweep the whole Drive. A located file does not require a complete inventory. Do not claim absence beyond the completed queries. Deliver the real name and link; do not open sensitive content unless needed to identify the file.';
export const driveSearchParameters = {
  type: 'object', properties: {
    query: { type: 'string', description: 'One literal term or name, without operators. Omit when using terms or listing by type.' },
    terms: { type: 'array', maxItems: 8, items: {type:'string'}, description: 'Alternative terms (OR), for example ["férias","ferias"]. Do not combine with query.' },
    search_in: { type:'string', enum:['name','content','name_and_content'], description:'Where to search. Prefer name to locate a file; content to search for a subject inside it.' },
    file_type: {type:'string',enum:['any',...Object.keys(types)],description:'Real type filter. spreadsheet includes Sheets, Excel and CSV.'},
    folder_id: {type:'string',description:'Restricts to a folder whose ID was obtained from the tool.'},
    max: {type:'integer',minimum:1,description:'Results per page: default 8, maximum 15.'},
    complete: {type:'boolean',description:'Complete a bounded query in up to 6 pages, preserving results and any remaining limit.'},
    cursor: {type:'string',description:'Continuation received from the SAME query; repeat all the filters. Do not reuse a cursor older than the last one received.'},
  },
};
export function driveSearchQuery(args = {}) {
  const {query='',terms,search_in='name_and_content',file_type='any',folder_id}=args;
  if(typeof query!=='string'||query.length>2048)throw Error('query deve ser texto com até 2048 caracteres.');
  if(terms!==undefined && (!Array.isArray(terms)||!terms.length||terms.length>8||query||terms.some(t=>typeof t!=='string'||!t.trim()||t.length>200)))throw Error('Use query OU terms (até 8 termos curtos).');
  if(!['name','content','name_and_content'].includes(search_in)||!(file_type==='any'||Object.hasOwn(types,file_type)))throw Error('Filtro de busca inválido. Use search_in e file_type conforme o esquema.');
  if(args.shared_with_me!==undefined)throw Error('A busca já inclui todos os arquivos acessíveis, inclusive Drives compartilhados. Remova shared_with_me: esse filtro excluiria arquivos de equipes.');
  if(folder_id!==undefined&&(typeof folder_id!=='string'||!/^[-\w]{1,200}$/.test(folder_id)))throw Error('ID da pasta inválido.');
  if(args.complete!==undefined&&typeof args.complete!=='boolean')throw Error('complete deve ser booleano.');
  const values=terms||[query];
  for(const term of values)if(/(?:\b(?:name|fullText)\s+(?:contains|=)|\bmimeType\s*=|\btype:|\bsharedWith\s*me\b|\s(?:OR|AND)\s)/i.test(term))throw Error('query/terms aceitam texto, não operadores. Use file_type=spreadsheet, search_in=name e terms para alternativas. Esta consulta NÃO foi executada; corrija os argumentos antes de concluir ausência.');
  const clauses=['trashed = false'];
  const match=term=>{const value=quote(term.trim());return search_in==='name'?`name contains ${value}`:search_in==='content'?`fullText contains ${value}`:`(name contains ${value} or fullText contains ${value})`;};
  const actual=values.filter(x=>x.trim());
  if(actual.length)clauses.push('('+actual.map(match).join(' or ')+')');
  if(file_type!=='any')clauses.push('('+types[file_type].map(t=>'mimeType = '+quote(t)).join(' or ')+')');
  if(folder_id)clauses.push(quote(folder_id)+' in parents');
  const q=clauses.join(' and ');
  if(q.length>2048)throw Error('Consulta longa demais; use menos termos.');
  return q;
}

// Bounded completion uses the same authenticated tool instance. Repeated page
// requests reuse its response; old cursors cannot cause rereads or new chains.
export function completeDriveSearch(pageTool) {
  const cache=new Map();
  const page=async args=>{
    if(args.max!==undefined&&(!Number.isSafeInteger(args.max)||args.max<1))throw Error('max deve ser inteiro positivo.');
    if(args.cursor!==undefined&&(typeof args.cursor!=='string'||!args.cursor))throw Error('Cursor inválido. Use somente a continuação recebida desta consulta.');
    const key=JSON.stringify([driveSearchQuery(args),args.max??null,args.cursor??null]);
    const old=cache.get(key);
    if(old&&Date.now()-old.at<900000)return old.value;
    const value=await pageTool(args);
    if(cache.size>=100)cache.delete(cache.keys().next().value);
    cache.set(key,{value,at:Date.now()});return value;
  };
  return async(args={})=>{
    let current=JSON.parse(await page(args));
    if(args.complete!==true)return JSON.stringify(current);
    const first=current,items=new Map(),seen=new Set();let pages=0,reason='';
    for(;;){
      pages++;for(const item of current.items)items.set(item.id,item);
      if(!current.has_more)break;
      if(pages>=6){reason='page_limit';break;}
      if(!current.next_cursor||seen.has(current.next_cursor)){reason='cursor_unavailable';break;}
      seen.add(current.next_cursor);
      let next;
      try{next=JSON.parse(await page({...args,cursor:current.next_cursor}));}catch{reason='page_failed';break;}
      if(next.search_id!==first.search_id||next.query!==first.query||next.page!==current.page+1||!Array.isArray(next.items)){reason='invalid_page';break;}
      current=next;
    }
    return JSON.stringify({...current,items:[...items.values()],returned:items.size,pages_completed:pages,
      start_page:first.page,partial:!!reason||current.partial,completion_reason:reason||undefined,
      note:reason?'Parte dos resultados foi preservada, mas a consulta não terminou. Refine os filtros ou continue do último cursor.':current.note});
  };
}
