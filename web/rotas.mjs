// Routes port: a distribution plugs in its own HTTP routes without server.mjs
// knowing each one. A plugin might add e.g. payment webhooks (Stripe, Apple,
// Asaas) and admin or metrics dashboards. In the core, only the public-service
// owner view (publico-dono.mjs).
//  registrar: EXACT path (method + pathname).
//  usar: free handler, for a prefixed route, one with several paths or that
//   accepts any method. Returns SEGUE when the request isn't its own.
//  An exact route can also return SEGUE (lets the request go on to the rest of
//  the server, like the old `if` that didn't answer on every path).
//  The server dispatches at a single point of the handler, after SECURITY_HEADERS,
//  so a plugged route answers with the same headers as any other. Each one
//  receives (req, res, url, ctx), with ctx.currentUser() for the logged-in session.
//  A duplicate route fails at boot, not on the first request.
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
