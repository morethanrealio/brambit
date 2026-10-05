// ── SSH via cofre de credenciais (opção B: chave por usuário) ──
//
// Fluxo:
//  1) `gerar_chave_ssh(host, usuario)` gera um par ed25519 DENTRO do sandbox do
//     usuário, guarda a chave PRIVADA cifrada no cofre (kind 'ssh_key') e devolve
//     a chave PÚBLICA pro usuário colar no ~/.ssh/authorized_keys do servidor.
//  2) `rodar_no_servidor(comando)` (GATED) busca a chave no cofre, decifra em
//     memória, conecta a partir do sandbox SP (egress BR, rede interna bloqueada
//     pelo firewall do host) e roda o comando. Exige confirmação explícita.
//
// Por que roda do SANDBOX e não do backend: o sandbox tem firewall que dropa a
// rede interna da VPC (metadata, Postgres, 10/172.16/192.168), então um usuário
// não consegue mirar a infra por dentro. O backend está na VPC, seria perigoso.
import { comAviso } from './recorte.mjs';
import { sandboxEnabled, sandboxShell, sandboxWrite, sandboxRead } from './sandbox.mjs';
import { encryptSecret, decryptSecret, vaultEnabled } from './vault.mjs';
import { addConnection, listConnections, getConnection } from './db.mjs';
import { runnerOnline, runnerExec } from './runner.mjs';
import { createHash } from 'node:crypto';
import { marca } from './marca.mjs';

const executionEffect=(state,operation)=>({version:1,state,operation});
const executionResult=(body,state,operation)=>JSON.stringify({...body,effect:executionEffect(state,operation)});

const SSH_DIR = '/workspace/.ssh';
const KNOWN_HOSTS = `${SSH_DIR}/known_hosts`;

// Mascara segredo na SAÍDA de qualquer comando remoto antes de devolver pro
// modelo (e, por tabela, pro chat/histórico). Rede de segurança que NÃO depende
// do modelo se comportar: se um `cat .env`/`grep` cuspir credencial, ela já sai
// redigida. Cobre o que vazou pro Marcos 15/07 (senha do Postgres na
// DATABASE_URL, AWS_ACCESS_KEY_ID/SECRET) + os suspeitos usuais. Usada aqui e no
// coding.mjs (que importa daqui pra não duplicar).
export function maskSecrets(s, { prose = false } = {}) {
  let t = String(s ?? '');
  // Senha em connection string: scheme://user:SENHA@host  ->  user:***@host
  t = t.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, '$1***$3');
  // AWS Access Key ID (AKIA/ASIA + 16 alfanum).
  t = t.replace(/\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, '***AWS_KEY***');
  // Tokens por FORMATO (não dependem de aparecer num `NOME=`). Cobre os que o
  // regex por-nome deixava passar no live-feed/saída: Authorization Bearer/Basic,
  // JWT, GitHub, Slack, OpenAI/Anthropic, Google (ya29/AIza), Stripe.
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***');
  t = t.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '***JWT***');
  t = t.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***GH_TOKEN***');
  t = t.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***GH_TOKEN***');
  t = t.replace(/\bxox[baprse]-[A-Za-z0-9-]{8,}\b/g, '***SLACK_TOKEN***');
  t = t.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, '***API_KEY***');
  t = t.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '***STRIPE_KEY***');
  t = t.replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, '***GOOGLE_TOKEN***');
  t = t.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '***GOOGLE_KEY***');
  // Atribuição de env/config cujo NOME parece segredo: X=valor  ->  X=***
  // (SECRET, PASSWORD/PASS, TOKEN, APIKEY/API_KEY, ACCESS_KEY, PRIVATE_KEY, etc.)
  // Em PROSA do assistente (prose:true) só dispara quando o NOME parece um
  // identificador de env/config de verdade (TUDO_MAIUSCULO ou snake_case com _);
  // assim palavra comum de texto pt-BR ("passo:", "Passagens:", "tokens:") não é
  // mais comida, mas segredo real (DB_PASS=, CLIENT_SECRET:, PASSWORD=) segue
  // mascarado. Na saída de terminal (prose:false) mantém o comportamento
  // agressivo de sempre.
  t = t.replace(
    /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|PASS|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_SECRET)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (m, name, sep) => (prose && !(name.includes('_') || /^[A-Z0-9]+$/.test(name)) ? m : `${name}${sep}***`),
  );
  // Bloco de chave privada PEM inteiro.
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***PRIVATE_KEY***');
  return maskPasswordLabels(t);
}

