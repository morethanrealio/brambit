// Tools port: tools the operator plugs into the turn beyond the core's.
// The core asks, whoever installs it answers. The open version has none
// (createFerramentasSimples); a plugin can provide its own.
//
//  doTurno({userId,agentId}) → tools ({name,description,parameters,run}) that
//    join every conversation turn, without owner confirmation. Only tools that
//    don't act outside the account, or that have their own gate in vetar(),
//    belong here. Optional field grupo: the tool group (server's
//    GRUPO_TOOL_GROUPS, e.g. 'produtos') it joins in a multi-person channel assistant.
//  vetar({nome,mensagem}) → null (may run) or the error text that goes back to
//    the model instead of running. Runs outside the model, before each call;
//    mensagem is the turn's CURRENT human text.
//  instrucoes(nomes) → extra lines in the system prompt; nomes = Set of the
//    tools in the turn (instructions for absent tools are left out).
export const METODOS_FERRAMENTAS=['doTurno','vetar','instrucoes'];
export function conferirFerramentas(f){
 const faltam=METODOS_FERRAMENTAS.filter(m=>typeof f?.[m]!=='function');
 if(faltam.length)throw Error('Porta de ferramentas incompleta: '+faltam.join(', '));
 return f;
}
export function createFerramentasSimples(){
 return conferirFerramentas({doTurno:()=>[],vetar:()=>null,instrucoes:()=>[]});
}
