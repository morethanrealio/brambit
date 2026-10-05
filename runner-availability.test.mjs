// Sem servidor/DB/daemon real. O módulo completo é avaliado em VM; só touch
// sintético e relógio simulado. Timers, rede e processos reais são proibidos.
import { marca } from './web/marca.mjs';
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
let n=0;const eq=(a,b)=>{assert.deepEqual(a,b);n++;};const ok=a=>{assert.ok(a);n++;};
let clock=Date.parse('2026-09-10T12:00:00Z');class Clock extends Date{static now(){return clock;}}
const source=readFileSync('./web/runner.mjs','utf8').replace("import { marca } from './marca.mjs';",'').replaceAll('export ','');
function instance(){const context=vm.createContext({marca,Date:Clock,setTimeout:denied,clearTimeout:denied,console:{log(){},warn(){},error(){}}});vm.runInContext(source+';globalThis.p={touch,runnerAvailability,runnerContextForTurn,runnerOnline,runnerStatus,runnerContext};',context);return context.p;}
const p=instance(),opts={agentId:'agent-a',runnerForThisAgent:true,terminalAvailable:true};
eq(p.runnerAvailability('user-a').state,'unknown');ok(p.runnerContextForTurn('user-a',opts).includes('NÃO prova'));ok(p.runnerContextForTurn('user-a',opts).includes('servidor pode ter reiniciado'));
p.touch('user-b','dev-b',{hostname:'PRIVATE-OTHER-USER',version:'2.1.1'},'agent-b');eq(p.runnerAvailability('user-a').state,'unknown');ok(!p.runnerContextForTurn('user-a',opts).includes('PRIVATE-OTHER-USER'));
p.touch('user-a','dev-a',{hostname:'synthetic',version:'2.1.1'},'agent-a');eq(p.runnerAvailability('user-a').state,'online');ok(p.runnerContextForTurn('user-a',opts).includes('ATIVO'));ok(p.runnerContextForTurn('user-a',opts).includes('o Runner não informou o modo de escrita'));ok(!p.runnerContextForTurn('user-a',opts).includes('ESCRITA vale só nas pastas autorizadas'));
// Confinamento só é afirmado quando o Runner o reporta (degrade honesto; sem o campo = desconhecido).
{const c=instance();c.touch('user-a','dev-a',{hostname:'synthetic',version:'2.1.1',confined:'1'},'agent-a');const t=c.runnerContextForTurn('user-a',opts);ok(t.includes('ESCRITA vale só nas pastas autorizadas'));ok(t.includes('cercada pelo sistema operacional'));}
// Acesso total: o daemon manda confined=1 (nada a cercar), mas o texto não pode dizer que a escrita está cercada.
{const c=instance();c.touch('user-a','dev-a',{hostname:'synthetic',version:'2.2.0',mode:'full-access',confined:'1'},'agent-a');const t=c.runnerContextForTurn('user-a',opts);ok(t.includes('ACESSO TOTAL'));ok(!t.includes('cercada pelo sistema operacional'));}
// 2.2.0 sem cerca no modo restrito: o Runner recusa tudo, e o assistente aponta o botão do painel em vez de tentar.
{const c=instance();c.touch('user-a','dev-a',{hostname:'synthetic',version:'2.2.0',os:'win32',mode:'workspace-write',confined:'0'},'agent-a');const t=c.runnerContextForTurn('user-a',opts);ok(t.includes('BLOQUEADO'));ok(t.includes('Liberar acesso total nesta máquina'));ok(!t.includes('bubblewrap'));}
{const c=instance();c.touch('user-a','dev-a',{hostname:'synthetic',version:'2.2.0',os:'linux',mode:'workspace-write',confined:'0'},'agent-a');ok(c.runnerContextForTurn('user-a',opts).includes('bubblewrap'));}
// Runner antigo sem cerca ainda roda solto: mantém o aviso de escrita não cercada.
{const c=instance();c.touch('user-a','dev-a',{hostname:'synthetic',version:'2.1.1',mode:'workspace-write',confined:'0'},'agent-a');const t=c.runnerContextForTurn('user-a',opts);ok(t.includes('NÃO está cercada'));ok(!t.includes('BLOQUEADO'));}

const blocked=p.runnerContextForTurn('user-a',{...opts,terminalAvailable:false});ok(blocked.includes('terminal local não está disponível'));ok(!blocked.includes('Você TEM acesso'));ok(blocked.includes('já está conectado'));
const other=p.runnerContextForTurn('user-a',{...opts,agentId:'agent-other',runnerForThisAgent:false});ok(other.includes('OUTRO assistente'));ok(!other.includes('synthetic'));ok(!other.includes('agent-a'));
for(const state of [true,false]){eq(p.runnerContextForTurn('user-a',{...opts,terminalAvailable:state,agentCategory:'grupo'}),'');eq(p.runnerContextForTurn('user-a',{...opts,terminalAvailable:state,ephemeral:true}),'');}
clock+=45000;eq(p.runnerOnline('user-a'),true);clock++;eq(p.runnerOnline('user-a'),false);
const offline=p.runnerContextForTurn('user-a',opts);eq(p.runnerAvailability('user-a').state,'offline');ok(offline.includes('heartbeat expirado'));ok(!offline.includes('ATIVO'));ok(offline.includes(`não que o ${marca().nome} nunca`));
eq(p.runnerStatus('user-a').online,false);eq(p.runnerContext('user-a'),''); // API/gate legados intocados
const fresh=instance();eq(fresh.runnerAvailability('user-a').state,'unknown');
p.touch('user-a','dev-a',null,null);const unbound=p.runnerContextForTurn('user-a',{...opts,runnerForThisAgent:false});ok(unbound.includes('não foi habilitado'));ok(!unbound.includes('OUTRO assistente'));ok(p.runnerContextForTurn('user-a',opts).includes('ATIVO'));
// Dispositivo recém-online não autoriza agente que já perdeu o gate neste turno.
p.touch('user-a','dev-a',null,'agent-a');ok(p.runnerContextForTurn('user-a',{...opts,runnerForThisAgent:false}).includes('não foi habilitado'));
// Múltiplos devices: mesma seleção mais recente do transporte, sem mudar gate.
clock+=10;p.touch('user-a','dev-new',null,'agent-new');ok(p.runnerContextForTurn('user-a',opts).includes('OUTRO assistente'));eq(p.runnerOnline('user-a'),true);
const server=readFileSync('./web/server.mjs','utf8');
ok(server.includes('const runner = runnerContextForTurn(userId, {'));ok(server.includes('terminalAvailable:runnerForThisAgent && livreEnv'));
ok(server.includes("if (agentCategory !== 'grupo' && runnerOnline(userId))"));ok(server.includes('const livreActive = livreEnv && (runnerForThisAgent || sshLivre)'));
// Expressão de integração REAL extraída, prova que o gate de ambiente chega ao helper.
const start=server.indexOf('  const runner = runnerContextForTurn(userId, {');const end=server.indexOf('  });',start)+5;
const expr=server.slice(start,end)+';globalThis.result=runner;';
for(const [env,expected] of [[true,'ATIVO'],[false,'terminal local não está disponível']]){
 const c=vm.createContext({runnerContextForTurn:p.runnerContextForTurn,userId:'user-a',agent:{id:'agent-new'},agentCategory:'pessoal',ephemeral:false,runnerForThisAgent:true,livreEnv:env});vm.runInContext(expr,c);ok(c.result.includes(expected));
}
console.log(`${n} verificações aprovadas: TTL, vínculo, isolamento, restart simulado e gates preservados. Zero I/O real.`);