// Senha escrita em texto comum (pt/es/en), que o regex por NOME acima não pega
// em prosa: "senha: casa2026", "a senha do wifi é casa2026", "contraseña: x",
// "password is x". Só o valor vira ***. "chave"/"clave" ficam de fora de
// propósito: chave Pix é dado que o dono pede.
// Com ":"/"=" qualquer valor é mascarado. Com verbo ("é", "is", "es") só quando o
// valor tem dígito/símbolo ou vem entre aspas/crases/negrito, senão "a senha é
// obrigatória" perderia a palavra.
const PW_LABEL = String.raw`(?<![\p{L}\p{N}_])(?:senha|contraseña|contrasena|password|passwd|pwd)`;
const PW_QUAL = String.raw`(?:[ \t]+(?:nova|atual|antiga|provis[oó]ria|tempor[aá]ria|nueva|actual|new|current|temporary))?(?:[ \t]+(?:d[oa]s?|de|del|de la|of|for|to)[ \t]+[\p{L}\p{N}._@/-]{1,40}(?:[ \t]+(?:d[oa]s?|de|del|ao|à|no|na|en|of|for|to|on)[ \t]+[\p{L}\p{N}._@/-]{1,40})?)?`;
const PW_VALUE = String.raw`("[^"\n]+"|'[^'\n]+'|\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*|[^\s"'\x60*]+?)(?=[.,;!?)]*(?:\s|$))`;
const RE_PW_SEP = new RegExp(String.raw`(${PW_LABEL}${PW_QUAL}[ \t]*[:=][ \t]*)${PW_VALUE}`, 'giu');
const RE_PW_VERB = new RegExp(String.raw`(${PW_LABEL}${PW_QUAL}[ \t]+(?:é|eh|era|será|es|is|was)[ \t]+)${PW_VALUE}`, 'giu');
const PW_EMPTY = /^(?:\*+|-+|n\/a|não|nao|nenhuma|none|ninguna|no)$/i;

