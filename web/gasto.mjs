// Porta 1: gasto. O núcleo só pergunta "pode gastar?" e informa o que gastou;
// quanto cada pessoa pode gastar é decisão da implementação plugada (a do
// Brambs cobra em créditos, com franquia do plano e conta pagadora da empresa).
//  vincular({provider,userId,agentId,threadId,kind,language,noBill}) → o mesmo
//    provider, mas cada chamada física reserva antes e acerta depois.
//  vincularDeepSeek({...identidade,maxTokens,secret}) → idem para a rota oficial
//    do DeepSeek, que mede o próprio uso.
//  disponivel(userId) → {remaining,held,available}. Prévia: não reserva nada.
//  status(userId) → {over,...}. over=true para o turno antes de chamar o modelo.
//  registrar({userId,callId,usage,charge,dimensions}) → recibo de um gasto já
//    feito. Idempotente por callId.
//  limparCheckpoints({dias}) e apagarConta(userId) → manutenção e exclusão de conta.
//  creditosDe(item) → quanto cobrar de um gasto, na unidade da implementação
//    (0 = não cobra; o custo real em US$ é gravado de qualquer jeito). item:
//    {tipo:'uso',uso} (chamada de modelo, busca, imagem...), {tipo:'whatsapp'}
//    (uma mensagem enviada) ou {tipo:'video',segundos}.
//  dolarEmReais() → cotação usada pra lançar em US$ o que é cobrado em reais
//    (a mensagem de serviço do WhatsApp).
//  dolarPorCredito() → US$ de uma unidade de creditosDe (o custo lançado da
//    cobrança de vídeo). 0 quando a implementação não cobra.
// O que a pessoa e o modelo leem sobre saldo também é da implementação (o núcleo
// não sabe o que é crédito, plano ou pacote):
//  avisoSemSaldo(status,{userId,language,appClient}) → {texto,notaEmergencia}:
//    a resposta do turno barrado por status.over e a nota no fim do turno de
//    emergência (recuperação de app). appClient = app iOS, sem chamada de compra.
//  contextoDoTurno(status) → bloco que vai pro modelo a cada turno ('' = nada).
//  ferramentas({userId,appClient,agentId,turnId}) → ferramentas de consulta de
//    saldo e de gasto do turno (consultar_gasto, credit-spend.mjs, na unidade
//    da implementação).
//  telaDeCreditos({userId,status,extras}) → corpo de /api/usage/credits: o
//    status, o que a implementação mostra de saldo e compra, e os `extras` do
//    núcleo (modelos e mídia; custo de mídia em US$, a implementação converte
//    se mostra outra unidade).
//  conta(status) → bloco `conta` do /api/me: de quem é o saldo que a pessoa usa
//    ({tipo:'pessoal'} ou, no Brambs, a empresa que paga e o plano dela).
//  compraNaWeb() → true quando o site vende plano ou pacote (vai no /api/config;
//    o front só mostra botão de compra com ela ligada).
export const METODOS_GASTO=['vincular','vincularDeepSeek','disponivel','status','registrar','limparCheckpoints','apagarConta','creditosDe','dolarEmReais','dolarPorCredito','avisoSemSaldo','contextoDoTurno','ferramentas','telaDeCreditos','conta','compraNaWeb'];
export function conferirGasto(gasto){
 const faltam=METODOS_GASTO.filter(m=>typeof gasto?.[m]!=='function');
 if(faltam.length)throw Error('Porta de gasto incompleta: '+faltam.join(', '));
 return gasto;
}
