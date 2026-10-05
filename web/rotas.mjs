// Porta de rotas: a distribuição pluga rotas HTTP próprias sem o server.mjs
// conhecer cada uma. No Brambs: os webhooks de pagamento do Stripe, da Apple e da
// Asaas (pagamentos-brambs.mjs) e os painéis de admin, do /metrics e do cockpit
// (admin-brambs.mjs, metricas-brambs.mjs, cockpit-brambs.mjs). Na versão aberta
// ninguém registra e nada muda.
//  registrar: caminho EXATO (método + pathname).
//  usar: manipulador livre, pra rota com prefixo, com mais de um caminho ou que
//   aceita qualquer método. Devolve SEGUE quando o pedido não é dele.
//  Uma rota exata também pode devolver SEGUE (deixa o pedido seguir pro resto
//  do servidor, como fazia o `if` antigo que não respondia em todo caminho).
//  O servidor despacha num ponto só do handler, depois dos SECURITY_HEADERS, então
//  a rota plugada responde com os mesmos headers de qualquer outra. Cada uma
//  recebe (req, res, url, ctx), com ctx.currentUser() pra sessão logada.
//  Rota repetida falha no boot, e não no primeiro pedido.
export const SEGUE=Symbol('segue');
export function createRotas(){
 const mapa=new Map();
 const livres=[];
 return {
  registrar(metodo,caminho,tratar){
   const chave=`${metodo} ${caminho}`;
   if(typeof tratar!=='function')throw Error('Rota sem função: '+chave);
   if(mapa.has(chave))throw Error('Rota repetida: '+chave);
   mapa.set(chave,tratar);
  },
  usar(tratar){
   if(typeof tratar!=='function')throw Error('Manipulador sem função');
   livres.push(tratar);
  },
  // true = alguma rota plugada respondeu (o handler para aí).
  async atender(req,res,url,ctx={}){
   const tratar=mapa.get(`${req.method} ${url.pathname}`);
   if(tratar&&(await tratar(req,res,url,ctx))!==SEGUE)return true;
   for(const t of livres)if((await t(req,res,url,ctx))!==SEGUE)return true;
   return false;
  },
 };
}