function maskPasswordValue(value) {
  // Aspas e crase ficam; negrito vira só *** (senão sobra "*******").
  const q = /^["'`]/.exec(value)?.[0] || '';
  return q ? `${q}***${q}` : '***';
}

function maskPasswordLabels(t) {
  t = t.replace(RE_PW_SEP, (m, head, value) => (PW_EMPTY.test(value) ? m : head + maskPasswordValue(value)));
  return t.replace(RE_PW_VERB, (m, head, value) => {
    if (PW_EMPTY.test(value)) return m;
    const forte = /^(?:\*\*|["'`])/.test(value) || /[\p{N}\p{P}\p{S}]/u.test(value);
    return forte ? head + maskPasswordValue(value) : m;
  });
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Verifica se o cliente SSH está instalado no sandbox. Sem openssh-client (ver
// Dockerfile), ssh/ssh-keygen não existem: degradamos com mensagem útil.
async function sshAvailable(userId) {
  try {
    const r = await sandboxShell(userId, 'command -v ssh-keygen && command -v ssh', 15_000);
    return r.exitCode === 0 && (r.stdout || '').trim().length > 0;
  } catch { return false; }
}

const NO_SSH = 'O ambiente ainda não tem o cliente SSH instalado (openssh-client). Avise o suporte pra habilitar; assim que o ambiente for atualizado, isso funciona.';

// Acha a conexão de chave SSH do usuário. Se `host` vier, casa por host; senão,
// usa a única existente (ou pede pra especificar quando houver várias).
function pickKeyConn(conns, host, rotulo) {
  const keys = conns.filter((c) => c.kind === 'ssh_key');
  if (!keys.length) return { error: 'Você ainda não tem uma chave SSH criada. Use "gerar chave ssh" primeiro, cole a chave pública no servidor e depois rode o comando.' };
  const labels = () => keys.map((k) => k.label || k.meta?.host || '(sem rótulo)').join(', ');
  // Rótulo explícito resolve QUALQUER ambiguidade: casa pelo label (ou pelo host
  // fixo da chave). É o parâmetro que o modelo passa quando há mais de uma chave.
  if (rotulo) {
    const r = String(rotulo).toLowerCase().trim();
    const m = keys.filter((c) => String(c.label || '').toLowerCase() === r || String(c.meta?.host || '').toLowerCase() === r);
    if (m.length === 1) return { conn: m[0] };
    if (m.length > 1) return { error: `Mais de uma chave com o rótulo "${rotulo}". Rótulos: ${labels()}.` };
    return { error: `Não achei chave com o rótulo "${rotulo}". Rótulos disponíveis: ${labels()}.` };
  }
  if (host) {
    const h = String(host).toLowerCase();
    const m = keys.filter((c) => (c.meta?.host || '').toLowerCase() === h);
    if (m.length === 1) return { conn: m[0] };
    if (m.length > 1) return { error: `Há mais de uma chave pro host ${host}. Passe o parâmetro "rotulo" pra escolher. Rótulos: ${labels()}.` };
    // Sem chave amarrada a esse host: se só existir uma no total, usa ela.
    if (keys.length === 1) return { conn: keys[0] };
    // Senão, tenta uma chave "solta" (gerada sem host fixo).
    const unbound = keys.filter((c) => !c.meta?.host);
    if (unbound.length === 1) return { conn: unbound[0] };
    if (unbound.length > 1) return { error: `Você tem mais de uma chave sem host fixo. Passe o parâmetro "rotulo" pra escolher qual usar com ${host}. Rótulos: ${labels()}.` };
    return { error: `Não achei chave SSH pro host ${host}. Chaves existentes: ${labels()}.` };
  }
  if (keys.length === 1) return { conn: keys[0] };
  return { error: `Você tem várias chaves SSH (${labels()}). Passe o parâmetro "rotulo" pra escolher, ou diga o host.` };
}

// Transporte reusável: roda um comando no servidor do usuário via SSH a partir
// do sandbox, usando a chave do cofre. Usado por rodar_no_servidor e pelas tools
// de coding (coding.mjs). Devolve um OBJETO (não string): { ok, host, exit,
// saida, stderr, error }. Não trunca saida/stderr — quem chama corta como quiser.
export async function sshExec(userId, comando, { host, usuario, rotulo, timeout = 90_000 } = {}) {
  if (!(await sshAvailable(userId))) return { ok: false, error: NO_SSH };
  if (!comando) return { ok: false, error: 'Sem comando pra rodar.' };
  const conns = await listConnections(userId);
  const pick = pickKeyConn(conns, host, rotulo);
  if (pick.error) return { ok: false, error: pick.error };
  const full = await getConnection(userId, pick.conn.id);
  if (!full || !full.secret_enc) return { ok: false, error: 'Não achei a chave privada no cofre.' };
  let priv;
  try { priv = decryptSecret(full.secret_enc); }
  catch { return { ok: false, error: 'Falha ao decifrar a chave (cofre).' }; }
  const usuarioFinal = usuario || full.meta?.usuario || 'root';
  const alvo = host || full.meta?.host;
  if (!alvo) return { ok: false, error: 'Não sei em qual servidor rodar. Me diga o host (IP ou domínio) do servidor.' };
  const keyPath = `${SSH_DIR}/run_${pick.conn.id}`;
  const w = await sandboxWrite(userId, keyPath, priv.endsWith('\n') ? priv : priv + '\n');
  if (!w.ok) return { ok: false, error: 'Não consegui preparar a chave no ambiente.' };
  const b64 = Buffer.from(String(comando), 'utf8').toString('base64');
  const remote = `echo ${b64} | base64 -d | bash`;
  const cmd = `chmod 600 ${shq(keyPath)} && mkdir -p ${SSH_DIR} && touch ${shq(KNOWN_HOSTS)} && ssh -i ${shq(keyPath)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${shq(KNOWN_HOSTS)} -o ConnectTimeout=15 ${shq(usuarioFinal + '@' + alvo)} ${shq(remote)}`;
  let res;
  try { res = await sandboxShell(userId, cmd, timeout); }
  finally { await sandboxShell(userId, `rm -f ${shq(keyPath)}`, 10_000); }
  return {
    ok: res.exitCode === 0,
    host: alvo,
    exit: res.exitCode,
    saida: res.stdout || '',
    stderr: res.stderr || '',
    error: res.exitCode === 0 ? undefined : `Comando terminou com código ${res.exitCode}.`,
  };
}

// Existe alguma máquina conectada (chave SSH no cofre)? Usado pra decidir se o
// modo LIVRE se aplica (terminal ao vivo em vez do toolset básico).
export async function userHasSshKey(userId) {
  try {
    const conns = await listConnections(userId);
    return conns.some((c) => c.kind === 'ssh_key');
  } catch { return false; }
}

// ── Modo LIVRE: sessão persistente NA máquina conectada do usuário ──
//
// No tier avançado (perm_mode 'livre') o assistente NÃO fica retransmitindo
// comando por comando de um sandbox pelado: ele opera COMO SE estivesse logado
// na máquina que o usuário conectou. Tecnicamente ainda saímos do sandbox SP
// (o sandbox é só o CLIENTE SSH: custódia da chave cifrada + egress BR), mas a
// sessão é PERSISTENTE, diferente do sshExec stateless:
//  • ControlMaster/ControlPersist: uma conexão só, multiplexada e reusada a cada
//    comando (sem re-handshake), então parece um shell vivo.
//  • cwd PERSISTENTE por thread: um `cd` num comando vale pro próximo, porque a
//    gente rastreia o diretório atual e prefixa `cd <cwd>` no comando seguinte.
// O terminal é NÃO-gated: o dono já assumiu o risco ao ligar o modo livre e
// conectar o PRÓPRIO host (o risco é da máquina dele). Segredos ainda são
// mascarados na SAÍDA (rede de segurança do histórico), como no sshExec.
const CWD = new Map(); // `${userId}:${threadId}:${connId}` -> diretório atual remoto
const CWD_MARK = '__BRAMBS_CWD__';

export async function livreExec(userId, comando, { threadId, host, usuario, rotulo, timeout = 180_000 } = {}) {
  if (!(await sshAvailable(userId))) return { ok: false, error: NO_SSH };
  if (!comando) return { ok: false, error: 'Sem comando pra rodar.' };
  const conns = await listConnections(userId);
  const pick = pickKeyConn(conns, host, rotulo);
  if (pick.error) return { ok: false, error: pick.error };
  const full = await getConnection(userId, pick.conn.id);
  if (!full || !full.secret_enc) return { ok: false, error: 'Não achei a chave privada no cofre.' };
  let priv;
  try { priv = decryptSecret(full.secret_enc); }
  catch { return { ok: false, error: 'Falha ao decifrar a chave (cofre).' }; }
  const usuarioFinal = usuario || full.meta?.usuario || 'root';
  const alvo = host || full.meta?.host;
  if (!alvo) return { ok: false, error: 'Não sei em qual máquina rodar. Me diga o host (IP ou domínio) da máquina conectada.' };
  const keyPath = `${SSH_DIR}/livre_${pick.conn.id}`;
  const w = await sandboxWrite(userId, keyPath, priv.endsWith('\n') ? priv : priv + '\n');
  if (!w.ok) return { ok: false, error: 'Não consegui preparar a chave no ambiente.' };
  // cwd persistente por (usuário, thread, conexão): um `cd` vale pro próximo comando.
  // Chave do ALVO (usuário+host). Entra no socket do ControlMaster e no cwd:
  // os dois são estado de UMA sessão, e sessão é por máquina, não por credencial.
  const alvoKey = createHash('sha256').update(`${usuarioFinal}@${alvo}`).digest('hex').slice(0, 12);
  const cwdKey = `${userId}:${threadId || 'no-thread'}:${pick.conn.id}:${alvoKey}`;
  const cwd = CWD.get(cwdKey) || '';
  // Envolve o comando: entra no cwd rastreado (ou ~), roda, e emite o pwd final
  // num marcador pra gente atualizar o cwd. Assim um `cd` persiste sem shell vivo.
  const inner = cwd ? `cd ${shq(cwd)} 2>/dev/null || cd ~\n${comando}` : `cd ~\n${comando}`;
  const wrapped = `${inner}\n__brc=$?\nprintf '\\n${CWD_MARK}%s\\n' "$(pwd)"\nexit $__brc`;
  const b64 = Buffer.from(wrapped, 'utf8').toString('base64');
  const remote = `echo ${b64} | base64 -d | bash`;
  // O socket PRECISA do alvo no nome. Com ControlPersist=300 o master fica vivo
  // 5 min; se o nome dependesse só da conexão do cofre (uma chave costuma abrir
  // VÁRIAS máquinas), o comando pro host B era multiplexado no master do host A
  // e rodava na máquina errada, em silêncio.
  const sock = `${SSH_DIR}/cm_${pick.conn.id}_${alvoKey}.sock`;
  const sshOpts = [
    `-i ${shq(keyPath)}`,
    '-o BatchMode=yes',
    '-o StrictHostKeyChecking=accept-new',
    `-o UserKnownHostsFile=${shq(KNOWN_HOSTS)}`,
    '-o ConnectTimeout=15',
    '-o ControlMaster=auto',
    `-o ControlPath=${shq(sock)}`,
    '-o ControlPersist=300',
    '-o ServerAliveInterval=15',
  ].join(' ');
  const cmd = `chmod 600 ${shq(keyPath)} && mkdir -p ${SSH_DIR} && touch ${shq(KNOWN_HOSTS)} && ssh ${sshOpts} ${shq(usuarioFinal + '@' + alvo)} ${shq(remote)}`;
  let res;
  // Apaga a chave do disco depois; a conexão persiste pelo socket do ControlMaster,
  // então os próximos comandos reusam a sessão sem a chave estar em disco.
  try { res = await sandboxShell(userId, cmd, timeout); }
  finally { await sandboxShell(userId, `rm -f ${shq(keyPath)}`, 10_000); }
  let out = res.stdout || '';
  const idx = out.lastIndexOf(CWD_MARK);
  if (idx >= 0) {
    const newCwd = out.slice(idx + CWD_MARK.length).split('\n')[0].trim();
    if (newCwd) CWD.set(cwdKey, newCwd);
    out = out.slice(0, idx).replace(/\n+$/, '');
  }
  return {
    ok: res.exitCode === 0,
    host: alvo,
    cwd: CWD.get(cwdKey) || '~',
    exit: res.exitCode,
    saida: out,
    stderr: res.stderr || '',
    error: res.exitCode === 0 ? undefined : `Comando terminou com código ${res.exitCode}.`,
  };
}

// Toolset do modo LIVRE: um único terminal ao vivo, persistente e não-gated.
// `sshLivre` diz se ESTE agente tem direito ao SSH-in (categoria super + chave no
// cofre). Quando o livre veio SÓ do Runner (assistente comum amarrado à máquina
// local do dono), o único alvo legítimo é essa máquina: host/rotulo — que
// endereçam um servidor por SSH — somem do schema e o fallback pra livreExec é
// bloqueado no run. Sem isso, relaxar o gate do Runner daria SSH de brinde.
export function livreTools(userId, threadId, runnerBound = false, sshLivre = true) {
  if (!sandboxEnabled() || !vaultEnabled()) return [];
  const soRunner = runnerBound && !sshLivre;
  const alvo = soRunner
    ? `Terminal AO VIVO na MÁQUINA LOCAL do usuário (o computador dele, pelo ${marca().nome} Runner).`
    : 'Terminal AO VIVO na máquina que o usuário conectou (modo avançado/livre).';
  const consentimento = soRunner
    ? 'Roda DIRETO, sem pedir confirmação por comando (o dono instalou o Runner na máquina dele e amarrou VOCÊ a ele; a escrita fica confinada às pastas que ele autorizou lá).'
    : 'Roda DIRETO, sem pedir confirmação por comando (o dono ligou o modo livre neste host, o risco é da máquina dele).';
  const props = {
    comando: { type: 'string', description: 'comando shell a rodar na máquina conectada (pode ser multi-linha; pode usar cd, heredoc, pipes, &&). Prefira agrupar vários passos independentes aqui numa chamada só.' },
    comandos: { type: 'array', items: { type: 'string' }, description: 'ALTERNATIVA a "comando": lista de comandos pra rodar em sequência na MESMA chamada (viram um script, um por linha, na mesma sessão/cwd). Use pra agrupar passos que não dependem de ler a saída um do outro. Se quiser abortar no primeiro erro, use "comando" com &&.' },
  };
  if (!soRunner) {
    props.host = { type: 'string', description: 'host da máquina (só precisa se o usuário tiver mais de uma conectada). Opcional.' };
    props.rotulo = { type: 'string', description: 'rótulo da chave SSH a usar (o "label" que aparece no cofre). Passe isto quando você tiver mais de uma chave salva e o host não bastar pra escolher, ex: "aws-aosp-build". Opcional.' };
  }
  return [
    {
      name: 'terminal',
      description: `${alvo} Você opera COMO SE estivesse logado nela: roda QUALQUER comando de shell (ler, editar com heredoc/sed, instalar, compilar, build, git, systemctl, subir processo) e a saída volta pra você. A sessão é PERSISTENTE: o diretório atual é mantido entre comandos (um "cd projeto" vale pros próximos), então navegue de verdade em vez de reescrever caminho absoluto a cada comando. AGRUPE passos: cada chamada desta ferramenta custa um passo inteiro do seu turno — quando os próximos comandos não dependem de você LER a saída anterior pra decidir, mande todos numa chamada só (multi-linha, ou \`a && b && c\` pra abortar no primeiro erro, ou o parâmetro \`comandos\`). Ex.: criar pasta + escrever arquivo + rodar build = UMA chamada, não três. Separe em chamadas só quando precisar da saída pra decidir o passo seguinte. ${consentimento} O usuário aqui é técnico: mostre a saída/erro reais, sem maquiar. NUNCA ecoe segredo (conteúdo de .env, chave, token). Se ficar batendo no MESMO erro 2-3 vezes, PARE e resuma em vez de disparar comando no escuro. LOGO NO COMEÇO da sessão rode \`hostname; whoami; pwd; nproc\` pra confirmar que caiu na máquina certa: se o ambiente não bater com o que o usuário descreveu (host/recursos/pasta esperada), PARE e avise, não trabalhe na máquina errada.`,
      parameters: {
        type: 'object',
        properties: props,
        required: [],
      },
      async run({ comando, comandos, host, rotulo }) {
        // Trava dura: agente que só tem o Runner não endereça servidor por SSH,
        // nem se o modelo inventar host/rotulo (não estão no schema).
        if (soRunner) { host = undefined; rotulo = undefined; }
        // Batching: `comandos` (lista) vira um script rodado numa chamada só —
        // mesma sessão, mesmo cwd, uma ida-e-volta de rede e UM passo do turno.
        if (!comando && Array.isArray(comandos) && comandos.length) {
          comando = comandos.filter((c) => typeof c === 'string' && c.trim()).join('\n');
        }
        if (!comando || !String(comando).trim()) {
          return executionResult({ ok: false, error: 'Passe "comando" (string) ou "comandos" (lista de strings).' },'not_applied','terminal');
        }
        // Costura de transporte: se o usuário tem um Brambs Runner online, ELE
        // está amarrado a ESTE assistente (runnerBound, config em Conexões) e não
        // apontou um host/rótulo (que denotam uma máquina SSH específica), o
        // alvo é a MÁQUINA LOCAL dele (runner outbound). Senão, SSH-in de sempre.
        // Mesma assinatura de retorno nos dois; o maskSecrets abaixo cobre ambos.
        const useRunner = !host && !rotulo && runnerBound && runnerOnline(userId);
        if (!useRunner && soRunner) {
          return executionResult({ ok: false, error: `O ${marca().nome} Runner saiu do ar (a máquina do usuário desconectou). Peça pra ele reabrir o Runner na máquina dele e tente de novo.` },'not_applied','terminal');
        }
        const r = useRunner
          ? await runnerExec(userId, comando, { threadId, timeout: 180_000 })
          : await livreExec(userId, comando, { threadId, host, rotulo, timeout: 180_000 });
        return executionResult({
          ok: r.ok,
          host: r.host,
          cwd: r.cwd,
          exit: r.exit,
          // Mascara primeiro, corta depois, e diz que cortou: saída longa de
          // comando saía truncada sem marcador nenhum, então o modelo concluía
          // sobre um log que tinha visto pela metade.
          saida: comAviso(maskSecrets(r.saida || ''), 12000, 'saída'),
          stderr: comAviso(maskSecrets(r.stderr || ''), 4000, 'saída de erro'),
          error: r.error,
        },r.ok?'applied':'unknown','terminal');
      },
    },
  ];
}

export function sshTools(userId) {
  if (!sandboxEnabled() || !vaultEnabled()) return [];
  return [
    {
      name: 'gerar_chave_ssh',
      description: 'Gera um par de chaves SSH (ed25519) para o usuário acessar um servidor dele. A chave PRIVADA fica guardada cifrada no cofre; a resposta traz a chave PÚBLICA para o usuário colar em ~/.ssh/authorized_keys do servidor. O host e o usuário são OPCIONAIS aqui: se ainda não souber o endereço, gere a chave assim mesmo; o destino é definido na hora de rodar o primeiro comando (rodar_no_servidor).',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'endereço do servidor (IP ou domínio), ex: 1.2.3.4 ou meu.servidor.com (opcional)' },
          usuario: { type: 'string', description: 'usuário de login no servidor, ex: ubuntu, root, ec2-user (opcional)' },
          rotulo: { type: 'string', description: 'nome amigável pra identificar essa chave (opcional)' },
        },
        required: [],
      },
      async run({ host, usuario, rotulo }) {
        if (!(await sshAvailable(userId))) return executionResult({ok:false,error:NO_SSH},'not_applied','ssh_key_create');
        const nome = rotulo || host || 'chave-ssh';
        const id = 'k' + Math.abs(Date.now() % 1e9).toString(36) + Math.floor((Date.now() / 7) % 1e6).toString(36);
        const base = `${SSH_DIR}/gen_${id}`;
        const mk = await sandboxShell(
          userId,
          `mkdir -p ${SSH_DIR} && chmod 700 ${SSH_DIR} && ssh-keygen -t ed25519 -N '' -C ${shq('brambs-' + nome)} -f ${shq(base)} >/dev/null 2>&1 && cat ${shq(base + '.pub')}`,
          30_000,
        );
        if (mk.exitCode !== 0) return executionResult({ok:false,error:`Não consegui gerar a chave: ${(mk.stderr || 'erro').slice(0, 200)}`},'unknown','ssh_key_create');
        const publicKey = (mk.stdout || '').trim();
        const priv = await sandboxRead(userId, base);
        if (!priv.ok || !priv.content) { await sandboxShell(userId, `rm -f ${shq(base)} ${shq(base + '.pub')}`, 10_000); return executionResult({ok:false,error:'Não consegui ler a chave privada gerada.'},'unknown','ssh_key_create'); }
        try {
          await addConnection(userId, {
            provider: 'ssh',
            kind: 'ssh_key',
            label: nome,
            secretEnc: encryptSecret(priv.content),
            meta: { host: host || null, usuario: usuario || null, public_key: publicKey, type: 'ed25519' },
          });
        } finally {
          await sandboxShell(userId, `rm -f ${shq(base)} ${shq(base + '.pub')}`, 10_000);
        }
        const destino = host ? ` do servidor (${(usuario || 'seu-usuario')}@${host})` : ' do servidor';
        return executionResult({ok:true,saida:[
          'Chave criada e guardada com segurança no cofre.',
          '',
          `Cole a chave PÚBLICA abaixo no arquivo ~/.ssh/authorized_keys${destino}:`,
          '',
          publicKey,
          '',
          host
            ? 'Depois disso me peça pra rodar um comando no servidor pra testar.'
            : 'Depois de colar, me diga o host (IP ou domínio) e o usuário, e eu rodo um comando no servidor pra testar.',
        ].join('\n')},'applied','ssh_key_create');
      },
    },
    {
      name: 'rodar_no_servidor',
      description: 'Executa um comando via SSH em um servidor do usuário, usando uma chave SSH já guardada no cofre. Só funciona depois que a chave pública foi colada no servidor (gerar_chave_ssh). Devolve a saída do comando.',
      parameters: {
        type: 'object',
        properties: {
          comando: { type: 'string', description: 'comando shell a rodar no servidor remoto' },
          host: { type: 'string', description: 'host do servidor (IP ou domínio). Obrigatório se a chave foi gerada sem host, ou se o usuário tem mais de uma chave.' },
          usuario: { type: 'string', description: 'usuário de login no servidor, ex: ubuntu, root. Use se a chave foi gerada sem usuário fixo (opcional).' },
          rotulo: { type: 'string', description: 'rótulo da chave SSH a usar (o "label" do cofre). Passe isto quando houver mais de uma chave e o host não bastar pra escolher, ex: "aws-aosp-build". Opcional.' },
        },
        required: ['comando'],
      },
      async run({ comando, host, usuario, rotulo }) {
        const r = await sshExec(userId, comando, { host, usuario, rotulo, timeout: 90_000 });
        return executionResult({
          ok: r.ok,
          host: r.host,
          exit: r.exit,
          saida: comAviso(maskSecrets(r.saida || ''), 6000, 'saída'),
          stderr: comAviso(maskSecrets(r.stderr || ''), 2000, 'saída de erro'),
          error: r.error,
        },r.ok?'applied':'unknown','ssh_command');
      },
    },
  ];
}
