// Porta da conta de pagamento do operador: uma conta Asaas que QUEM INSTALA
// abre em nome do usuário (no Brambs, a Conta Brambs). O conector Asaas com a
// chave que o próprio usuário guardou no cofre é do núcleo e funciona sem ela.
// Na versão aberta não há conta do operador (createContaPagamentoSimples); no
// Brambs ela vem de conta-brambs.mjs.
//
//  escolherConta(conns) → qual conexão Asaas do cofre as tools de dinheiro
//    movimentam: { conexao, contaBrambs, rotulo, ambigua } ou null. conns é a
//    lista crua de connections do usuário.
//  garantirWebhook({userId,cred,publicBase}) → prepara o webhook de
//    comprovantes da conta antes de uma saída. cred() devolve a conta escolhida.
//  ferramentasDoCofre({userId,cred,brasil,imagensDoTurno}) → { livres,
//    comConfirmacao }: tools que entram no grupo do cofre; as do segundo grupo
//    só rodam depois do "pode" do dono.
//  rotuloDoCofre(rotulo,{brasil}) → texto que o modelo lê pra decidir abrir o
//    grupo do cofre.
//  apresentacao({mensagem,historico,idioma}) → null, ou a identificação
//    obrigatória do turno: { anexo, meta, comTexto(texto), entrada(userInput),
//    indisponivel({userId,grupo,brasil}) → texto ou null }. meta marca a
//    resposta no histórico pra não repetir a identificação.
//  instrucoes(nomes) → linhas a mais no prompt; nomes = Set das tools do turno.
export const METODOS_CONTA_PAGAMENTO=['escolherConta','garantirWebhook','ferramentasDoCofre','rotuloDoCofre','apresentacao','instrucoes'];
export function conferirContaPagamento(c){
 const faltam=METODOS_CONTA_PAGAMENTO.filter(m=>typeof c?.[m]!=='function');
 if(faltam.length)throw Error('Porta de conta de pagamento incompleta: '+faltam.join(', '));
 return c;
}
// Conexões Asaas do cofre, na ordem do cofre.
export const conexoesAsaas=(conns)=>(conns||[]).filter((c)=>String(c?.provider||'').toLowerCase()==='asaas'
 &&['apikey','token','basic'].includes(c?.kind));
export function createContaPagamentoSimples(){
 return conferirContaPagamento({
  escolherConta:(conns)=>{
   const asaas=conexoesAsaas(conns);
   if(!asaas.length)return null;
   return {conexao:asaas[0],contaBrambs:false,rotulo:asaas[0].label||'conta Asaas própria',ambigua:asaas.length>1};
  },
  garantirWebhook:async()=>({skipped:true,reason:'conta_asaas_propria'}),
  ferramentasDoCofre:()=>({livres:[],comConfirmacao:[]}),
  rotuloDoCofre:(rotulo)=>rotulo,
  apresentacao:()=>null,
  instrucoes:()=>[],
 });
}
