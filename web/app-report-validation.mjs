// One schema and one validator for incremental and closing reports. Diagnostics
// contain only field paths and fixed codes; model values stay in encrypted state.
const assessments=['sem_problema_observado','problema_observado','nao_verificado'];
export const APP_REPORT_PARAMETERS={type:'object',additionalProperties:false,properties:{itens:{type:'array',minItems:1,maxItems:12,items:{type:'object',additionalProperties:false,properties:{assunto:{type:'string',minLength:1,maxLength:120},avaliacao:{type:'string',enum:assessments},observacao:{type:'string',minLength:1,maxLength:400},explicacao_usuario:{type:'string',maxLength:220,description:'Explique este mesmo achado em uma frase simples para pessoa leiga, sem código, caminhos, jargão ou certeza além das evidências. Não afirme ações/testes/publicação. Opcional; não substitui observacao ou evidencias.'},evidencias:{type:'array',maxItems:8,uniqueItems:true,items:{type:'string',minLength:1}}},required:['assunto','avaliacao','observacao','evidencias']}}},required:['itens']};
const forbidden=/[`<>\r\n]|https?:\/\/|(?:^|[^\p{L}\p{N}_])(?:publiquei|publicado|enviado|enviei|testei|executei|funciona|íntegro|integro|concluído|concluido|published|sent|executed|works|completed)(?=$|[^\p{L}\p{N}_])/iu;
// Optional presentation text cannot reject a valid technical finding or trigger
// paid repair loops. Missing/invalid text is omitted; the UI has a neutral fallback.
export function plainReviewExplanation(value){
 if(typeof value!=='string'||!value.trim()||value.length>220||forbidden.test(value)||/[{}\[\]/*#=]|\b(?:[\w-]+\.(?:m?js|html|css|json|md)|boot|runtime|offset|hash|fetch)\b/iu.test(value))return null;
 return value.trim();
}
// Allow only a technical route segment /<identifier>, not HTML tags or attrs.
// The delivered receipt renders it as /{identifier}; raw angle markup never leaves.
export function reportTechnicalText(text) {
 return String(text).replace(/\/<([\p{L}_][\p{L}\p{N}_-]{0,39})>(?=\/|[\s.,;:!?)]|$)/gu,'/{$1}');
}
export function reportDiagnosticHelp(diagnostics=[]) {
 const help={unsafe_statement:'Use texto de análise estática, sem afirmar execução/publicação/funcionamento. Não use HTML, crases, URLs completas ou quebras de linha. Parâmetros de rota podem usar /{codigo}.',unknown_evidence:'Use apenas IDs de evidências atuais fornecidos pelas ferramentas; nunca crie um ID.',text_length:'Respeite assunto de1a120 e observacao de1a400 caracteres.',evidence_required:'Inclua evidência atual ou marque nao_verificado.'};
 return [...new Set(diagnostics.map(d=>help[d.code]).filter(Boolean))];
}
export function validateAppReport(args,evidence) {
  const accepted=[],diagnostics=[];
  const error=(field,code)=>diagnostics.push({field,code});
  if(!args||!Array.isArray(args.itens)||args.itens.length<1||args.itens.length>12){error('itens','item_count');return {accepted,diagnostics};}
  for(const [i,x] of args.itens.entries()) {
    const base=`itens.${i}`,before=diagnostics.length;
    if(!x||typeof x!=='object'||Array.isArray(x)){error(base,'item_shape');continue;}
    for(const [field,max] of [['assunto',120],['observacao',400]]) {
      if(typeof x[field]!=='string')error(base+'.'+field,'text_type');
      else if(!x[field].trim()||x[field].length>max)error(base+'.'+field,'text_length');
      else if(forbidden.test(reportTechnicalText(x[field])))error(base+'.'+field,'unsafe_statement');
    }
    if(!assessments.includes(x.avaliacao))error(base+'.avaliacao','assessment_enum');
    let ids=[];
    if(!Array.isArray(x.evidencias)||x.evidencias.length>8)error(base+'.evidencias','evidence_count');
    else {
      ids=x.evidencias;
      if(ids.some(id=>typeof id!=='string'||!id))error(base+'.evidencias','evidence_type');
      else if(ids.some(id=>!evidence.has(id)))error(base+'.evidencias','unknown_evidence');
      if(!ids.length&&x.avaliacao!=='nao_verificado')error(base+'.evidencias','evidence_required');
    }
    if(diagnostics.length===before){const plain=plainReviewExplanation(x.explicacao_usuario);accepted.push({assunto:reportTechnicalText(x.assunto),avaliacao:x.avaliacao,observacao:reportTechnicalText(x.observacao),...(plain?{explicacao_usuario:plain}:{}),evidencias:[...new Set(ids)].map(id=>({...evidence.get(id)}))});}
  }
  return {accepted,diagnostics};
}
export function reportAudit({args,validation,phase,at}) {
  let text;try{text=JSON.stringify(args);}catch{}
  const candidate=typeof text==='string'&&Buffer.byteLength(text,'utf8')<=64000?JSON.parse(text):null;
  return {phase,at,candidate,candidateOmitted:candidate===null,accepted:validation.accepted.length,diagnostics:validation.diagnostics};
}
