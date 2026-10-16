export async function load(url,ctx,next) {
 if(url.endsWith('/web/compras.mjs'))return {format:'module',shortCircuit:true,source:"export function descreverCarrinho(){throw Error('commerce blocked')} export function plataformaDoCarrinho(){throw Error('commerce blocked')}"};
 if(url.endsWith('/web/db.mjs') || /^(pg|postgres)$/.test(url))throw Error('DB import forbidden');
 return next(url,ctx);
}
