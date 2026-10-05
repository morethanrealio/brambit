// Pure boundaries. Never inspect private bytes before checking ownership.
export function ownedMediaKey(userId, key) {
  if(typeof userId!=='string'||typeof key!=='string'||!key.startsWith(userId+'/'))return false;
  const tail=key.slice(userId.length+1);
  return !!tail&&tail.length<=1024&&!/[\x00-\x20\\%?#]/.test(tail)&&!tail.split('/').some(p=>!p||p==='.'||p==='..');
}
export function emailHeader(value, field) {
  const text=String(value??'');
  if(/[\x00-\x1f\x7f\u2028\u2029]/u.test(text))throw Object.assign(Error(`O campo ${field} contém uma quebra de linha ou caractere inválido. Corrija esse campo; nenhum e-mail foi enviado nem rascunho criado.`),{code:'EMAIL_HEADER_INVALID'});
  return text;
}
