import { createHash } from 'node:crypto';
import { draftRevision } from './app-draft-validation.mjs';
// Literal search only: no regex evaluation, shell, network, writes or arbitrary paths.
export function searchAppCode(files, { texto, caminho, inicio = 0, limite = 30, revisao_esperada } = {}) {
  if (typeof texto !== 'string' || !texto.length || texto.length > 200 || /[\r\n\0]/.test(texto) ||
      !Number.isSafeInteger(inicio) || inicio < 0 || !Number.isSafeInteger(limite) || limite < 1 || limite > 50)
    return { ok:false, error:'Busca inválida: texto literal de até 200 caracteres, início e limite válidos.' };
  if (caminho !== undefined && (typeof caminho !== 'string' || caminho.length > 300 || caminho.split('/').some(s=>s==='..') || caminho.startsWith('/')))
    return { ok:false, error:'Caminho relativo inválido.' };
  const revisao = draftRevision(files);
  if ((inicio > 0 && !revisao_esperada) || (revisao_esperada && revisao !== revisao_esperada))
    return { ok:false, error:'O rascunho mudou ou falta a revisão da página anterior. Recomece a busca.', revisao };
  const resultados = []; let count=0, scanned=0, truncated=false;
  const entries=Object.entries(files).filter(([p])=>caminho===undefined || p===caminho).sort(([a],[b])=>a.localeCompare(b));
  if (caminho && !entries.length) return {ok:false,error:'Arquivo não encontrado.',revisao};
  for (const [p,b64] of entries) {
    const buf=Buffer.from(b64,'base64'); scanned+=buf.length;
    if (scanned>8_000_000) return {ok:false,error:'App excede o limite de busca. Restrinja pelo caminho de um arquivo.',revisao};
    const text=buf.toString('utf8'); if(text.includes('\0'))continue;
    const hash=createHash('sha256').update(buf).digest('hex').slice(0,12);
    let offset=0,line=1;
    for (const s of text.split('\n')) {
      const at=s.indexOf(texto);
      if (at>=0) {
        if(count>=inicio && resultados.length<limite) {
          const start=Math.max(0,at-100),end=Math.min(s.length,at+texto.length+180);
          resultados.push({arquivo:p,linha:line,inicio:offset+start,fim:offset+end,hash,trecho:s.slice(start,end),linha_parcial:start>0||end<s.length});
        } else if (count>=inicio+limite) {truncated=true;break;}
        count++;
      }
      offset+=s.length+1;line++;
    }
    if(truncated)break;
  }
  if(inicio>count)return {ok:false,error:'Cursor fora dos resultados.',revisao};
  while(JSON.stringify(resultados).length>16000&&resultados.length>1){resultados.pop();truncated=true;}
  if(JSON.stringify(resultados).length>16000)return {ok:false,error:'Metadados da busca excedem o limite.',revisao};
  return {ok:true,revisao,resultados,proximo_inicio:truncated?inicio+resultados.length:null,
    obs:'Correspondências literais, não análise semântica. Leia o contexto antes de editar. Busca sem ocorrências não prova ausência de bug.'};
}
