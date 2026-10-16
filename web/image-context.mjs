// Image identity per turn/thread. Never picks the last GLOBAL photo.
export const PARTIAL_IMAGE_NOTICE = 'LEITURA PARCIAL: descrição cortada; reabra a imagem com ver_midia usando o ID indicado antes de concluir sobre detalhes ausentes.';
const uuid = id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
export function boundedImageCaption(text, limit=4000, incomplete=false) {
  const raw=String(text || '').trim().replace(/\s+/g,' ');
  if (!incomplete && raw.length<=limit) return raw;
  const room=Math.max(0,limit-PARTIAL_IMAGE_NOTICE.length-3);
  return `${raw.slice(0,room)} … ${PARTIAL_IMAGE_NOTICE}`.trim();
}
// Captions and IDs stay aligned by index, even when saving/reading a photo
// fails. With many photos, reduces the budget without hiding that the read
// was cut short.
export function imageHistoryMarkers(count, captions=[], ids=[]) {
  const per=count<=2?4000:1200;
  return Array.from({length:count},(_,i)=>{
    const ref=ids?.[i]!=null?` id=${ids[i]}`:'';
    const cap=boundedImageCaption(captions?.[i],per);
    return cap?`🖼️ [foto${ref}: ${cap}]`:`🖼️ [foto enviada${ref}]`;
  }).join(' ');
}
function markers(text) {
  return [...String(text || '').matchAll(/🖼️\s*\[foto(?: enviada)?(?: id=([^\s:\]]+))?(?=[:\]])/g)].map(m=>m[1] || null);
}
export function resolveImageReference({id,turnIds=[],imageCount=0,message='',history=[]}={}) {
  if (id!=null && String(id).trim()) {
    const value=String(id).trim();
    return uuid(value)?{id:value,source:'explicit'}:{error:'ERRO: ID de imagem inválido. Use o ID de uma imagem desta conversa ou de listar_midia.'};
  }
  let ids=[],source='';
  if (imageCount>0 || turnIds.length) {
    ids=Array.from({length:Math.max(imageCount,turnIds.length)},(_,i)=>turnIds[i] || null);source='current';
  } else {
    ids=markers(message);source='message';
    if (!ids.length) {
      source='thread';
      for (let i=history.length-1;i>=0;i--) {
        if (history[i]?.role!=='user') continue;
        ids=markers(history[i].content);
        if (ids.length) break;
      }
    }
  }
  if (!ids.length) return {error:'ERRO: não há uma imagem identificável nesta conversa. Peça a imagem/ID ou use listar_midia para localizar a imagem pedida. Não vou abrir uma foto de outra conversa automaticamente.'};
  if (ids.some(v=>!uuid(v))) return {error:'ERRO: a imagem deste contexto não tem referência recuperável (pode ter falhado ao salvar ou ser um registro antigo). Peça reenvio ou um ID explícito; não use outra imagem no lugar.'};
  const unique=[...new Set(ids)];
  if (unique.length!==1) return {error:`ERRO: há ${unique.length} imagens nesse turno; não escolhi uma por suposição. Identifique qual é ou examine cada uma por ID: ${unique.join(', ')}.`};
  return {id:unique[0],source};
}
export async function readContextImage(input,deps) {
  const ref=resolveImageReference(input);if(ref.error)return ref.error;
  // getAsset needs to be the owner-scoped lookup, including for an explicit
  // ID.
  const asset=await deps.getAsset(ref.id);
  if (!asset) return 'ERRO: imagem não encontrada ou não pertence a este usuário. Não abri outra imagem.';
  if (!(asset.mime?String(asset.mime).startsWith('image/'):asset.kind==='image')) return 'ERRO: esse item não é uma imagem. Não abri outro arquivo.';
  const m=await deps.fetch(asset.s3_key);if(!m)return 'ERRO: não consegui recuperar a imagem indicada.';
  const result=await deps.describe(m.buffer,asset.mime || m.contentType,input.pergunta);
  if(result.usage)deps.onUsage?.(result.usage);
  if(!result.text)return 'Não consegui extrair conteúdo da imagem indicada.';
  const partial=result.truncated?`\n${PARTIAL_IMAGE_NOTICE}`:'';
  return `(imagem id=${asset.id}; referência ${ref.source})\n${result.text}${partial}`;
}
