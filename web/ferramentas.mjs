// Porta de ferramentas: tools que o operador pluga no turno além das do núcleo.
// O núcleo pergunta, quem instala responde. Na versão aberta não há nenhuma
// (createFerramentasSimples); no Brambs vêm de ferramentas-brambs.mjs.
//
//  doTurno({userId,agentId}) → tools ({name,description,parameters,run}) que
//    entram em todo turno de conversa, sem confirmação do dono. Só cabe aqui
//    tool que não age fora da conta ou que tem trava própria em vetar(). Campo
//    opcional grupo: o grupo de tools (GRUPO_TOOL_GROUPS do server, ex. 'produtos')
//    em que ela entra num assistente de canal multi-pessoa.
//  vetar({nome,mensagem}) → null (pode rodar) ou o texto de erro que volta pro
//    modelo no lugar da execução. Roda fora do modelo, antes de cada chamada;
//    mensagem é o texto humano ATUAL do turno.
//  instrucoes(nomes) → linhas a mais no prompt de sistema; nomes = Set das
//    tools que estão no turno (instrução de tool ausente não entra).
export const METODOS_FERRAMENTAS=['doTurno','vetar','instrucoes'];
export function conferirFerramentas(f){
 const faltam=METODOS_FERRAMENTAS.filter(m=>typeof f?.[m]!=='function');
 if(faltam.length)throw Error('Porta de ferramentas incompleta: '+faltam.join(', '));
 return f;
}
export function createFerramentasSimples(){
 return conferirFerramentas({doTurno:()=>[],vetar:()=>null,instrucoes:()=>[]});
}
