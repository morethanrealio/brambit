import { createInboundDecisionResponder } from './inbound-decision.mjs';
import { createChecklistStore } from './checklists.mjs';
import { createEmpresaStore } from './empresa.mjs';
import { createWaInbox } from './whatsapp-inbox.mjs';
import {createCheckoutRecoveryStore} from './checkout-recovery.mjs';
import { createDiscoveryStore } from './discovery-store.mjs';
import {createPendingUsageWrites} from './incremental-usage.mjs';
import {conferirContaPagadora} from './conta-pagadora.mjs';
import { marca } from './marca.mjs';
import {createTaskMetrics} from './task-metrics.mjs';
import {createCreditSpend} from './credit-spend.mjs';
import { createOnboardingStore } from './onboarding-store.mjs';
import { appendThreadMessage, mergeThreadHistory } from './thread-history.mjs';
import { createVideoBillingStore } from './video-billing.mjs';
import { createRoutineExecutionStore, createRoutineExecutor } from './routine-execution.mjs';
import { createReminderExecutionStore } from './reminder-execution-store.mjs';
import { createConfirmationStore } from './confirmation-store.mjs';
import { prepareCurationChange } from './curation-config.mjs';
import { prepareEmailSearchChange } from './email-search-config.mjs';
import { createCurationStore } from './curation-store.mjs';
// ── Persistent memory + accounts (Postgres) ──
// Stores users, sessions, agents, raw message log and a short PROFILE
// that the agent builds up about the user. Everything in the mtr_harness schema
// (NEVER touch public). Connection via config (not URL) so the password isn't escaped.
import pg from 'pg';
import { createHash } from 'node:crypto';
import { encMaybe, decMaybe, encryptSecret, decryptSecret, vaultEnabled } from './vault.mjs';
import { IDIOMAS_OK, IDIOMA_PADRAO, normalizaIdioma, normalizaPais } from './locale.mjs';
import { matchingWikiLineSnippet, wikiSearchTerms } from './wiki-disclosure.mjs';

export const pgConfig = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'mara',
  user: process.env.PGUSER || 'mtragents',
  password: process.env.PGPASSWORD, // setado no .env (nunca no repo)
};
export const pool = new pg.Pool({ ...pgConfig, max: 4, idleTimeoutMillis: 30000 });

// WITHOUT THIS THE WHOLE PROCESS DIES. pg emits 'error' on the POOL when Postgres
// drops an IDLE connection (database maintenance sends `terminating connection
// due to administrator command`), and an EventEmitter with no 'error' listener becomes
// an unhandled exception: Node kills the process and systemd restarts it. Happened 4x
// between 2026-08-29 and 2026-09-03, always ~3am SP, taking down everything in flight (user
// turn, routine, delivery). Here we just log it: the broken client was already
// discarded by the pool itself and the next query opens a new connection.
pool.on('error', (err) => {
  console.error('[db] idle connection dropped by Postgres (pool stays alive):', err?.message ?? err);
});

export const pendingUsageWrites=createPendingUsageWrites();
export const checkoutRecoveryStore=createCheckoutRecoveryStore(pool,{encrypt:encryptSecret,decrypt:decryptSecret,enabled:vaultEnabled});
let checkoutCleanupTimer;

export const discoveryStore = createDiscoveryStore(pool);
export const taskMetrics = createTaskMetrics(pool);
export const creditSpend = createCreditSpend(pool);
// Database access for the calendar-change notice (calendar-watch.mjs), which
// receives tokens and sending from the server.
export const calendarWatchDb = { query: (...a) => pool.query(...a) };
export const checklistStore = createChecklistStore(pool);
export const waInbox = createWaInbox(pool,{seal:encryptSecret,open:decryptSecret,lookupRecipient:getWhatsAppLink});
export const onboardingStore = createOnboardingStore(pool);

export const S = 'mtr_harness';
// Company account F0 (empresa.mjs): company, domains, members and invites.
// What billing does on join and on creation a plugin wires in later
// (through empresaStore.ligar).
export const empresaStore = createEmpresaStore(pool, { S });
// Payer-account port (conta-pagadora.mjs): who pays for the consumption recorded here.
// Without it nothing records consumption (boot wires it up with configurarContaPagadora).
let contaPagadora = null;
export function configurarContaPagadora(c) { contaPagadora = conferirContaPagadora(c); }
const transacaoPagadora = (...a) => {
  if (!contaPagadora) throw Error('Conta pagadora não configurada: chame configurarContaPagadora no boot');
  return contaPagadora.transacao(...a);
};
export const videoBilling = createVideoBillingStore(pool, S, { transacao: transacaoPagadora });
export const routineExecutor = createRoutineExecutor(createRoutineExecutionStore(pool));
export const confirmationStore = createConfirmationStore(pool, { seal: encryptSecret, open: decryptSecret });
const reminderExecutionStore = createReminderExecutionStore(pool);
export const claimReminder = rem => reminderExecutionStore.claim(rem);
export const beginReminderDelivery = claim => reminderExecutionStore.begin(claim);
export const finishReminder = (claim, outcome) => reminderExecutionStore.finish(claim, outcome);
export const recoverReminderDeliveries = () => reminderExecutionStore.recoverExpired();
export const reminderDeliveryTracking = claim => reminderExecutionStore.deliveryTracking(claim);
export const recordReminderDeliveryStatus = status => reminderExecutionStore.recordDeliveryStatus(status);
export const getReminderDeliveryMetrics = () => reminderExecutionStore.metrics();
export const listReminderOccurrences = (userId, reminderId, options) => reminderExecutionStore.listOccurrences(userId, reminderId, options);
export const curationStore = createCurationStore(pool); // opt-in; no automatic init/migration

// Removes stray UTF-16 surrogates (emoji cut in half) and NUL before saving.
// Postgres jsonb and text columns reject the whole row if this shows up.
const _RPL = String.fromCharCode(0xFFFD), _NUL = String.fromCharCode(0);
export function clean(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, _RPL)
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, _RPL)
    .split(_NUL).join('');
}
// Recursively sanitizes the history (array of messages) before JSON.stringify.
export function cleanDeep(v) {
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = cleanDeep(v[k]);
    return o;
  }
  return v;
}

// A plugin's schema (e.g. billing, campaigns, cockpit, feed tables) arrives
// as an argument and runs right after the core schema.
export async function initDb(...esquemas) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${S}.users (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name          text NOT NULL,
      email         text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      created_at    timestamptz DEFAULT now()
    );
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS media_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS email_send_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS model_pref text NOT NULL DEFAULT 'g3';
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS home_refresh_at timestamptz;
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS home_seen_mark text;
    ALTER TABLE ${S}.users ALTER COLUMN model_pref SET DEFAULT 'flash';
    UPDATE ${S}.users SET model_pref = 'flash' WHERE model_pref = 'auto';
    UPDATE ${S}.users SET model_pref = 'flash' WHERE model_pref = 'g3';
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS model_auto boolean NOT NULL DEFAULT false;
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS timezone text;
    -- User language and country (basis of multi-language, 07/09).
    -- NULL in both = not known yet, and readers fall back to pt-BR/Brazil.
    -- Kept SEPARATE on purpose: language is how the person wants to be served
    -- (they choose), country is where they are (sets price and what exists for
    -- them, e.g. Asaas only in Brazil). A Spaniard living in Brazil wants es + BR.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS language text;
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS country text;
    -- Descadastro de e-mails institucionais/novidades (marketing). SEPARADO do
    -- e-mail transacional/de rotina: opt-out aqui NÃO bloqueia briefing/resposta
    -- que o próprio usuário pediu; só corta comunicação em massa do time.
    -- unsub_token: segredo por-usuário do link de descadastro (sem login).
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS email_optout boolean NOT NULL DEFAULT false;
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS email_optout_at timestamptz;
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS unsub_token text;
    -- Where the person CAME FROM (03/09): Google Ads gclid/gbraid, utm_* from
    -- any campaign, external referrer and the landing page. The front captures
    -- on FIRST touch and sends it when the account is created (POST /api/atribuicao).
    -- Exists because the Ads conversion answers "how many" but not "who":
    -- without it there's no way to tie a sign-up to the click that brought it.
    -- jsonb so a new campaign parameter needs no migration.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS attribution jsonb;
    -- Convites (indicação). Na PRIMEIRA vez que a coluna é criada, o DEFAULT 3
    -- preenche TODOS os usuários já existentes (a comunidade atual ganha 3 de
    -- largada). Em seguida o default vira 0, então novos cadastros nascem com 0
    -- convites. Como é ADD COLUMN IF NOT EXISTS, restart não re-semeia.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS invites_total int NOT NULL DEFAULT 3;
    ALTER TABLE ${S}.users ALTER COLUMN invites_total SET DEFAULT 0;
    -- Member-get-member overhaul (28/08): the 4-digit code is worth 10
    -- referrals for EVERYONE, and every new sign-up can refer right away
    -- (default 0 -> 10). The UPDATE is data-guarded: it runs while nobody has
    -- 10, and after the first pass everyone does, so a restart doesn't reseed or
    -- overwrite a later manual tweak. Nobody loses a used referral: usage is
    -- counted in users.referred_by, not here.
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM ${S}.users WHERE invites_total = 10) THEN
        UPDATE ${S}.users SET invites_total = 10;
      END IF;
    END
    $do$;
    ALTER TABLE ${S}.users ALTER COLUMN invites_total SET DEFAULT 10;
    -- NEW referral model (v2, 19/08): marks the OWNER of a v2 code. Only turned
    -- on on demand, by an operator. A v2 code is usable 100×, the referred user
    -- gets the 3000 plan (Básico) free in the Beta, and the owner earns +500
    -- credits when the referred user verifies their e-mail (bonus expires in 90d).
    -- OLD codes (v2=false) stay untouched: referred users start at 6000, no bonus.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS referral_v2 boolean NOT NULL DEFAULT false;
    -- Marca no INDICADO se o bônus de +500 pro indicador dele já foi concedido
    -- (idempotência; só vale pra indicação v2). null/false = ainda não concedido.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS ref_bonus_done boolean NOT NULL DEFAULT false;
    -- Marks on the REFERRED user whether the SIGN-UP bonus (+200, referrer only)
    -- was paid. New rule (08/09): referrals pay at two moments, 200 when the
    -- referred user starts using it and 500 when they subscribe (the subscribe
    -- one is ref_bonus_done above, still for both sides).
    -- The DEFAULT starts true on purpose and becomes false right after: so
    -- EVERYONE already existing is marked as paid and the 22 old referrals don't
    -- become retroactive credit (decided 08/09), while every new sign-up starts
    -- false and eligible. Being ADD COLUMN IF NOT EXISTS, a restart doesn't
    -- reseed.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS ref_signup_bonus_done boolean NOT NULL DEFAULT true;
    ALTER TABLE ${S}.users ALTER COLUMN ref_signup_bonus_done SET DEFAULT false;
    -- Quem indicou este usuário (null = entrou pela whitelist/admin, sem indicação).
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES ${S}.users(id) ON DELETE SET NULL;
    -- Código de indicação de 4 dígitos (1000-9999). O convidado informa este código
    -- no cadastro; o débito acontece na conta do dono do código. Único (ignorando nulos).
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS referral_code char(4);
    CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_uidx
      ON ${S}.users(referral_code) WHERE referral_code IS NOT NULL;
    -- Backfill ÚNICO: só roda enquanto NINGUÉM tem código (primeira vez). Assim a
    -- comunidade ATUAL ganha códigos e novos cadastros nascem SEM código; restart não
    -- re-semeia nem dá código a quem entrou depois. Códigos distintos, ordem aleatória.
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM ${S}.users WHERE referral_code IS NOT NULL) THEN
        WITH targets AS (
          SELECT id, row_number() OVER (ORDER BY random()) AS rn FROM ${S}.users
        ),
        codes AS (
          SELECT g AS code, row_number() OVER (ORDER BY random()) AS rn
            FROM generate_series(1000, 9999) g
        )
        UPDATE ${S}.users u
           SET referral_code = lpad(c.code::text, 4, '0')
          FROM targets t JOIN codes c ON c.rn = t.rn
         WHERE u.id = t.id;
      END IF;
    END
    $do$;
    -- ACCOUNT DELETION requested by the owner (required by App Store guideline
    -- 5.1.1(v), and the LGPD right to erasure). 30-day model (04/09): on
    -- request the account is CLOSED at once (deleted_at set, access revoked,
    -- third-party credentials deleted, billing cancelled) and the data is only
    -- actually destroyed in purgeContasExcluidas, 30 days later. The window is
    -- for regret/mistakes, not to keep the account up: while deleted_at is
    -- set, nobody gets in.
    -- NULL = live account. Never go back to NULL without deliberately reopening.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    CREATE INDEX IF NOT EXISTS users_deleted_idx
      ON ${S}.users(deleted_at) WHERE deleted_at IS NOT NULL;
    -- SIGN IN WITH APPLE (diretriz 4.8, set/26). A Apple deixa a pessoa esconder
    -- o e-mail real por trás de um relay (@privaterelay.appleid.com), e esse
    -- endereço pode mudar se ela desligar o encaminhamento. Ou seja: e-mail
    -- deixa de servir como identidade estável. apple_sub é o identificador que
    -- a Apple garante constante pro par (pessoa, time de desenvolvedor) — é ELE
    -- que amarra o login, e o e-mail vira só um dado de contato.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS apple_sub text;
    CREATE UNIQUE INDEX IF NOT EXISTS users_apple_sub_idx
      ON ${S}.users(apple_sub) WHERE apple_sub IS NOT NULL;
    -- Guardado só pra poder chamar /auth/revoke na exclusão de conta: a
    -- 5.1.1(v) exige desfazer o vínculo do lado da Apple, e o refresh token só
    -- existe no instante do primeiro login. Não serve pra mais nada aqui.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS apple_refresh_token text;
    -- Marca que o e-mail é relay. Importa pra suporte e pra entrega: mensagem
    -- pra relay só chega se o domínio remetente estiver registrado no portal da
    -- Apple, então é bom saber de quem estamos falando quando um envio falhar.
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS apple_private_email boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS ${S}.sessions (
      token      text PRIMARY KEY,
      user_id    uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      created_at timestamptz DEFAULT now()
    );
    ALTER TABLE ${S}.sessions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
    ALTER TABLE ${S}.sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
    UPDATE ${S}.sessions SET expires_at = created_at + interval '30 days' WHERE expires_at IS NULL;
    UPDATE ${S}.sessions SET last_seen_at = now() WHERE last_seen_at IS NULL;
    CREATE TABLE IF NOT EXISTS ${S}.agents (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      owner        text NOT NULL,
      name         text NOT NULL,
      goal         text DEFAULT '',
      instructions text DEFAULT '',
      profile      text DEFAULT '',
      summary      text DEFAULT '',
      history      jsonb DEFAULT '[]'::jsonb,
      created_at   timestamptz DEFAULT now()
    );
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES ${S}.users(id) ON DELETE CASCADE;
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS instructions text DEFAULT '';
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS summary text DEFAULT '';
    -- Fase 2 coding: modo de permissão pra ações de escrita (padrao|aceitar_edicoes|plano)
    -- e allowlist de prefixos de comando pré-autorizados (pulam a confirmação).
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS perm_mode text DEFAULT 'padrao';
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS cmd_allowlist jsonb DEFAULT '[]'::jsonb;
    -- Modelo FIXO atribuido manualmente a este agente (ex: 'kimi3'), fora do
    -- roteamento automatico. NULL = usa o roteador padrao do produto.
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS model text;
    -- estilo/tom POR AGENTE (analogo a um CLAUDE.local.md do assistente): como
    -- ELE fala/escreve. Sempre injetado no system deste agente e so dele; nao
    -- vaza pros outros assistentes do mesmo dono (isso e a camada perfil/wiki).
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS style text DEFAULT '';
    -- rename: nomes antigos do assistente (o dono pode trocar o nome). Guardamos
    -- pra ele se reconhecer no histórico ("antes eu era Bento") e não se perder.
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS former_names jsonb DEFAULT '[]'::jsonb;
    -- soft-delete: agente arquivado some das listas mas o histórico (threads,
    -- messages) fica preservado na conta do dono.
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS archived_at timestamptz;
    -- multi-conta Google: e-mail da conta Google que ESTE agente opera (Gmail,
    -- Drive, Agenda). NULL = usa a conta principal do dono (fallback). O vínculo
    -- é reatribuível pelo dono. Ver google_accounts.
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS google_email text;
    -- CATEGORIA do agente (define o perfil de segurança/capacidade):
    --   'pessoal' = assistente 1:1 do dono, arsenal completo com confirmação (default).
    --   'grupo'   = sub-agente de canal multi-pessoa. Toolset RESTRITO a uma
    --               allow-list (tool_config.groups); tools que tocam a CONTA do dono
    --               (Google/Microsoft/GitHub/Slack pessoais, MCP, cofre) e a
    --               auto-reconfiguração (definir_modo_permissao/permitir_comando,
    --               gerar_chave_ssh pra host novo, agente-a-agente) ficam SEMPRE
    --               bloqueadas, mesmo com shell/código habilitados. Shell mira só o
    --               box dedicado (tool_config.host).
    --   'super'   = modo livre (terminal ao vivo). Só selecionável 1:1 e com servidor
    --               conectado. Live-feed só na DM do dono.
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS category text DEFAULT 'pessoal';
    -- Config do toolset por agente (usado na categoria 'grupo'): { groups: [...],
    -- host: '<box dedicado>' }. Vazio = nenhum grupo liberado.
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS tool_config jsonb DEFAULT '{}'::jsonb;
    CREATE TABLE IF NOT EXISTS ${S}.messages (
      id        bigserial PRIMARY KEY,
      agent_id  uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      role      text NOT NULL,
      content   text NOT NULL,
      ts        timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_agent_idx ON ${S}.messages(agent_id, ts);
    CREATE INDEX IF NOT EXISTS agents_user_idx ON ${S}.agents(user_id);
    -- Tokens OAuth do Google por usuário (autorização incremental de conectores).
    -- scope guarda os escopos já concedidos; refresh_token deixa o agente agir depois.
    CREATE TABLE IF NOT EXISTS ${S}.google_tokens (
      user_id       uuid PRIMARY KEY REFERENCES ${S}.users(id) ON DELETE CASCADE,
      access_token  text,
      refresh_token text,
      scope         text DEFAULT '',
      expiry        timestamptz,
      updated_at    timestamptz DEFAULT now()
    );
    -- Multi-conta Google: N contas por usuário, uma por e-mail Google. Um agente
    -- é vinculado a UMA conta (coluna agents.google_email). Substitui o modelo de
    -- 1 conta por usuário do google_tokens (mantido só como legado até a migração).
    CREATE TABLE IF NOT EXISTS ${S}.google_accounts (
      user_id       uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      google_email  text NOT NULL,
      access_token  text,
      refresh_token text,
      scope         text DEFAULT '',
      expiry        timestamptz,
      is_primary    boolean NOT NULL DEFAULT false,
      updated_at    timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, google_email)
    );
    -- Backfill idempotente: traz a conta única de cada usuário do google_tokens
    -- (hoje a conta conectada == o e-mail de login), marcada como principal.
    INSERT INTO ${S}.google_accounts (user_id, google_email, access_token, refresh_token, scope, expiry, is_primary, updated_at)
      SELECT gt.user_id, lower(u.email), gt.access_token, gt.refresh_token, gt.scope, gt.expiry, true, gt.updated_at
        FROM ${S}.google_tokens gt JOIN ${S}.users u ON u.id = gt.user_id
       WHERE u.email IS NOT NULL
      ON CONFLICT (user_id, google_email) DO NOTHING;
    -- Wiki de memória POR USUÁRIO (compartilhada entre todos os Claws da pessoa).
    -- Páginas markdown que o agente cria/atualiza (modelo Karpathy). slug único por usuário.
    CREATE TABLE IF NOT EXISTS ${S}.wiki_pages (
      user_id    uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      slug       text NOT NULL,
      title      text NOT NULL DEFAULT '',
      body       text NOT NULL DEFAULT '',
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, slug)
    );
    -- Bots de Telegram TRAZIDOS pelo usuário (token do BotFather dele).
    -- Cada usuário roda o próprio bot, ligado a um agente. chat_id é amarrado
    -- no primeiro /start (só esse chat é atendido).
    -- O TOKEN não fica em claro: token_hash (sha256) é a chave de busca e
    -- token_enc guarda o valor cifrado pelo cofre. Quem fala com a API do
    -- Telegram precisa do token original, então tem que ser recuperável (por
    -- isso cifrado, não só hash).
    CREATE TABLE IF NOT EXISTS ${S}.telegram_bots (
      token_hash   text PRIMARY KEY,
      user_id      uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id     uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      bot_username text DEFAULT '',
      chat_id      text,
      enabled      boolean DEFAULT true,
      created_at   timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS telegram_user_idx ON ${S}.telegram_bots(user_id);
    -- Último update_id confirmado do getUpdates. Sem persistir, um restart do
    -- processo re-entregava os updates ainda não confirmados e o usuário
    -- recebia a mesma resposta em dobro.
    ALTER TABLE ${S}.telegram_bots ADD COLUMN IF NOT EXISTS last_update_id bigint NOT NULL DEFAULT 0;
    -- Instalação antiga: a PK era o token em CLARO. Renomeia a coluna (o valor
    -- vira hash no backfill pós-cofre, migrateConnectorSecrets) e abre espaço
    -- pro token cifrado. Renomear preserva a PK e não tem FK apontando pra cá.
    DO $mig$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = '${S}' AND table_name = 'telegram_bots' AND column_name = 'token') THEN
        ALTER TABLE ${S}.telegram_bots RENAME COLUMN token TO token_hash;
      END IF;
    END $mig$;
    ALTER TABLE ${S}.telegram_bots ADD COLUMN IF NOT EXISTS token_enc text;
    -- Código de pareamento. O chat só é amarrado por "/start <código>", e o
    -- código só aparece na tela de Conexões do DONO (sessão autenticada). Antes
    -- o vínculo era feito na PRIMEIRA mensagem que chegasse, então qualquer um
    -- que achasse o @username do bot antes do dono virava o dono do chat.
    ALTER TABLE ${S}.telegram_bots ADD COLUMN IF NOT EXISTS pair_code text;
    UPDATE ${S}.telegram_bots SET pair_code = substr(md5(random()::text || token_hash), 1, 12)
      WHERE pair_code IS NULL;
    -- THREADS: cada assistente tem N threads (= tópicos/tarefas), resgatáveis.
    -- O history/summary da conversa vive AQUI (por thread), não mais no agente.
    -- A memória do usuário (wiki/perfil) segue compartilhada e por usuário.
    CREATE TABLE IF NOT EXISTS ${S}.threads (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id   uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      user_id    uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      title      text DEFAULT '',
      status     text DEFAULT 'open',
      history    jsonb DEFAULT '[]'::jsonb,
      summary    text DEFAULT '',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    -- Durable async programming receipts: appended atomically with conversation.
    CREATE TABLE IF NOT EXISTS ${S}.thread_delivery_receipts (
      thread_id uuid REFERENCES ${S}.threads(id) ON DELETE CASCADE,
      delivery_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(thread_id,delivery_key)
    );
    CREATE INDEX IF NOT EXISTS threads_user_idx ON ${S}.threads(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS threads_agent_idx ON ${S}.threads(agent_id);
    -- Log bruto passa a referenciar a thread (mantém agent_id pra compatibilidade).
    ALTER TABLE ${S}.messages ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES ${S}.threads(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS messages_thread_idx ON ${S}.messages(thread_id, ts);
    -- Anexos do turno (cards de produto, docs, imagens): guardados junto da mensagem
    -- do assistente pra reaparecerem ao reabrir a conversa (web e app). Antes só o
    -- texto era persistido, então o card sumia no reload.
    ALTER TABLE ${S}.messages ADD COLUMN IF NOT EXISTS attachments jsonb;
    -- Canal WhatsApp (número único compartilhado): o telefone do remetente amarra
    -- no USUÁRIO; o agente é escolhido dentro do chat (active_agent_id, trocável
    -- por @nome / menu). Um telefone -> um usuário.
    CREATE TABLE IF NOT EXISTS ${S}.whatsapp_links (
      wa_phone        text PRIMARY KEY,
      user_id         uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      active_agent_id uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      enabled         boolean DEFAULT true,
      created_at      timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS whatsapp_user_idx ON ${S}.whatsapp_links(user_id);
    -- Última vez que a PESSOA escreveu no WhatsApp. É o que define se a janela de
    -- 24h da Cloud API está aberta (mensagem de sessão) ou fechada (só template).
    -- Sem isso o envio proativo chutava "manda texto e vê no que dá", e a Meta
    -- ACEITA o texto fora da janela (HTTP 200) pra reprovar depois, em silêncio,
    -- por webhook de status (erro 131047) — 202 mensagens perdidas em 30 dias.
    ALTER TABLE ${S}.whatsapp_links ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;
    -- Prova de posse do número. Quem digita o telefone no app só CRIA um desafio
    -- aqui; quem amarra de verdade é o inbound daquele telefone com o código
    -- (consumeWaClaim). Sem isso, qualquer pessoa logada digitava o número de
    -- outra e sequestrava o roteamento de entrada dela, porque o upsert
    -- reatribuía o wa_phone ao novo user_id sem nenhuma prova.
    -- Uma linha por (telefone, usuário): assim uma conta não derruba o desafio
    -- pendente da outra.
    CREATE TABLE IF NOT EXISTS ${S}.wa_claims (
      wa_phone        text NOT NULL,
      user_id         uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      active_agent_id uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      code            text NOT NULL,
      expires_at      timestamptz NOT NULL,
      created_at      timestamptz DEFAULT now(),
      PRIMARY KEY (wa_phone, user_id)
    );
    -- Referência de mensagens do WhatsApp por wamid (id da Cloud API). Guarda o
    -- texto de cada mensagem (recebida e enviada) pra resolver o recurso de
    -- "responder/citar": o webhook de entrada traz só o id da msg citada
    -- (msg.context.id), NUNCA o texto; sem esta tabela a citação vira nada e o
    -- assistente "não entende" a que mensagem o usuário se refere.
    CREATE TABLE IF NOT EXISTS ${S}.whatsapp_msg_refs (
      wamid       text PRIMARY KEY,
      user_id     uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id    uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      direction   text,               -- 'in' (do usuário) | 'out' (do assistente)
      body        text NOT NULL,
      created_at  timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS whatsapp_msg_refs_user_idx ON ${S}.whatsapp_msg_refs(user_id, created_at DESC);
    -- Dedup de retry da Meta, DURÁVEL. Era um Set em memória: todo restart/deploy
    -- (e todo clear() ao passar de 5000 ids) zerava a lista, e o retry da Meta
    -- fazia a MESMA mensagem ser processada de novo do zero — o "processou duas
    -- vezes" que o usuário vê. Tabela própria em vez de reusar whatsapp_msg_refs:
    -- lá o body é NOT NULL e o INSERT com ON CONFLICT DO NOTHING mataria a
    -- gravação do texto real depois, quebrando o recurso de citar mensagem.
    CREATE TABLE IF NOT EXISTS ${S}.whatsapp_seen (
      wamid       text PRIMARY KEY,
      created_at  timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS whatsapp_seen_created_idx ON ${S}.whatsapp_seen(created_at);
    -- Backfill único do last_inbound_at a partir do histórico de entrada que já
    -- temos. Sem isto, no primeiro dia depois do deploy TODO mundo apareceria
    -- como "janela fechada" e receberia template (texto achatado) mesmo estando
    -- em conversa ativa. Só preenche quem está nulo, então é idempotente.
    UPDATE ${S}.whatsapp_links w
       SET last_inbound_at = r.ultima
      FROM (SELECT user_id, max(created_at) AS ultima
              FROM ${S}.whatsapp_msg_refs
             WHERE direction = 'in' GROUP BY user_id) r
     WHERE w.user_id = r.user_id AND w.last_inbound_at IS NULL;
    -- Slack channel (app installed in a workspace): whoever mentions the app in
    -- Slack (or DMs it) is bound to the platform USER by Slack email; the agent
    -- is picked inside the chat (active_agent_id, switchable via @name / "menu").
    -- Key = (team, Slack user) -> one platform user. Mirrors whatsapp_links
    -- (single shared number) and email routing.
    CREATE TABLE IF NOT EXISTS ${S}.slack_links (
      slack_team_id   text NOT NULL,
      slack_user_id   text NOT NULL,
      user_id         uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      active_agent_id uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      enabled         boolean DEFAULT true,
      created_at      timestamptz DEFAULT now(),
      PRIMARY KEY (slack_team_id, slack_user_id)
    );
    CREATE INDEX IF NOT EXISTS slack_user_idx ON ${S}.slack_links(user_id);
    -- Slack: PER-CHANNEL BINDING (group/DM) -> one specific assistant. The main
    -- inbound model: "assistant A in group X, B in group Y", all by code.
    -- Key = (team, channel). The binding is created by using a pairing code
    -- generated in the web app (logged in, for an agent the owner has). Takes
    -- precedence over the email fallback (which only applies to an unbound DM).
    CREATE TABLE IF NOT EXISTS ${S}.slack_channel_links (
      slack_team_id    text NOT NULL,
      slack_channel_id text NOT NULL,
      user_id          uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id         uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      created_by       text,
      created_at       timestamptz DEFAULT now(),
      PRIMARY KEY (slack_team_id, slack_channel_id)
    );
    CREATE INDEX IF NOT EXISTS slack_channel_user_idx ON ${S}.slack_channel_links(user_id);
    -- Slack pairing codes: single use, short TTL. Generated in the web app
    -- (logged in) for an owner's agent; used by "conectar <code>" in Slack.
    CREATE TABLE IF NOT EXISTS ${S}.slack_pairing_codes (
      code       text PRIMARY KEY,
      user_id    uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id   uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      used_at    timestamptz,
      created_at timestamptz DEFAULT now()
    );
    -- Extensão do Chrome: qual ÚNICO assistente atende as mensagens da extensão
    -- daquele usuário. Espelha o "assistente ativo" do Slack/WhatsApp, mas por
    -- USUÁRIO (a extensão é 1 por pessoa). Antes era só em memória (extActiveAgent),
    -- agora persiste pra o dono configurar em Conexões. @nome no chat continua
    -- sobrepondo por mensagem; unset => primeiro assistente (mesmo default de antes).
    CREATE TABLE IF NOT EXISTS ${S}.ext_links (
      user_id         uuid PRIMARY KEY REFERENCES ${S}.users(id) ON DELETE CASCADE,
      active_agent_id uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      created_at      timestamptz DEFAULT now()
    );
    -- ROTINAS: tarefas recorrentes por (usuário + assistente). Disparam por
    -- HORÁRIO local; o agente executa o prompt e o resultado vai por e-mail.
    -- days: guarda a cadência INTEIRA em texto (sem coluna nova). Formas:
    --   'daily' | 'weekdays' | 'weekends'  baldes legados
    --   '[1,4]'                            dias da semana (0=dom .. 6=sáb)
    --   '{"mes":[1,15]}'                   dias do mês (-1 = último dia)
    --   '{"nth":2,"dow":[1]}'              Nª ocorrência do dia no mês (-1 = última)
    -- Quem lê/escreve isso é scheduler.mjs (parseRoutineDays/normalizeRoutineDays).
    -- last_run_day dedup (1x/dia).
    CREATE TABLE IF NOT EXISTS ${S}.routines (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id     uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      title        text NOT NULL,
      prompt       text NOT NULL,
      hour         int  NOT NULL DEFAULT 7,
      days         text NOT NULL DEFAULT 'daily',
      tz           text NOT NULL DEFAULT 'America/Sao_Paulo',
      channel      text NOT NULL DEFAULT 'email',
      enabled      boolean DEFAULT true,
      last_run_day text DEFAULT '',
      config       jsonb DEFAULT '{}'::jsonb,
      created_at   timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS routines_user_idx ON ${S}.routines(user_id);
    CREATE INDEX IF NOT EXISTS routines_due_idx ON ${S}.routines(enabled, hour);
    -- EXECUÇÕES EXTRAS pontuais de uma rotina existente. Diferente de reminders:
    -- no horário o scheduler executa de verdade o prompt e a entrega configurada
    -- da rotina, sem alterar days/hour/last_run_day da cadência normal. Status
    -- running vencido vira uncertain e nunca é repetido automaticamente.
    CREATE TABLE IF NOT EXISTS ${S}.routine_one_shots (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      routine_id  uuid NOT NULL REFERENCES ${S}.routines(id) ON DELETE CASCADE,
      user_id     uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      run_at      timestamptz NOT NULL,
      status      text NOT NULL DEFAULT 'pending',
      outcome     jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      started_at  timestamptz,
      finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS routine_one_shots_due_idx ON ${S}.routine_one_shots(status, run_at);
    CREATE UNIQUE INDEX IF NOT EXISTS routine_one_shots_pending_idx
      ON ${S}.routine_one_shots(routine_id, run_at) WHERE status='pending';
    -- LEMBRETES pontuais (one-off): o agente cria na conversa (tool criar_lembrete)
    -- com data/hora EXATA (run_at). O scheduler dispara quando run_at <= now() e
    -- entrega a mensagem no canal escolhido. O ledger discrimina aceitação do
    -- provedor de falha/incerteza; sent legado significa apenas accepted.
    CREATE TABLE IF NOT EXISTS ${S}.reminders (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id   uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      message    text NOT NULL,
      run_at     timestamptz NOT NULL,
      channel    text NOT NULL DEFAULT 'telegram',
      status     text NOT NULL DEFAULT 'pending',
      created_at timestamptz DEFAULT now(),
      sent_at    timestamptz
    );
    CREATE INDEX IF NOT EXISTS reminders_due_idx ON ${S}.reminders(status, run_at);
    CREATE INDEX IF NOT EXISTS reminders_user_idx ON ${S}.reminders(user_id);
    -- Idempotência e histórico por ocorrência são instalados pelo reminder
    -- execution store, após as colunas de recorrência. A identidade inclui
    -- canal e cadência para preservar ações diferentes no mesmo horário.
    -- RECORRÊNCIA de granularidade livre (lembrete E rotina). repeat_every_min = de
    -- quantos em quantos MINUTOS repete (NULL = disparo único / rotina diária clássica).
    -- repeat_until = até quando repetir (NULL = sem fim; só permitido p/ intervalo >= 1
    -- dia). Piso de 1 min (o scheduler tica a cada 60s; sub-minuto não faz sentido). Regra
    -- de produto: recorrência SUB-DIÁRIA (< 1 dia) SEMPRE tem fim (o assistente pergunta
    -- "por quanto tempo?"); >= 1 dia pode ser aberta (o dono para quando quiser). A rotina
    -- em modo intervalo usa next_run (próximo disparo) no lugar de hora/last_run_day.
    ALTER TABLE ${S}.reminders ADD COLUMN IF NOT EXISTS repeat_every_min int, ADD COLUMN IF NOT EXISTS repeat_until timestamptz;
    ALTER TABLE ${S}.routines  ADD COLUMN IF NOT EXISTS repeat_every_min int;
    ALTER TABLE ${S}.routines  ADD COLUMN IF NOT EXISTS repeat_until timestamptz;
    ALTER TABLE ${S}.routines  ADD COLUMN IF NOT EXISTS next_run timestamptz;
    ALTER TABLE ${S}.routines  ADD COLUMN IF NOT EXISTS minute int NOT NULL DEFAULT 0; -- 22h30 = hour 22 + minute 30 (routine-time.mjs)
    -- USO/CUSTO: uma linha por CHAMADA ao modelo (1 turno pode ter N chamadas
    -- por causa do tool-loop). turn_id agrupa as chamadas do mesmo turno.
    -- kind: chat | onboard | routine | telegram | whatsapp | housekeeping.
    -- cost_usd é congelado no momento da gravação (preço histórico), pra relatório
    -- não mudar quando a tabela de preços mudar.
    CREATE TABLE IF NOT EXISTS ${S}.usage_events (
      id         bigserial PRIMARY KEY,
      ts         timestamptz DEFAULT now(),
      user_id    uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
      agent_id   uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      thread_id  uuid REFERENCES ${S}.threads(id) ON DELETE SET NULL,
      turn_id    uuid,
      kind       text NOT NULL DEFAULT 'chat',
      model      text NOT NULL DEFAULT '',
      tok_in     int  NOT NULL DEFAULT 0,
      tok_cached int  NOT NULL DEFAULT 0,
      tok_out    int  NOT NULL DEFAULT 0,
      tok_think  int  NOT NULL DEFAULT 0,
      tok_total  int  NOT NULL DEFAULT 0,
      cost_usd   numeric(12,6) NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS usage_ts_idx ON ${S}.usage_events(ts);
    CREATE INDEX IF NOT EXISTS usage_user_idx ON ${S}.usage_events(user_id, ts);
    CREATE INDEX IF NOT EXISTS usage_turn_idx ON ${S}.usage_events(turn_id);
    -- Credit BILLING (18/08): credit charged per row, computed from token
    -- QUANTITY at a rate WE set (BILL_RATE per tier), NOT from real cost
    -- (cost_usd, kept only for margin). Credit usage now sums bill_credits.
    -- NULL = old row not backfilled yet (or a grant/purchase, which isn't usage).
    -- A one-time backfill keeps the past: historical credit = round(cost_usd/0.001),
    -- the same the bar already showed (doesn't rewrite reports).
    ALTER TABLE ${S}.usage_events ADD COLUMN IF NOT EXISTS bill_credits int;
    UPDATE ${S}.usage_events
       SET bill_credits = GREATEST(0, round(cost_usd / 0.001))::int
     WHERE bill_credits IS NULL
       AND model NOT IN ('admin-grant','purchase','referral');
    -- SERVIDORES MCP por usuário: cada linha é um conector externo (Slack, Notion,
    -- etc.) exposto via Model Context Protocol. As tools do servidor entram no
    -- tool-loop. headers guarda auth (ex: Authorization: Bearer ...) quando precisa.
    -- agent_id NULL = disponível pra todos os assistentes do usuário.
    CREATE TABLE IF NOT EXISTS ${S}.mcp_servers (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id   uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      label      text NOT NULL,
      url        text NOT NULL,
      headers    jsonb DEFAULT '{}'::jsonb,
      enabled    boolean DEFAULT true,
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS mcp_user_idx ON ${S}.mcp_servers(user_id);
    -- headers carrega credencial (Authorization: Bearer ...). Passa a viver
    -- cifrado em headers_enc; a coluna jsonb fica só pro que é legado (migrado
    -- por migrateConnectorSecrets) e nova gravação nunca escreve segredo nela.
    ALTER TABLE ${S}.mcp_servers ADD COLUMN IF NOT EXISTS headers_enc text;
    -- Tokens OAuth de conectores externos (GitHub, Slack, ...), por (usuário, provider).
    -- Separado do google_tokens, que é específico do Google.
    CREATE TABLE IF NOT EXISTS ${S}.oauth_tokens (
      user_id       uuid REFERENCES ${S}.users(id) ON DELETE CASCADE,
      provider      text NOT NULL,
      access_token  text,
      refresh_token text,
      scope         text DEFAULT '',
      expiry        timestamptz,
      updated_at    timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, provider)
    );
    -- meta jsonb: dados extras do provider (ex: store_id da Nuvemshop, que
    -- precisa acompanhar o token pra montar a base da API por loja).
    ALTER TABLE ${S}.oauth_tokens ADD COLUMN IF NOT EXISTS meta jsonb DEFAULT '{}'::jsonb;
    ALTER TABLE ${S}.oauth_tokens ADD COLUMN IF NOT EXISTS confirmation_version uuid NOT NULL DEFAULT gen_random_uuid();

    -- AI training OPT-OUT periods (28/08). A subscriber can turn off the use
    -- of their data for product improvement, in Settings. Like plan_periods,
    -- it's a ledger, not a flag: as a boolean column on users, switching it
    -- off today would unfreeze the whole protected past, and switching it on
    -- again would protect what was never covered. With periods, each record is
    -- judged by the date it was produced.
    CREATE TABLE IF NOT EXISTS ${S}.training_optout_periods (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at   timestamptz,                    -- null = opt-out vigente
      source     text NOT NULL DEFAULT 'user',   -- user | admin
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS training_optout_user_idx
      ON ${S}.training_optout_periods(user_id, started_at);
    -- No máximo um período de opt-out aberto por pessoa (ligar duas vezes é no-op).
    CREATE UNIQUE INDEX IF NOT EXISTS training_optout_open_uidx
      ON ${S}.training_optout_periods(user_id) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS ${S}.home_items (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id   uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      kind       text NOT NULL,
      text       text NOT NULL,
      created_at timestamptz DEFAULT now()
    );

    -- Biblioteca de mídia por usuário. Cada arquivo vive no bucket S3 sob a
    -- pasta do dono (s3_key = "<user_id>/<uuid>.<ext>"); aqui guardamos os
    -- metadados pra o agente listar/recuperar (e a legenda que ele mesmo anota).
    -- O acesso é sempre escopado por user_id, então um agente de um usuário
    -- nunca enxerga a mídia de outro.
    CREATE TABLE IF NOT EXISTS ${S}.media_assets (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id   uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      s3_key     text NOT NULL,
      kind       text,
      mime       text,
      source     text,
      caption    text DEFAULT '',
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS media_assets_user_idx
      ON ${S}.media_assets(user_id, created_at DESC);

    -- Lápide (tombstone) de exclusão de arquivo no bucket.
    -- Apagar um arquivo são DOIS passos: tirar a linha do banco e tirar o objeto
    -- do S3. Só o primeiro é transacional; o segundo é rede e pode falhar. Antes,
    -- a linha saía primeiro e a falha do S3 era engolida: o objeto (foto, documento,
    -- rosto) ficava no bucket PARA SEMPRE, sem nenhum registro pra tentar de novo.
    -- Agora a key é copiada pra cá NA MESMA TRANSAÇÃO que remove a referência, e
    -- só sai daqui quando o bucket confirmar o delete. É a única memória do objeto
    -- entre os dois passos, então NÃO tem FK pra users: a lápide precisa sobreviver
    -- à destruição da conta (senão o CASCADE apagaria justamente o que garante que
    -- o arquivo da pessoa excluída suma de verdade).
    CREATE TABLE IF NOT EXISTS ${S}.media_deletions (
      id         bigserial PRIMARY KEY,
      user_id    uuid,
      s3_key     text NOT NULL,
      origem     text,
      status     text NOT NULL DEFAULT 'pending', -- pending | done | failed
      attempts   int NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS media_deletions_pending_idx
      ON ${S}.media_deletions(status, updated_at);

    -- Identidade verificada do usuário (feature de geração de vídeo das pessoas).
    -- UMA identidade por usuário (PK = user_id). anchor_key = foto-âncora de frente
    -- ("foto verdade") verificada MANUALMENTE por um humano no beta. As fotos extras
    -- (ângulos/expressões) ficam em media_assets e são casadas contra a âncora.
    -- Documento + termo entram numa fase futura (colunas já reservadas, nullable).
    -- status: pending (mandou, aguarda revisão) | verified | rejected.
    CREATE TABLE IF NOT EXISTS ${S}.user_likeness (
      user_id         uuid PRIMARY KEY REFERENCES ${S}.users(id) ON DELETE CASCADE,
      status          text NOT NULL DEFAULT 'pending',
      anchor_key      text,
      anchor_mime     text,
      verified_by     text,
      verified_at     timestamptz,
      rejected_reason text,
      document_key    text,
      term_signed_at  timestamptz,
      created_at      timestamptz DEFAULT now(),
      updated_at      timestamptz DEFAULT now()
    );
    -- Voz de referência (opcional) da pessoa, gravada no app. Vira o audio_url do
    -- render quando o pedido de vídeo não traz áudio próprio. Guardada no bucket
    -- privado como as outras mídias (voice_key = key no S3).
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS voice_key text;
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS voice_mime text;
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS voice_updated_at timestamptz;
    -- Áudio LITERAL pra falar (opcional): quando presente, o vídeo faz lip-sync
    -- EXATO desse áudio (as próprias palavras/entonação da pessoa) via modo V1 do
    -- worker (audio_url sem voice_clone_only; a duração sai do áudio). Distinto da
    -- voice_key, que é só referência de TIMBRE pro modo clone com texto digitado.
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS speech_key text;
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS speech_mime text;
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS speech_updated_at timestamptz;
    -- Fotos de rosto EXTRA (opcionais): mesma pessoa da âncora, em ângulos
    -- diferentes. Melhoram a reconstrução do rosto no render (o worker H3 aceita
    -- múltiplas referências de face). anchor_key = foto 1 (principal, verificada);
    -- face2_key/face3_key = ângulos extras. Limite de 3 faces no total (VRAM da GPU).
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS face2_key text;
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS face2_mime text;
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS face2_updated_at timestamptz;
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS face3_key text;
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS face3_mime text;
    ALTER TABLE ${S}.user_likeness ADD COLUMN IF NOT EXISTS face3_updated_at timestamptz;

    -- People video jobs (async, external GPU worker), one per (user + assistant).
    -- remote_job_id = id in the worker wrapper. status mirrors the worker:
    -- queued|processing|done|error, + 'delivered' (ours, sent to the owner) and
    -- 'canceled'. video_seconds = REAL generated duration (billing source).
    -- credits_charged = credits already debited (billing idempotency on
    -- delivery). The scheduler poller advances queued/processing.
    CREATE TABLE IF NOT EXISTS ${S}.video_jobs (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id       uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      remote_job_id  text,
      status         text NOT NULL DEFAULT 'queued',
      prompt         text DEFAULT '',
      with_audio     boolean DEFAULT false,
      duration_req   integer,
      video_seconds  numeric(6,2),
      video_key      text,
      credits_charged integer DEFAULT 0,
      origin_channel text,
      thread_id      text,
      error          text,
      created_at     timestamptz DEFAULT now(),
      updated_at     timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS video_jobs_active_idx
      ON ${S}.video_jobs(status) WHERE status IN ('queued','processing');
    CREATE INDEX IF NOT EXISTS video_jobs_user_idx
      ON ${S}.video_jobs(user_id, created_at DESC);

    -- Tokens de redefinição de senha ("esqueci minha senha"). Token opaco
    -- (crypto), uso único (used_at), expira em ~1h. Limpamos os antigos no uso.
    CREATE TABLE IF NOT EXISTS ${S}.password_resets (
      token      text PRIMARY KEY,
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      used_at    timestamptz,
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS password_resets_user_idx
      ON ${S}.password_resets(user_id);

    -- Dedup do canal e-mail: Message-ID já processado (não responder 2x se o
    -- IMAP reentregar). Guarda user_id quando conhecido (auditoria).
    CREATE TABLE IF NOT EXISTS ${S}.email_seen (
      message_id text PRIMARY KEY,
      user_id    uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
      seen_at    timestamptz DEFAULT now()
    );
    -- Fila persistente do canal e-mail: o e-mail cru baixado do IMAP vive aqui
    -- até a resposta ser ENVIADA (ou o caso ser descartado de propósito).
    -- Sem isto, crash ou falha de SMTP depois do \Seen perdia a mensagem em
    -- silêncio (o IMAP não reentrega o que já está \Seen). attempts limita
    -- mensagem-veneno (a que derruba o processo não vira loop de crash).
    CREATE TABLE IF NOT EXISTS ${S}.email_queue (
      id         bigserial PRIMARY KEY,
      source     bytea NOT NULL,
      status     text NOT NULL DEFAULT 'pending', -- pending | working | done | skipped | failed
      attempts   int NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS email_queue_status_idx ON ${S}.email_queue(status, created_at);
    CREATE TABLE IF NOT EXISTS ${S}.connections (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      provider    text NOT NULL,
      kind        text NOT NULL DEFAULT 'apikey',
      label       text NOT NULL DEFAULT '',
      secret_enc  text NOT NULL,
      meta        jsonb DEFAULT '{}',
      created_at  timestamptz DEFAULT now(),
      updated_at  timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS connections_user_idx ON ${S}.connections(user_id, created_at DESC);

    -- ── Agente ↔ Agente: contatos (handshake entre dois DONOS) ──
    -- A conexão é entre duas PESSOAS, não entre dois assistentes. Cada lado
    -- designa UM assistente de "entrada" (inbound) que recebe pedidos externos
    -- (igual ao agente ativo do WhatsApp). Nome do assistente é só rótulo; a
    -- chave é sempre (user_id, agent_id). Nome diferente de 'connections'
    -- (aquela é o cofre de credenciais) de propósito.
    CREATE TABLE IF NOT EXISTS ${S}.agent_connections (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_a         uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      user_b         uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      status         text NOT NULL DEFAULT 'pending', -- pending | accepted | declined
      inbound_agent_a uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      inbound_agent_b uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      created_at     timestamptz DEFAULT now(),
      updated_at     timestamptz DEFAULT now(),
      UNIQUE (user_a, user_b)
    );
    CREATE INDEX IF NOT EXISTS agent_conn_a_idx ON ${S}.agent_connections(user_a);
    CREATE INDEX IF NOT EXISTS agent_conn_b_idx ON ${S}.agent_connections(user_b);

    -- Conversa/negociação delimitada entre o assistente de A e o de B.
    -- Nasce quando o dono de A pede, morre quando resolve/recusa/expira.
    CREATE TABLE IF NOT EXISTS ${S}.agent_convos (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user   uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      from_agent  uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      to_user     uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      to_agent    uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      objetivo    text NOT NULL,
      status      text NOT NULL DEFAULT 'open', -- open | resolved | declined | expired
      rounds      int  NOT NULL DEFAULT 0,
      resultado   text,
      origin_channel text, -- canal de onde o dono A pediu (telegram|whatsapp|email|web)
      created_at  timestamptz DEFAULT now(),
      updated_at  timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS agent_convos_from_idx ON ${S}.agent_convos(from_user, created_at DESC);
    CREATE INDEX IF NOT EXISTS agent_convos_to_idx ON ${S}.agent_convos(to_user, created_at DESC);
    ALTER TABLE ${S}.agent_convos ADD COLUMN IF NOT EXISTS origin_channel text;

    -- Mensagens estruturadas da negociação (envelope de intenção).
    CREATE TABLE IF NOT EXISTS ${S}.agent_convo_msgs (
      id           bigserial PRIMARY KEY,
      convo_id     uuid NOT NULL REFERENCES ${S}.agent_convos(id) ON DELETE CASCADE,
      sender_agent uuid,
      side         text NOT NULL, -- 'a' (solicitante) | 'b' (respondente)
      intent       text NOT NULL, -- ask | answer | propose | accept | decline | close
      payload      text NOT NULL DEFAULT '',
      ts           timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS agent_convo_msgs_idx ON ${S}.agent_convo_msgs(convo_id, ts);

    -- Mini-PaaS: ownership/state record of the small apps published on the
    -- apps host (e.g. ana.example.com/app_name). The container runs on the
    -- apps host; this holds ownership/billing/state. The host's router has
    -- its own apps.json (routing); this table is the source of ownership.
    -- 'label' = the owner's subdomain (users.subdomain), duplicated for ease.
    CREATE TABLE IF NOT EXISTS ${S}.apps (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id   uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      label      text NOT NULL,
      system     text NOT NULL,
      runtime    text NOT NULL,
      status     text NOT NULL DEFAULT 'running',
      mem        text,
      cpus       text,
      url        text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (label, system)
    );
    CREATE INDEX IF NOT EXISTS apps_user_idx ON ${S}.apps(user_id, created_at DESC);
    -- Snapshot do CÓDIGO (só o fonte enviado no publish, comprimido). É a fonte
    -- pra replicar um app público noutro usuário. NUNCA guarda dado de runtime
    -- (o app grava dado em /app/data, que não é enviado nem entra aqui), então o
    -- dado não viaja quando o app é replicado. Fase 2 do isolamento por construção.
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS source_snapshot text;
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS snapshot_at timestamptz;
    -- Fase 3: visibilidade. 'private' (padrão, só o dono) ou 'public' (qualquer
    -- agente acha via buscar_apps_publicos e replica no próprio subdomínio). A
    -- descrição ajuda a descoberta. Só o CÓDIGO (snapshot) viaja na replicação.
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS description text;
    CREATE INDEX IF NOT EXISTS apps_public_idx ON ${S}.apps(visibility) WHERE visibility = 'public';
    -- Durable app MODE stamp, set at creation:
    -- 'basico' = app on the built-in mini-PaaS, edited 100% inside the platform
    -- (ler_arquivo_do_app → escrever_arquivo_do_app → publicar_sistema); NEVER
    -- via sandbox/SSH. 'avancado' = dev with own repo/server (Project mode).
    -- Makes agent routing deterministic instead of guessing per turn.
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'basico';
    -- NETWORK ACCESS to the app's public URL. NOT to be confused with
    -- visibility, which is only library/replication: an app can be out of the
    -- library (private) and still have its URL open to anyone online; that was
    -- exactly the hole. Here: 'private' = the apps host router asks for user
    -- and password (HTTP Basic) BEFORE waking the container; 'public' = open.
    -- A new app STARTS 'private' (decided 31/08/2026).
    -- NULLABLE on purpose: an OLD row stays NULL = legacy behavior (open).
    -- Locking an app already in use retroactively would break links the owner
    -- shared, so migrating an existing app is the owner's choice.
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS access text;
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS access_user text;
    -- Senha cifrada (AES-256-GCM via vault.mjs), igual aos segredos. Fica FORA
    -- de app_secrets de propósito: segredo do cofre é injetado como env DENTRO
    -- do container do app, e a senha do portão não é assunto do app.
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS access_pass_enc text;
    -- Painel de moderação de apps (/metrics → aba Apps, 07/09/2026). Rótulo de
    -- LEITURA: diz o que o app é e se merece olhada humana. NADA aqui bloqueia,
    -- tranca ou derruba app; quem modera é o humano no painel. risk_snapshot_at
    -- guarda de qual versão do código veio o rótulo, pra saber quando envelheceu.
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS risk_label text;
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS risk_summary text;
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS risk_reason text;
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS risk_signals jsonb;
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS risk_at timestamptz;
    ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS risk_snapshot_at timestamptz;
    ALTER TABLE ${S}.users ADD COLUMN IF NOT EXISTS subdomain text UNIQUE;
    -- Cofre de segredos POR APP (isolamento por construção). O código do app só
    -- referencia process.env.X; o valor real fica AQUI cifrado (AES-256-GCM via
    -- vault.mjs) e é injetado como env no boot do container. NUNCA vai pro fonte,
    -- então não vaza quando um app público é replicado por outro usuário.
    CREATE TABLE IF NOT EXISTS ${S}.app_secrets (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      system     text NOT NULL,
      key        text NOT NULL,
      value_enc  text NOT NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (user_id, system, key)
    );
    CREATE INDEX IF NOT EXISTS app_secrets_idx ON ${S}.app_secrets(user_id, system);
    -- COLABORAÇÃO Modo B (instância única compartilhada): um dono libera um app
    -- SEU (owner_user_id, system) pra um colaborador CONECTADO mexer na MESMA
    -- instância (mesmo código, mesmo /app/data, mesmo container). Não cria app
    -- novo pro colaborador; ele entra por este roster. GATE: só entra quem tem
    -- agent_connection ACEITA com o dono (checado ao convidar). Billing continua
    -- por dono (cada turno é cobrado no dono do assistente que agiu).
    CREATE TABLE IF NOT EXISTS ${S}.app_collab (
      owner_user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      system        text NOT NULL,
      collab_user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      added_by_agent uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      created_at    timestamptz DEFAULT now(),
      PRIMARY KEY (owner_user_id, system, collab_user_id)
    );
    CREATE INDEX IF NOT EXISTS app_collab_collab_idx ON ${S}.app_collab(collab_user_id);
    -- ESPAÇOS: assunto vivo compartilhado, SEM app/runtime. 'about' = a definição
    -- (skill: do que trata + como o assistente se comporta). Dado vivo em
    -- space_entries; roster em space_members (dono também entra). Ver
    -- projetos/espaco-implementacao.md.
    CREATE TABLE IF NOT EXISTS ${S}.spaces (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      slug          text NOT NULL,
      title         text NOT NULL DEFAULT '',
      about         text NOT NULL DEFAULT '',
      created_at    timestamptz DEFAULT now(),
      updated_at    timestamptz DEFAULT now(),
      UNIQUE (owner_user_id, slug)
    );
    CREATE TABLE IF NOT EXISTS ${S}.space_members (
      space_id       uuid NOT NULL REFERENCES ${S}.spaces(id) ON DELETE CASCADE,
      user_id        uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      added_by_agent uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      created_at     timestamptz DEFAULT now(),
      PRIMARY KEY (space_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS space_members_user_idx ON ${S}.space_members(user_id);
    CREATE TABLE IF NOT EXISTS ${S}.space_entries (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      space_id       uuid NOT NULL REFERENCES ${S}.spaces(id) ON DELETE CASCADE,
      author_user_id uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
      author_agent   uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      body           text NOT NULL DEFAULT '',
      tag            text NOT NULL DEFAULT '',
      created_at     timestamptz DEFAULT now(),
      updated_at     timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS space_entries_space_idx ON ${S}.space_entries(space_id, created_at DESC);
    -- share_mode: 'manual' = só registra quando o dono pedir explicitamente
    -- (DEFAULT de Space novo); 'auto' = o assistente decide o que registrar
    -- (fato/estado compartilhado ou a pedido). Configurável na UI e via tool.
    -- O SET DEFAULT abaixo corrige bancos que já criaram a coluna com 'auto'.
    ALTER TABLE ${S}.spaces ADD COLUMN IF NOT EXISTS share_mode text NOT NULL DEFAULT 'manual';
    ALTER TABLE ${S}.spaces ALTER COLUMN share_mode SET DEFAULT 'manual';
    -- SKILLS: comportamento/conhecimento puro (um "SKILL.md": instruções +
    -- gatilho de "quando usar"), SEM dado vivo (isso é Space) e SEM runtime
    -- (isso é App). O degrau mais leve da escada de primitivas. Autorada pelo
    -- usuário, instalável POR ASSISTENTE (progressive disclosure), e (Fase 2)
    -- compartilhável entre conexões. Ver projetos/skill-implementacao.md.
    CREATE TABLE IF NOT EXISTS ${S}.skills (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      slug          text NOT NULL,
      title         text NOT NULL DEFAULT '',
      trigger       text NOT NULL DEFAULT '',   -- "quando usar" (matcher p/ disclosure)
      body          text NOT NULL DEFAULT '',   -- o SKILL.md: instruções/procedimento
      visibility    text NOT NULL DEFAULT 'private', -- 'private' | 'connections'
      verified      boolean NOT NULL DEFAULT false,
      install_count int NOT NULL DEFAULT 0,
      created_at    timestamptz DEFAULT now(),
      updated_at    timestamptz DEFAULT now(),
      UNIQUE (owner_user_id, slug)
    );
    -- Instala uma skill num ASSISTENTE específico (não por usuário): cada agente
    -- tem seu foco e o prompt é montado por agente, então o disclosure fica limpo.
    CREATE TABLE IF NOT EXISTS ${S}.skill_installs (
      skill_id     uuid NOT NULL REFERENCES ${S}.skills(id) ON DELETE CASCADE,
      user_id      uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id     uuid NOT NULL REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      enabled      boolean NOT NULL DEFAULT true,
      installed_at timestamptz DEFAULT now(),
      PRIMARY KEY (skill_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS skill_installs_agent_idx ON ${S}.skill_installs(agent_id) WHERE enabled;
    -- AVALIAÇÃO de skills da biblioteca: cada usuário dá UMA nota (1-5) por skill.
    -- PK (skill_id, user_id) => reavaliar sobrescreve (upsert), nunca infla o total.
    -- Média e nº de votos saem daqui em SQL (nunca no modelo). Ver Item 3 em
    -- projetos/biblioteca-habilidades.md.
    CREATE TABLE IF NOT EXISTS ${S}.skill_ratings (
      skill_id   uuid NOT NULL REFERENCES ${S}.skills(id) ON DELETE CASCADE,
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      stars      int NOT NULL CHECK (stars BETWEEN 1 AND 5),
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (skill_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS skill_ratings_skill_idx ON ${S}.skill_ratings(skill_id);
    -- USO de skills: cada vez que uma skill é ACIONADA (ler_skill puxa o SKILL.md
    -- quando o gatilho bate, ou rodar_skill executa o script). Agregado por
    -- (skill_id, user_id, day) — upsert incremental, barato em volume, não guarda
    -- a chamada individual. É o par de skill_installs pro /metrics (instalações x usos).
    CREATE TABLE IF NOT EXISTS ${S}.skill_uses (
      skill_id uuid NOT NULL REFERENCES ${S}.skills(id) ON DELETE CASCADE,
      user_id  uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      day      date NOT NULL DEFAULT current_date,
      calls    bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (skill_id, user_id, day)
    );
    CREATE INDEX IF NOT EXISTS skill_uses_skill_idx ON ${S}.skill_uses(skill_id);
    CREATE INDEX IF NOT EXISTS skill_uses_day_idx ON ${S}.skill_uses(day);
    -- Skill EM CURSO numa conversa. Quando ler_skill puxa o SKILL.md, a skill
    -- fica presa àquela thread e o corpo passa a entrar no prompt de todo turno
    -- seguinte, RELIDO do banco. Sem isso o procedimento só existia no turno da
    -- leitura (resultado de tool não é persistido no histórico): num fluxo de
    -- vários passos o 2º turno já ia sem instrução, o modelo improvisava
    -- imitando as próprias mensagens anteriores, e editar a skill no meio do
    -- fluxo não tinha efeito nenhum. Ver projetos/skill-implementacao.md.
    CREATE TABLE IF NOT EXISTS ${S}.skill_active (
      thread_id    uuid NOT NULL REFERENCES ${S}.threads(id) ON DELETE CASCADE,
      skill_id     uuid NOT NULL REFERENCES ${S}.skills(id) ON DELETE CASCADE,
      activated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (thread_id, skill_id)
    );
    CREATE INDEX IF NOT EXISTS skill_active_thread_idx ON ${S}.skill_active(thread_id);
    -- (Fase 3) passo executável: uma Skill pode carregar um script que roda no
    -- sandbox isolado. runtime = 'python' | 'bash' (vazio = skill só-texto).
    ALTER TABLE ${S}.skills ADD COLUMN IF NOT EXISTS script text NOT NULL DEFAULT '';
    ALTER TABLE ${S}.skills ADD COLUMN IF NOT EXISTS runtime text NOT NULL DEFAULT '';
    -- BIBLIOTECA OFICIAL: visibility ganha o valor 'public' (skill oficial/curada,
    -- visível pra TODO usuário na página /habilidades, instalável num toque, sem
    -- precisar de conexão). category agrupa os cards na biblioteca. Só admin/import
    -- cria skill pública; usuário comum só chega a 'private'/'connections'.
    ALTER TABLE ${S}.skills ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
    ALTER TABLE ${S}.skills ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';
    -- INBOUND WEBHOOK: an external system (e.g. a company CMS) triggers a
    -- SKILL of an agent via a token-authenticated POST. One token per agent
    -- (regenerable, can be disabled). The token is the secret; we store the hash
    -- (sha256) and a short prefix only for display in the UI. See projects below.
    CREATE TABLE IF NOT EXISTS ${S}.agent_webhooks (
      agent_id    uuid PRIMARY KEY REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      user_id     uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      token_hash  text NOT NULL,          -- sha256(token) em hex; o token cru nunca é gravado
      token_hint  text NOT NULL DEFAULT '', -- primeiros 8 chars, só pra exibição
      enabled     boolean NOT NULL DEFAULT true,
      call_count  int NOT NULL DEFAULT 0,
      created_at  timestamptz DEFAULT now(),
      last_used_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_webhooks_hash_idx ON ${S}.agent_webhooks(token_hash);
    -- DEVICE TOKENS: the device channel (an OS/desktop client, one more channel like
    -- WhatsApp/Telegram) authenticates by a Bearer tied to the USER. The owner logs in
    -- once on the web, makes a token per device (regenerable, revocable) and the OS
    -- sends it as Authorization: Bearer. We keep only the hash (sha256) and a short
    -- display prefix; the raw token shows once. Several devices per user. The device is
    -- a DUMB CLIENT: only the opaque Bearer, never OAuth tokens or restricted data.
    CREATE TABLE IF NOT EXISTS ${S}.device_tokens (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      token_hash      text NOT NULL,          -- sha256(token) em hex; o token cru nunca é gravado
      token_hint      text NOT NULL DEFAULT '', -- primeiros 8 chars, só pra exibição
      label           text NOT NULL DEFAULT '', -- nome do device dado pelo dono ("Pixel 7")
      active_agent_id uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      enabled         boolean NOT NULL DEFAULT true,
      call_count      int NOT NULL DEFAULT 0,
      created_at      timestamptz DEFAULT now(),
      last_used_at    timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_hash_idx ON ${S}.device_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON ${S}.device_tokens(user_id);
    -- Uma sessão de webhook (thread) roda UMA skill do começo ao fim; guardamos o
    -- slug pra re-injetar o corpo da skill em cada POST de continuação (ping-pong).
    ALTER TABLE ${S}.threads ADD COLUMN IF NOT EXISTS webhook_skill text NOT NULL DEFAULT '';
    -- Apagar conversa = soft delete: o usuário some com ela da interface, mas a
    -- linha (e as mensagens) FICAM no banco. deleted_at NULL = ativa. Uma nova
    -- atividade no canal reativa a thread (limpa o flag em getOrCreateThreadByTitle).
    ALTER TABLE ${S}.threads ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    -- Organização da lista pelo usuário: favoritar (destaca no topo) e arquivar
    -- (tira da lista principal, mas fica acessível na seção Arquivadas). Nenhum
    -- dos dois apaga; são só visão. archived_at NULL = não arquivada.
    ALTER TABLE ${S}.threads ADD COLUMN IF NOT EXISTS favorite boolean NOT NULL DEFAULT false;
    ALTER TABLE ${S}.threads ADD COLUMN IF NOT EXISTS archived_at timestamptz;
    -- Marca de leitura da conversa: alimenta a bolinha de "não lida" na lista.
    -- Mensagem proativa (rotina, recado de outro canal, resposta que chegou com a
    -- aba fechada) entrava na conversa sem nenhum sinal na lista. DEFAULT now()
    -- faz as conversas que JÁ existem nascerem lidas — ninguém quer abrir o app e
    -- encontrar o histórico inteiro marcado como novidade; daí em diante só conta
    -- o que chega depois da última vez que a pessoa abriu a conversa.
    ALTER TABLE ${S}.threads ADD COLUMN IF NOT EXISTS last_read_at timestamptz NOT NULL DEFAULT now();
    -- FOCO DE APP DA CONVERSA (route-guard sticky): quando um turno mira
    -- claramente UM app básico do dono, a conversa fica "dentro" desse app pelos
    -- turnos seguintes. Sem isso o guard só valia no turno em que a pessoa
    -- nomeava o app, e o turno seguinte ("não funcionou, tenta de novo") voltava
    -- a expor sandbox/coding-SSH — que foi exatamente o que vazou nos casos
    -- de 08/2026. app_focus = slug do app ('' = sem foco); app_focus_at = último
    -- turno em que o foco valeu (o foco expira por silêncio, ver server.mjs).
    ALTER TABLE ${S}.threads ADD COLUMN IF NOT EXISTS app_focus text NOT NULL DEFAULT '';
    ALTER TABLE ${S}.threads ADD COLUMN IF NOT EXISTS app_focus_at timestamptz;
    -- TRACKERS: registro estruturado de eventos datados/contáveis (dias com
    -- açúcar, treinos, peso, gasto). Substitui o "sisteminha" que hoje vive numa
    -- página de memória em texto livre (não-determinístico: confirma sem gravar,
    -- rewrite dropa linhas, contagem feita no modelo, data errada). Aqui:
    -- append-only + contagem em SQL. event_date (a que o evento se refere)
    -- separado de created_at (quando registrou). Escopo por usuário (como
    -- wiki_pages); agent_id = só proveniência. Ver projetos/tracker-primitiva.md.
    CREATE TABLE IF NOT EXISTS ${S}.trackers (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id      uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      slug          text NOT NULL,
      title         text NOT NULL DEFAULT '',
      kind          text NOT NULL DEFAULT 'count',  -- 'count' | 'quantity' | 'bool'
      unit          text NOT NULL DEFAULT '',
      config        jsonb NOT NULL DEFAULT '{}'::jsonb,
      enabled       boolean NOT NULL DEFAULT true,
      created_at    timestamptz DEFAULT now(),
      updated_at    timestamptz DEFAULT now(),
      UNIQUE (owner_user_id, slug)
    );
    CREATE TABLE IF NOT EXISTS ${S}.tracker_events (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tracker_id  uuid NOT NULL REFERENCES ${S}.trackers(id) ON DELETE CASCADE,
      user_id     uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
      agent_id    uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      event_date  date NOT NULL,
      value       numeric NOT NULL DEFAULT 1,
      note        text NOT NULL DEFAULT '',
      source      text NOT NULL DEFAULT 'chat',  -- 'chat' | 'routine' | 'import'
      created_at  timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tracker_events_tracker_idx ON ${S}.tracker_events(tracker_id, event_date DESC);
    -- da migração pra tabela de fatos (e de qualquer escrita automática): o que
    -- sai de uma página continua recuperável aqui. Trigger no banco, então vale
    -- pra qualquer caminho de escrita (tool, housekeeping, UI, script). A página
    -- "atualizacoes" fica de fora: é log gerado e muda a cada escrita.
    CREATE TABLE IF NOT EXISTS ${S}.wiki_page_versions (
      id        bigserial PRIMARY KEY,
      user_id   uuid NOT NULL,
      slug      text NOT NULL,
      title     text NOT NULL DEFAULT '',
      body      text NOT NULL DEFAULT '',
      saved_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wiki_page_versions_idx ON ${S}.wiki_page_versions(user_id, slug, saved_at DESC);
    CREATE OR REPLACE FUNCTION ${S}.wiki_page_versionar() RETURNS trigger AS $fn$
    BEGIN
      -- Conta sendo excluída (o DELETE do users cascateia nas páginas): não copia,
      -- senão a exclusão da conta deixaria a memória inteira guardada nas cópias.
      IF OLD.slug <> 'atualizacoes' AND (TG_OP = 'DELETE' OR OLD.body IS DISTINCT FROM NEW.body)
         AND EXISTS (SELECT 1 FROM ${S}.users WHERE id = OLD.user_id) THEN
        INSERT INTO ${S}.wiki_page_versions (user_id, slug, title, body) VALUES (OLD.user_id, OLD.slug, OLD.title, OLD.body);
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS wiki_pages_versionar ON ${S}.wiki_pages;
    CREATE TRIGGER wiki_pages_versionar BEFORE UPDATE OR DELETE ON ${S}.wiki_pages
      FOR EACH ROW EXECUTE FUNCTION ${S}.wiki_page_versionar();
    -- Cópia pertence à conta: some junto quando a conta é destruída (Política de
    -- Privacidade). Órfãs de antes do vínculo saem antes de criar a FK.
    DELETE FROM ${S}.wiki_page_versions v WHERE NOT EXISTS (SELECT 1 FROM ${S}.users u WHERE u.id = v.user_id);
    DO $fk$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_page_versions_user_fk') THEN
        ALTER TABLE ${S}.wiki_page_versions ADD CONSTRAINT wiki_page_versions_user_fk
          FOREIGN KEY (user_id) REFERENCES ${S}.users(id) ON DELETE CASCADE;
      END IF;
    END $fk$;
    -- MEMÓRIA v2, Fase 1: FATOS com chave e vigência (fonte da verdade; a página
    -- é renderizada a partir daqui). Um assunto tem no máximo UM fato vigente
    -- (valido_ate NULL): fato novo sobre o mesmo assunto ENCERRA o antigo em vez
    -- de conviver com ele, que é a causa das contradições medidas em 23/09.
    -- linha_pagina = a linha exata que o fato ocupa na página, pra trocar sem
    -- depender do modelo achar a âncora. Ver projetos/memoria-proposta-v2.md.
    CREATE TABLE IF NOT EXISTS ${S}.memory_facts (
      id              bigserial PRIMARY KEY,
      user_id         uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      pagina          text NOT NULL,
      assunto         text NOT NULL,
      valor           text NOT NULL,
      valido_desde    date,
      valido_ate      timestamptz,
      substituido_por bigint,
      fonte           jsonb NOT NULL DEFAULT '{}'::jsonb,
      linha_pagina    text NOT NULL DEFAULT '',
      criado_em       timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_facts_vigente_uq ON ${S}.memory_facts(user_id, assunto) WHERE valido_ate IS NULL;
    CREATE INDEX IF NOT EXISTS memory_facts_user_idx ON ${S}.memory_facts(user_id, criado_em DESC);
    -- DÚVIDAS DA MEMÓRIA: o mesmo assunto com versões que se contradizem (achadas
    -- na migração ou depois). Não se decide sozinho: o dono responde ao próprio
    -- assistente ou o admin escolhe no /metrics. opcoes = [{id,pagina,txt}], a linha
    -- literal de cada versão. Só uma dúvida ABERTA por assunto.
    CREATE TABLE IF NOT EXISTS ${S}.memory_ambiguities (
      id            bigserial PRIMARY KEY,
      user_id       uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      assunto       text NOT NULL,
      motivo        text NOT NULL DEFAULT '',
      opcoes        jsonb NOT NULL DEFAULT '[]'::jsonb,
      status        text NOT NULL DEFAULT 'aberta',
      resolucao     text,
      resolvido_por text,
      fonte         jsonb NOT NULL DEFAULT '{}'::jsonb,
      criado_em     timestamptz NOT NULL DEFAULT now(),
      resolvido_em  timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_ambiguities_aberta_uq ON ${S}.memory_ambiguities(user_id, assunto) WHERE status = 'aberta';
    -- O que a resolução mudou (linhas reescritas, fato novo/velho), pra poder desfazer.
    ALTER TABLE ${S}.memory_ambiguities ADD COLUMN IF NOT EXISTS desfazer jsonb;
    -- MONITORES: engine determinística de monitoramento de compras (Fase 2 da
    -- skill Monitor de Compras). O par estruturado da rotina: em vez de confiar
    -- na memória do modelo pra saber "o que já avisei", o dedup vira uma UNIQUE
    -- constraint em SQL. A cada rodada a rotina raspa as fontes e chama
    -- checar_monitor com os itens; só os que ENTRAM (ON CONFLICT DO NOTHING)
    -- contam como novidade. baseline_done: a 1ª rodada só registra o estado
    -- atual (não dispara alarme). Ver projetos/skill-monitor-compras.md.
    CREATE TABLE IF NOT EXISTS ${S}.monitors (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id      uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      slug          text NOT NULL,
      title         text NOT NULL DEFAULT '',
      target        text NOT NULL DEFAULT '',       -- o quê + mercado (ex: "Zara Japão")
      sources       jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{url,label}] validadas
      channel       text NOT NULL DEFAULT '',
      baseline_done boolean NOT NULL DEFAULT false,
      config        jsonb NOT NULL DEFAULT '{}'::jsonb,
      enabled       boolean NOT NULL DEFAULT true,
      created_at    timestamptz DEFAULT now(),
      updated_at    timestamptz DEFAULT now(),
      UNIQUE (owner_user_id, slug)
    );
    -- Itens já vistos por monitor. item_key = chave de dedup ESTÁVEL entre
    -- rodadas (a URL do artigo, de preferência). append-only; a UNIQUE é o dedup.
    CREATE TABLE IF NOT EXISTS ${S}.monitor_items (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      monitor_id  uuid NOT NULL REFERENCES ${S}.monitors(id) ON DELETE CASCADE,
      item_key    text NOT NULL,
      item_date   text NOT NULL DEFAULT '',
      title       text NOT NULL DEFAULT '',
      url         text NOT NULL DEFAULT '',
      seen_at     timestamptz DEFAULT now(),
      UNIQUE (monitor_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS monitor_items_monitor_idx ON ${S}.monitor_items(monitor_id, seen_at DESC);
    -- Idempotência dos webhooks da Asaas: a entrega é "at least once", o MESMO
    -- evento volta. O id do evento é a PK; se o INSERT conflita, já processamos.
    CREATE TABLE IF NOT EXISTS ${S}.asaas_events (
      event_id   text PRIMARY KEY,
      account_id text NOT NULL DEFAULT '',
      event      text NOT NULL DEFAULT '',
      payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now()
    );
    -- Operações de saída criadas pelo assistente. Liga o id real da Asaas ao
    -- dono, assistente e conversa que originaram a ação, para o comprovante que
    -- chega depois por webhook não virar uma notificação sem contexto.
    CREATE TABLE IF NOT EXISTS ${S}.asaas_operations (
      provider_operation_id      text PRIMARY KEY,
      owner_user_id              uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id                   uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      thread_id                  uuid REFERENCES ${S}.threads(id) ON DELETE SET NULL,
      account_id                 text NOT NULL DEFAULT '',
      kind                       text NOT NULL CHECK (kind IN ('pix','boleto')),
      status                     text NOT NULL DEFAULT '',
      value                      numeric,
      origin_channel             text CHECK (origin_channel IS NULL OR origin_channel IN ('web','telegram','whatsapp','email')),
      execution_mode             text CHECK (execution_mode IS NULL OR execution_mode IN ('immediate','scheduled')),
      requested_schedule_date    date,
      provider_schedule_date     date,
      due_date                    date,
      receipt_url                text,
      receipt_notification_state text NOT NULL DEFAULT 'pending'
                                   CHECK (receipt_notification_state IN ('pending','dispatching','delivered','failed')),
      receipt_notification_attempts integer NOT NULL DEFAULT 0,
      created_at                 timestamptz DEFAULT now(),
      updated_at                 timestamptz DEFAULT now()
    );
    ALTER TABLE ${S}.asaas_operations ADD COLUMN IF NOT EXISTS origin_channel text;
    ALTER TABLE ${S}.asaas_operations ADD COLUMN IF NOT EXISTS execution_mode text;
    ALTER TABLE ${S}.asaas_operations ADD COLUMN IF NOT EXISTS requested_schedule_date date;
    ALTER TABLE ${S}.asaas_operations ADD COLUMN IF NOT EXISTS provider_schedule_date date;
    ALTER TABLE ${S}.asaas_operations ADD COLUMN IF NOT EXISTS due_date date;
    CREATE INDEX IF NOT EXISTS asaas_operations_owner_idx ON ${S}.asaas_operations(owner_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS asaas_operations_account_idx ON ${S}.asaas_operations(account_id, provider_operation_id);
    -- Boleto schedules live in the platform, not at Asaas. That way the user
    -- can cancel from the conversation without creating a "critical event" of
    -- deletion at the provider. The barcode/typeable line is encrypted; the
    -- table only exposes the metadata needed for claim, audit and UX.
    CREATE TABLE IF NOT EXISTS ${S}.asaas_bill_schedules (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id      uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id           uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      thread_id          uuid REFERENCES ${S}.threads(id) ON DELETE SET NULL,
      account_id         text NOT NULL DEFAULT '',
      origin_channel     text NOT NULL DEFAULT 'web'
                           CHECK (origin_channel IN ('web','telegram','whatsapp','email')),
      execute_on         date NOT NULL,
      status             text NOT NULL DEFAULT 'scheduled'
                           CHECK (status IN ('scheduled','executing','submitted','completed','failed','cancelled','needs_review','uncertain','awaiting_authorization')),
      payload_enc        text NOT NULL,
      expected_hash      text NOT NULL,
      external_reference text NOT NULL UNIQUE,
      provider_operation_id text,
      lease_until        timestamptz,
      outcome            jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      cancelled_at       timestamptz,
      finished_at        timestamptz
    );
    CREATE INDEX IF NOT EXISTS asaas_bill_schedules_due_idx
      ON ${S}.asaas_bill_schedules(status, execute_on, updated_at);
    CREATE INDEX IF NOT EXISTS asaas_bill_schedules_owner_idx
      ON ${S}.asaas_bill_schedules(owner_user_id, created_at DESC);

    -- Intenção financeira confirmada na conversa. O webhook especial de
    -- autorização de saques só aprova quando id, tipo e conteúdo canônico
    -- conferem com esta linha; payload apenas estrutural nunca é suficiente.
    CREATE TABLE IF NOT EXISTS ${S}.asaas_financial_intents (
      provider_operation_id text PRIMARY KEY,
      owner_user_id          uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      account_id             text NOT NULL DEFAULT '',
      kind                   text NOT NULL CHECK (kind IN ('BILL','TRANSFER')),
      external_reference     text,
      expected_hash          text NOT NULL,
      state                  text NOT NULL DEFAULT 'submitted'
                               CHECK (state IN ('submitted','approved','refused','terminal')),
      last_payload_hash      text,
      decision_reason        text,
      authorization_attempts integer NOT NULL DEFAULT 0,
      expires_at             timestamptz NOT NULL DEFAULT now() + interval '2 days',
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS asaas_financial_intents_external_idx
      ON ${S}.asaas_financial_intents(external_reference)
      WHERE external_reference IS NOT NULL AND external_reference<>'';
    CREATE INDEX IF NOT EXISTS asaas_financial_intents_expiry_idx
      ON ${S}.asaas_financial_intents(state, expires_at);
    -- RASCUNHO de arquivos de um app (staging pré-publish). O agente monta o app
    -- arquivo a arquivo (escrever_arquivo_do_app) e só depois publica, sem ter que
    -- mandar TODO o código numa tool-call gigante (que o modelo erra em app com
    -- vários arquivos). Guarda só o FONTE (base64); dado de runtime nunca passa
    -- por aqui. Publicar aplica o rascunho e o limpa. Chave (user_id, system, caminho).
    CREATE TABLE IF NOT EXISTS ${S}.app_drafts (
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      system     text NOT NULL,
      caminho    text NOT NULL,
      conteudo   text NOT NULL,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, system, caminho)
    );
    CREATE INDEX IF NOT EXISTS app_drafts_idx ON ${S}.app_drafts(user_id, system);

    -- Freios de fundamentação (web/grounding-guard.mjs): 1 linha por dado que o
    -- assistente afirmou sem ter consultado nada neste turno (cupom, link, fonte
    -- assinada, preço "pesquisado", saldo do dono, conteúdo de anexo). Registrar
    -- é o que transforma "acho que o modelo inventa" em número: quantas vezes,
    -- de que tipo, em qual conversa e se o repasse resolveu. 'desfecho' guarda
    -- como terminou: 'corrigido' = na segunda passada o modelo chamou a
    -- ferramenta e o dado passou a ter lastro; 'removido' = nem na segunda vez,
    -- então a linha sem base saiu do texto e o usuário foi avisado.
    CREATE TABLE IF NOT EXISTS ${S}.grounding_brakes (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now(),
      user_id    uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
      agent_id   uuid,
      thread_id  uuid,
      kind       text NOT NULL,
      dado       text,
      trecho     text,
      origem     text NOT NULL DEFAULT 'chat',
      desfecho   text NOT NULL DEFAULT 'corrigido',
      ferramentas text
    );
    CREATE INDEX IF NOT EXISTS grounding_brakes_ts_idx ON ${S}.grounding_brakes(created_at DESC);

    -- LIVRO DE OFERTAS DE ROTINA: 1 linha toda vez que alguém ofereceu um
    -- agendamento pra uma pessoa, não importa por qual caminho — o assistente
    -- dela na conversa (via 'chat', tool oferecer_rotina) ou o time pelo
    -- /broadcast (via 'painel'). Existe porque os dois caminhos eram CEGOS um
    -- pro outro: o painel só enxergava o que ele mesmo mandou (lifecycle_sends),
    -- então forçava uma oferta que o assistente já tinha feito no mesmo dia.
    -- O registro é efeito colateral do MECANISMO (a tool), nunca disciplina do
    -- modelo: quem não passa pela tool não oferece.
    -- O estado deriva de DADO, não de interpretação: 'aberta' vira 'aceita'
    -- quando criar_rotina roda de verdade, e recusa é inferida por TEMPO (oferta
    -- aberta que não virou agendamento é recusa passiva), nunca por o modelo
    -- achar que o dono disse não. Ver projetos/oferta-de-rotina.md.
    CREATE TABLE IF NOT EXISTS ${S}.routine_offers (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      agent_id   uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
      padrao     text NOT NULL DEFAULT '',       -- id do CATALOGO (digest_agenda, ...)
      titulo     text NOT NULL DEFAULT '',       -- o que foi oferecido, em uma linha
      via        text NOT NULL DEFAULT 'chat',   -- 'chat' (assistente) | 'painel' (time)
      status     text NOT NULL DEFAULT 'aberta', -- aberta | aceita
      routine_id uuid,                           -- preenchido quando virou rotina
      offered_at timestamptz NOT NULL DEFAULT now(),
      closed_at  timestamptz
    );
    CREATE INDEX IF NOT EXISTS routine_offers_user_idx ON ${S}.routine_offers(user_id, offered_at DESC);
    -- Opt-out DURO: a pessoa disse que não quer que sugiram agendamento. Vale
    -- pros dois caminhos (o prompt não sugere, o painel bloqueia o envio) e é
    -- ligável/desligável na mão pela tela. padrao '*' = tudo; um id do catálogo
    -- = só aquele tipo. Fica em tabela e não numa flag em users porque o escopo
    -- por padrão precisa de mais de uma linha por pessoa.
    CREATE TABLE IF NOT EXISTS ${S}.routine_offer_optouts (
      user_id    uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      padrao     text NOT NULL DEFAULT '*',
      motivo     text NOT NULL DEFAULT '',
      origem     text NOT NULL DEFAULT 'chat',   -- 'chat' | 'painel'
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, padrao)
    );

    -- Rastreio de ENTREGA no WhatsApp. A Cloud API ACEITA um template (retorna
    -- wamid + message_status:accepted) mesmo quando a mensagem NÃO é entregue
    -- (ex.: teto de marketing da Meta -> status webhook 'failed' code 131049).
    -- O webhook manda o resultado real em value.statuses (sent/delivered/read/
    -- failed) DEPOIS. Guardamos aqui, chaveado pelo wamid, pra saber de verdade
    -- o que chegou e pra quem reenviar. rank evita "rebaixar" um status já mais
    -- avançado quando um webhook chega fora de ordem.
    CREATE TABLE IF NOT EXISTS ${S}.wa_message_status (
      wamid         text PRIMARY KEY,
      recipient     text NOT NULL DEFAULT '',
      status        text NOT NULL DEFAULT '',      -- sent | delivered | read | failed
      rank          smallint NOT NULL DEFAULT 0,   -- sent=1 delivered=2 read=3 failed=9
      error_code    int,
      error_title   text,
      error_message text,
      status_at     timestamptz,                   -- timestamp que a Meta carimbou
      updated_at    timestamptz NOT NULL DEFAULT now(),
      raw           jsonb
    );
    CREATE INDEX IF NOT EXISTS wa_status_recipient_idx ON ${S}.wa_message_status(recipient, updated_at DESC);
    CREATE INDEX IF NOT EXISTS wa_status_status_idx ON ${S}.wa_message_status(status);

    CREATE TABLE IF NOT EXISTS ${S}.app_config (
      key        text PRIMARY KEY,
      value      jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- PROJETO (dev mode / tier avançado): repo real do PRÓPRIO GitHub do usuário,
    -- clonado num workspace de dev persistente na nossa infra, onde o agente coda
    -- e commita/pusha. Diferente do app-consumer (${S}.apps): aqui é código de
    -- verdade num repo do usuário, com deploy pra infra DELE (own_ssh) ou pro
    -- nosso host dedicado (dedicated). Ver projetos/dev-mode-avancado.md.
    CREATE TABLE IF NOT EXISTS ${S}.projects (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id      uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      nome               text NOT NULL,
      repo_url           text,
      provider           text NOT NULL DEFAULT 'github',
      workspace_ref      text,                                   -- "<userslug>/<projslug>" no host de dev
      deploy_target_type text NOT NULL DEFAULT 'own_ssh',        -- 'own_ssh' | 'dedicated'
      deploy_config      jsonb NOT NULL DEFAULT '{}'::jsonb,     -- {host,usuario,caminho,branch,restart_cmd} ou {subdominio,...}
      perm_mode          text NOT NULL DEFAULT 'padrao',
      status             text NOT NULL DEFAULT 'active',         -- 'active' | 'archived'
      created_at         timestamptz DEFAULT now(),
      updated_at         timestamptz DEFAULT now(),
      UNIQUE (owner_user_id, nome)
    );
    CREATE INDEX IF NOT EXISTS projects_owner_idx ON ${S}.projects(owner_user_id, created_at DESC);
    -- Projeto ATIVO do agente: quando setado, a thread está "dentro" desse projeto
    -- (coding+git operam no workspace dele e as tools de app-consumer somem — Fase 4).
    ALTER TABLE ${S}.agents ADD COLUMN IF NOT EXISTS active_project_id uuid REFERENCES ${S}.projects(id) ON DELETE SET NULL;
    -- CONTADOR de chamadas de tools (visibilidade no /metrics + base pra decidir o
    -- que colapsar atras de meta-tool). Agregado por (nome, dia): o UPSERT so
    -- incrementa, entao e barato mesmo em volume. Nao guarda call individual.
    CREATE TABLE IF NOT EXISTS ${S}.tool_calls (
      name  text NOT NULL,
      day   date NOT NULL DEFAULT current_date,
      calls bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (name, day)
    );
    CREATE INDEX IF NOT EXISTS tool_calls_day_idx ON ${S}.tool_calls(day);
    -- CATALOGO de tools ja vistas disponiveis (pra listar ate as com 0 chamada).
    CREATE TABLE IF NOT EXISTS ${S}.tool_catalog (
      name       text PRIMARY KEY,
      first_seen timestamptz NOT NULL DEFAULT now(),
      last_seen  timestamptz NOT NULL DEFAULT now()
    );
    -- TRILHA DE AUDITORIA de acesso a dado sensivel do usuario (Gmail/Drive/Docs/
    -- Calendar sob escopo OAuth restrito). Registra QUEM (user_id), O QUE (tool +
    -- recurso), e QUANDO cada leitura aconteceu — exigencia ASVS L1 (V7) e do CASA.
    CREATE TABLE IF NOT EXISTS ${S}.sensitive_access_log (
      id       bigserial PRIMARY KEY,
      user_id  text NOT NULL,
      tool     text NOT NULL,
      resource text,
      detail   text,
      at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sensitive_access_user_idx ON ${S}.sensitive_access_log(user_id, at);

    -- ── Telemetria do App Mobile: erros de JS do React (não-crash) ──
    -- O app "liga pra casa" reportando erros que NÃO derrubam o app (os crashes
    -- nativos vêm por outro caminho, o TestFlight/App Store Connect). Isto é
    -- telemetria de PLATAFORMA (visível só no /metrics, admin), nunca uma feature
    -- de usuário. fingerprint agrupa ocorrências iguais (hash de nome+mensagem+
    -- topo do stack) pra virar "erro X, N ocorrências" em vez de N linhas soltas.
    CREATE TABLE IF NOT EXISTS ${S}.mobile_errors (
      id             bigserial PRIMARY KEY,
      ts             timestamptz DEFAULT now(),
      user_id        uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,  -- nulo se erro antes do login
      fingerprint    text NOT NULL,
      name           text NOT NULL DEFAULT '',
      message        text NOT NULL DEFAULT '',
      stack          text NOT NULL DEFAULT '',
      component_stack text NOT NULL DEFAULT '',
      platform       text NOT NULL DEFAULT '',   -- ios | android
      os_version     text NOT NULL DEFAULT '',
      device         text NOT NULL DEFAULT '',
      app_version    text NOT NULL DEFAULT '',
      build          text NOT NULL DEFAULT '',
      fatal          boolean NOT NULL DEFAULT false,
      extra          jsonb DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS mobile_errors_fp_idx ON ${S}.mobile_errors(fingerprint, ts DESC);
    CREATE INDEX IF NOT EXISTS mobile_errors_ts_idx ON ${S}.mobile_errors(ts DESC);

    -- ── Push tokens (app mobile) ──
    -- Endereço de entrega de push por aparelho (Expo push token). NÃO é segredo
    -- (não dá acesso a nada), então tabela normal, não vault. Um token pertence a
    -- um usuário por vez: se o mesmo aparelho logar com outra conta, o ON CONFLICT
    -- reatribui o token pro novo dono (o logout do anterior já tenta remover).
    CREATE TABLE IF NOT EXISTS ${S}.push_tokens (
      token TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      platform TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON ${S}.push_tokens (user_id);

    -- ── Busca de passagens aéreas (buscar_voos) ──
    -- Duas tabelas com papéis diferentes:
    --  • flight_searches = CACHE da resposta crua da API de busca. A mesma rota/
    --    data consultada de novo dentro da janela de TTL não gasta requisição
    --    (a franquia de busca é o recurso escasso). cache_key = hash dos
    --    parâmetros normalizados, então a chave é estável entre usuários.
    --  • flight_prices = HISTÓRICO próprio de preço por rota/data. É o ativo que
    --    fica NOSSO: com o tempo dá pra dizer "é bom preço" com base no que nós
    --    mesmos medimos no mercado BR, sem depender do price_insights de
    --    terceiro. append-only, 1 linha por consulta que trouxe preço.
    CREATE TABLE IF NOT EXISTS ${S}.flight_searches (
      cache_key   text PRIMARY KEY,
      origin      text NOT NULL DEFAULT '',
      destination text NOT NULL DEFAULT '',
      depart_date date,
      return_date date,
      params      jsonb NOT NULL DEFAULT '{}'::jsonb,
      payload     jsonb NOT NULL,
      hits        int NOT NULL DEFAULT 0,
      fetched_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS flight_searches_fetched_idx ON ${S}.flight_searches(fetched_at DESC);

    CREATE TABLE IF NOT EXISTS ${S}.flight_prices (
      id           bigserial PRIMARY KEY,
      origin       text NOT NULL,
      destination  text NOT NULL,
      depart_date  date NOT NULL,
      return_date  date,
      trip         text NOT NULL DEFAULT 'round',   -- round | oneway
      cabin        text NOT NULL DEFAULT 'economy',
      stops        text NOT NULL DEFAULT 'any',
      price        numeric NOT NULL,                -- menor preço visto na consulta
      currency     text NOT NULL DEFAULT 'BRL',
      airline      text NOT NULL DEFAULT '',
      price_level  text NOT NULL DEFAULT '',        -- low | typical | high (quando a fonte informa)
      typical_low  numeric,
      typical_high numeric,
      captured_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS flight_prices_route_idx
      ON ${S}.flight_prices(origin, destination, depart_date, captured_at DESC);
  `);
  await empresaStore.init(); // before the distribution schema, which puts billing in it (C2, step 5b)
  for (const esquema of esquemas) await esquema({ pool, S });
  await checklistStore.init();
  // Business account F1: who PAID for each line. user_id is still who used it;
  // org_id is stamped at write time when the person is a member (NULL = paid from
  // their own pocket). Lives here, not in the usage_events block, because it depends on the
  // orgs table created above. grant_moved_at marks the personal package that was
  // moved to the business when the person joined (the balance started counting there).
  // grant_expires_at = a credit's own validity (leftover from the plan of whoever
  // creates the business, 30 days; org-billing.mjs). NULL = the general rule of
  // EXTRA_TTL_DAYS from ts.
  await pool.query(`
    ALTER TABLE ${S}.usage_events ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES ${S}.orgs(id) ON DELETE SET NULL;
    ALTER TABLE ${S}.usage_events ADD COLUMN IF NOT EXISTS grant_moved_at timestamptz;
    ALTER TABLE ${S}.usage_events ADD COLUMN IF NOT EXISTS grant_expires_at timestamptz;
    CREATE INDEX IF NOT EXISTS usage_org_idx ON ${S}.usage_events(org_id, ts) WHERE org_id IS NOT NULL;
  `);
  await waInbox.init();
  await reminderExecutionStore.ensureSchema();
  await confirmationStore.ensureSchema();
  await checkoutRecoveryStore.ensureSchema();
  await checkoutRecoveryStore.purgeExpired();
  checkoutCleanupTimer ||= setInterval(()=>checkoutRecoveryStore.purgeExpired().catch(()=>console.error('[checkout-recovery] cleanup failed')),60*60_000).unref();
}

// ── Push tokens (mobile app) ──
// Registers/updates a device's push token for the user. Idempotent:
// the same token reassigns to the current owner (device changed accounts).
export async function registerPushTokenDb(userId, token, platform) {
  await pool.query(
    `INSERT INTO ${S}.push_tokens (token, user_id, platform, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = NOW()`,
    [token, userId, platform || null],
  );
  return { ok: true };
}

// Removes a specific token (logout on that device).
export async function unregisterPushTokenDb(token) {
  await pool.query(`DELETE FROM ${S}.push_tokens WHERE token = $1`, [token]);
  return { ok: true };
}

// A user's push tokens (all their devices).
export async function listPushTokensForUserDb(userId) {
  const { rows } = await pool.query(
    `SELECT token, platform FROM ${S}.push_tokens WHERE user_id = $1`, [userId]);
  return rows;
}

// Prunes invalid tokens (Expo returns DeviceNotRegistered for a dead token).
export async function removePushTokensDb(tokens) {
  if (!tokens || !tokens.length) return { ok: true, removed: 0 };
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.push_tokens WHERE token = ANY($1::text[])`, [tokens]);
  return { ok: true, removed: rowCount };
}

// ── Mobile App error telemetry ──
// Inserts an error reported by the app. `fingerprint` already comes computed by the caller
// (server.mjs). Truncates large fields for safety (the size cap is also enforced
// on the route). Returns the saved id.
export async function insertMobileError(e) {
  const clip = (s, n) => (s == null ? '' : String(s)).slice(0, n);
  const r = await pool.query(
    `INSERT INTO ${S}.mobile_errors
       (user_id, fingerprint, name, message, stack, component_stack, platform, os_version, device, app_version, build, fatal, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      e.userId || null,
      clip(e.fingerprint, 64),
      clip(e.name, 200),
      clip(e.message, 2000),
      clip(e.stack, 20000),
      clip(e.componentStack, 20000),
      clip(e.platform, 40),
      clip(e.osVersion, 60),
      clip(e.device, 120),
      clip(e.appVersion, 60),
      clip(e.build, 60),
      !!e.fatal,
      e.extra && typeof e.extra === 'object' ? JSON.stringify(e.extra).slice(0, 8000) : '{}',
    ],
  );
  return r.rows[0]?.id;
}

// Lists errors GROUPED by fingerprint (what the admin sees on /metrics):
// each group with count, first/last occurrence, builds and affected users,
// and a sample (name/message). Filters by a day window (default 30).
export async function listMobileErrorGroups({ days = 30, limit = 200 } = {}) {
  const d = Math.min(Math.max(1, Number(days) || 30), 365);
  const n = Math.min(Math.max(1, Number(limit) || 200), 500);
  const r = await pool.query(
    `SELECT fingerprint,
            count(*)::int                                   AS ocorrencias,
            count(DISTINCT user_id)::int                    AS usuarios,
            min(ts)                                         AS primeiro,
            max(ts)                                         AS ultimo,
            bool_or(fatal)                                  AS fatal,
            (array_agg(name       ORDER BY ts DESC))[1]     AS name,
            (array_agg(message    ORDER BY ts DESC))[1]     AS message,
            (array_agg(platform   ORDER BY ts DESC))[1]     AS platform,
            array_to_string(array(SELECT DISTINCT build FROM ${S}.mobile_errors m2
                                  WHERE m2.fingerprint = m.fingerprint AND m2.build <> ''
                                    AND m2.ts > now() - ($1 || ' days')::interval), ', ') AS builds
       FROM ${S}.mobile_errors m
      WHERE ts > now() - ($1 || ' days')::interval
      GROUP BY fingerprint
      ORDER BY ultimo DESC
      LIMIT $2`,
    [String(d), n],
  );
  return r.rows;
}

// Samples (the most recent occurrences) of a fingerprint, with the full stack,
// so the admin can open the detail of a specific error.
export async function listMobileErrorSamples(fingerprint, limit = 20) {
  const n = Math.min(Math.max(1, Number(limit) || 20), 50);
  const r = await pool.query(
    `SELECT m.id, m.ts, m.name, m.message, m.stack, m.component_stack, m.platform,
            m.os_version, m.device, m.app_version, m.build, m.fatal, m.extra,
            m.user_id, u.name AS user_name, u.email AS user_email
       FROM ${S}.mobile_errors m
       LEFT JOIN ${S}.users u ON u.id = m.user_id
      WHERE m.fingerprint = $1
      ORDER BY m.ts DESC
      LIMIT $2`,
    [String(fingerprint || '').slice(0, 64), n],
  );
  return r.rows;
}

// ── Contador de chamadas de tools ──
// Incrementa o contador (agregado por dia) a partir de um mapa {nome: n}.
// Fire-and-forget no server; erro so loga, nunca quebra o turno.
export async function bumpToolCalls(counts) {
  const entries = Object.entries(counts || {}).filter(([, n]) => n > 0);
  if (!entries.length) return;
  const names = entries.map(([n]) => n);
  const nums = entries.map(([, n]) => Number(n));
  await pool.query(
    `INSERT INTO ${S}.tool_calls (name, day, calls)
     SELECT x.name, current_date, x.n
     FROM unnest($1::text[], $2::bigint[]) AS x(name, n)
     ON CONFLICT (name, day) DO UPDATE SET calls = ${S}.tool_calls.calls + EXCLUDED.calls`,
    [names, nums],
  );
}

// Writes an entry in the audit trail for sensitive data access (reading
// Gmail/Drive/Docs/Calendar). Fire-and-forget: error only logs, never breaks the turn.
export async function logSensitiveAccess({ userId, tool, resource = null, detail = null }) {
  if (!userId || !tool) return;
  try {
    await pool.query(
      `INSERT INTO ${S}.sensitive_access_log (user_id, tool, resource, detail) VALUES ($1, $2, $3, $4)`,
      [String(userId), String(tool), resource == null ? null : String(resource).slice(0, 300), detail == null ? null : String(detail).slice(0, 500)],
    );
  } catch (e) {
    console.error('[audit] logSensitiveAccess failed:', e?.message ?? e);
  }
}

// Registra nomes de tools disponiveis no catalogo (pra listar ate as nunca
// chamadas). Idempotente; so atualiza last_seen em conflito.
export async function recordToolCatalog(names) {
  const list = [...new Set(names || [])].filter(Boolean);
  if (!list.length) return;
  await pool.query(
    `INSERT INTO ${S}.tool_catalog (name)
     SELECT unnest($1::text[])
     ON CONFLICT (name) DO UPDATE SET last_seen = now()`,
    [list],
  );
}

// Per-tool statistics: total, last 7d, today and last-used date. LEFT JOIN
// on the catalog (union with already-called names) to include tools with 0 calls.
export async function getToolCallStats() {
  const { rows } = await pool.query(
    `WITH names AS (
       SELECT name FROM ${S}.tool_catalog
       UNION
       SELECT DISTINCT name FROM ${S}.tool_calls
     )
     SELECT n.name,
            COALESCE(SUM(t.calls), 0)::bigint AS total,
            COALESCE(SUM(t.calls) FILTER (WHERE t.day >= current_date - 6), 0)::bigint AS d7,
            COALESCE(SUM(t.calls) FILTER (WHERE t.day = current_date), 0)::bigint AS d1,
            MAX(t.day) AS last_day
     FROM names n
     LEFT JOIN ${S}.tool_calls t ON t.name = n.name
     GROUP BY n.name
     ORDER BY total DESC, n.name`,
  );
  return rows;
}

// ── System config (plans, pricing, hosting) editable from the admin panel ──
// JSON key-value. One row per key (e.g.: 'pricing'). Applied in-process
// at boot and on every write, so it changes for everyone in the system.

export async function getConfig(key) {
  const { rows } = await pool.query(
    `SELECT value FROM ${S}.app_config WHERE key = $1`, [key],
  );
  return rows[0]?.value ?? null;
}

export async function setConfig(key, value) {
  await pool.query(
    `INSERT INTO ${S}.app_config (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// ── Projects (dev mode / advanced tier) ──
const PROJECT_DEPLOY_TYPES = ['own_ssh', 'dedicated'];

function projectRow(r) {
  if (!r) return null;
  return {
    id: r.id, ownerUserId: r.owner_user_id, nome: r.nome, repoUrl: r.repo_url,
    provider: r.provider, workspaceRef: r.workspace_ref,
    deployTargetType: r.deploy_target_type, deployConfig: r.deploy_config || {},
    permMode: r.perm_mode, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function createProject(ownerUserId, { nome, repoUrl, provider = 'github', workspaceRef = null, deployTargetType = 'own_ssh', deployConfig = {} }) {
  const name = String(nome || '').trim();
  if (!name) return { error: 'nome_vazio' };
  if (!PROJECT_DEPLOY_TYPES.includes(deployTargetType)) deployTargetType = 'own_ssh';
  const dup = await pool.query(`SELECT id FROM ${S}.projects WHERE owner_user_id=$1 AND nome=$2`, [ownerUserId, name]);
  if (dup.rows[0]) return { error: 'ja_existe', id: dup.rows[0].id };
  const { rows } = await pool.query(
    `INSERT INTO ${S}.projects (owner_user_id, nome, repo_url, provider, workspace_ref, deploy_target_type, deploy_config)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
    [ownerUserId, name, repoUrl || null, provider, workspaceRef, deployTargetType, JSON.stringify(deployConfig || {})],
  );
  return { ok: true, project: projectRow(rows[0]) };
}

export async function listProjects(ownerUserId) {
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.projects WHERE owner_user_id=$1 AND status<>'archived' ORDER BY created_at DESC`, [ownerUserId],
  );
  return rows.map(projectRow);
}

export async function getProject(id, ownerUserId = null) {
  const q = ownerUserId
    ? await pool.query(`SELECT * FROM ${S}.projects WHERE id=$1 AND owner_user_id=$2`, [id, ownerUserId])
    : await pool.query(`SELECT * FROM ${S}.projects WHERE id=$1`, [id]);
  return projectRow(q.rows[0]);
}

export async function getProjectByName(ownerUserId, nome) {
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.projects WHERE owner_user_id=$1 AND lower(nome)=lower($2)`, [ownerUserId, String(nome || '').trim()],
  );
  return projectRow(rows[0]);
}

export async function updateProjectFields(id, ownerUserId, fields = {}) {
  const map = { repoUrl: 'repo_url', workspaceRef: 'workspace_ref', deployTargetType: 'deploy_target_type', deployConfig: 'deploy_config', permMode: 'perm_mode', status: 'status' };
  const sets = []; const vals = []; let i = 1;
  for (const [k, col] of Object.entries(map)) {
    if (fields[k] === undefined) continue;
    if (k === 'deployConfig') { sets.push(`${col}=$${i}::jsonb`); vals.push(JSON.stringify(fields[k] || {})); }
    else { sets.push(`${col}=$${i}`); vals.push(fields[k]); }
    i++;
  }
  if (!sets.length) return { ok: false, error: 'nada a atualizar' };
  sets.push('updated_at=now()');
  vals.push(id, ownerUserId);
  const { rows } = await pool.query(
    `UPDATE ${S}.projects SET ${sets.join(', ')} WHERE id=$${i} AND owner_user_id=$${i + 1} RETURNING *`, vals,
  );
  return rows[0] ? { ok: true, project: projectRow(rows[0]) } : { ok: false, error: 'nao_encontrado' };
}

export async function deleteProject(id, ownerUserId) {
  const { rowCount } = await pool.query(`DELETE FROM ${S}.projects WHERE id=$1 AND owner_user_id=$2`, [id, ownerUserId]);
  return { ok: rowCount > 0 };
}

export async function setAgentActiveProject(agentId, userId, projectId) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.agents SET active_project_id=$3 WHERE id=$1 AND user_id=$2`,
    [agentId, userId, projectId || null],
  );
  return { ok: rowCount > 0 };
}

export async function getActiveProjectForAgent(agentId) {
  const { rows } = await pool.query(
    `SELECT p.* FROM ${S}.projects p JOIN ${S}.agents a ON a.active_project_id = p.id WHERE a.id = $1`,
    [agentId],
  );
  return projectRow(rows[0]);
}

// ── Grounding guards ──

// Saves the findings of ONE turn. Never breaks the turn: recording is an observation,
// not part of the response, so a database failure just becomes a log.
export async function logGroundingBrakes(findings, {
  userId = null, agentId = null, threadId = null, origem = 'chat',
  desfecho = 'corrigido', ferramentas = null,
} = {}) {
  if (!Array.isArray(findings) || !findings.length) return 0;
  let n = 0;
  for (const f of findings.slice(0, 20)) {
    try {
      await pool.query(
        `INSERT INTO ${S}.grounding_brakes
           (user_id, agent_id, thread_id, kind, dado, trecho, origem, desfecho, ferramentas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [userId, agentId, threadId, String(f.kind || '?').slice(0, 60),
          f.dado ? String(f.dado).slice(0, 300) : null,
          f.trecho ? String(f.trecho).slice(0, 500) : null,
          String(origem).slice(0, 20), String(desfecho).slice(0, 20),
          ferramentas ? String(ferramentas).slice(0, 300) : null],
      );
      n++;
    } catch (e) { console.error('[grounding_brakes]', e?.message ?? e); }
  }
  return n;
}

export async function listGroundingBrakes({ kind = null, desfecho = null, dias = 30, limit = 500 } = {}) {
  const args = [limit, Number(dias) > 0 ? Number(dias) : 30];
  const cond = [`b.created_at > now() - ($2 || ' days')::interval`];
  if (kind) { args.push(kind); cond.push(`b.kind = ${args.length}`); }
  if (desfecho) { args.push(desfecho); cond.push(`b.desfecho = ${args.length}`); }
  const { rows } = await pool.query(
    `SELECT b.id, b.created_at, b.kind, b.dado, b.trecho, b.origem, b.desfecho,
            b.ferramentas, b.thread_id, b.agent_id,
            u.email AS user_email, u.name AS user_name, a.name AS agent_name
       FROM ${S}.grounding_brakes b
       LEFT JOIN ${S}.users u ON u.id = b.user_id
       LEFT JOIN ${S}.agents a ON a.id = b.agent_id
      WHERE ${cond.join(' AND ')}
      ORDER BY b.created_at DESC
      LIMIT $1`,
    args,
  );
  return rows;
}

// ── Mini-PaaS: user subdomain + app registry ──

function _slug(s) {
  return (s || '').toString().normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'user';
}

// Ensures the user has a unique subdomain (label) and returns {label,name}.
// Generates it from the name (or email) the 1st time; suffixes a number on collision.
export async function ensureUserSubdomain(userId) {
  const { rows: ur } = await pool.query(
    `SELECT name, email, subdomain FROM ${S}.users WHERE id = $1`, [userId]);
  const u = ur[0];
  if (!u) throw new Error('usuário não encontrado');
  if (u.subdomain) return { label: u.subdomain, name: u.name };
  const base = _slug(u.name || (u.email || '').split('@')[0]);
  for (let i = 0; i < 50; i++) {
    const cand = i === 0 ? base : `${base}${i + 1}`;
    try {
      const { rows } = await pool.query(
        `UPDATE ${S}.users SET subdomain = $2 WHERE id = $1 AND subdomain IS NULL RETURNING subdomain`,
        [userId, cand],
      );
      if (rows.length) return { label: rows[0].subdomain, name: u.name };
      const { rows: again } = await pool.query(
        `SELECT name, subdomain FROM ${S}.users WHERE id = $1`, [userId]);
      if (again[0]?.subdomain) return { label: again[0].subdomain, name: again[0].name };
    } catch (e) {
      if (!/unique|duplicate/i.test(String(e.message))) throw e;
    }
  }
  throw new Error('não consegui gerar subdomínio');
}

export async function registerApp({ userId, agentId, label, system, runtime, mem, cpus, url }) {
  await pool.query(
    `INSERT INTO ${S}.apps (user_id, agent_id, label, system, runtime, status, mem, cpus, url)
     VALUES ($1,$2,$3,$4,$5,'running',$6,$7,$8)
     ON CONFLICT (label, system) DO UPDATE SET
       runtime = EXCLUDED.runtime, status = 'running', mem = EXCLUDED.mem,
       cpus = EXCLUDED.cpus, url = EXCLUDED.url, agent_id = EXCLUDED.agent_id,
       updated_at = now()`,
    [userId, agentId || null, label, system, runtime, mem || null, cpus || null, url || null],
  );
}

export async function setAppStatus(userId, system, status) {
  await pool.query(
    `UPDATE ${S}.apps SET status = $3, updated_at = now() WHERE user_id = $1 AND system = $2`,
    [userId, system, status],
  );
}

export async function deleteAppRow(userId, system) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`app:${userId}:${system}`]);
    await c.query(`DELETE FROM ${S}.app_secrets WHERE user_id=$1 AND system=$2`,[userId,system]);
    await c.query(`DELETE FROM ${S}.app_collab WHERE owner_user_id=$1 AND system=$2`,[userId,system]);
    const {rowCount}=await c.query(`DELETE FROM ${S}.apps WHERE user_id=$1 AND system=$2`,[userId,system]);
    await c.query('COMMIT');return rowCount;
  } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;} finally {c.release();}
}

export async function getAppRow(userId, system) {
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.apps WHERE user_id = $1 AND system = $2`, [userId, system]);
  return rows[0] || null;
}

export async function listAppsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, label, system, runtime, status, url, created_at, mode,
            visibility, description, access, access_user,
            (source_snapshot IS NOT NULL) AS replicavel
       FROM ${S}.apps
      WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return rows;
}

// ── App moderation panel (/metrics) ──
// ALL apps, from all owners, with the risk label already computed. This is an
// admin route: never expose it to the user. Doesn't bring the source (large blob), only
// whether it exists and when it's from.
export async function listAppsForModeration() {
  const { rows } = await pool.query(
    `SELECT a.id, a.user_id, u.name AS owner_name, u.email AS owner_email,
            a.label, a.system, a.runtime, a.status, a.url, a.mode,
            a.visibility, a.access, a.description,
            a.created_at, a.updated_at, a.snapshot_at,
            (a.source_snapshot IS NOT NULL) AS tem_codigo,
            a.risk_label, a.risk_summary, a.risk_reason, a.risk_signals,
            a.risk_at, a.risk_snapshot_at
       FROM ${S}.apps a
       LEFT JOIN ${S}.users u ON u.id = a.user_id
      ORDER BY a.created_at`);
  return rows;
}

// Source of ONE app to classify (by id, not by owner: the caller is the admin).
export async function getAppSourceById(appId) {
  const { rows } = await pool.query(
    `SELECT id, label, system, runtime, description, snapshot_at, source_snapshot
       FROM ${S}.apps WHERE id = $1`, [appId]);
  return rows[0] || null;
}

// Saves the label. `signals` goes as jsonb (deterministic signals + domains).
export async function setAppRisk(appId, { label, summary, reason, signals, snapshotAt } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.apps
        SET risk_label = $2, risk_summary = $3, risk_reason = $4,
            risk_signals = $5::jsonb, risk_at = now(), risk_snapshot_at = $6
      WHERE id = $1`,
    [appId, label || null, summary || null, reason || null,
     JSON.stringify(signals || {}), snapshotAt || null],
  );
  return rowCount;
}

// ── App code snapshot (Phase 2: data doesn't travel) ──
// Stores ONLY the source sent on publish (already compressed by the caller). It's the base
// to replicate a public app. Runtime data (SQLite/uploads in /app/data)
// is never sent, so it never enters the snapshot or travels.
export async function setAppSnapshot(userId, system, snapshot) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.apps SET source_snapshot = $3, snapshot_at = now()
      WHERE user_id = $1 AND system = $2`,
    [userId, system, snapshot || null],
  );
  return rowCount;
}

export async function getAppSnapshot(userId, system) {
  const { rows } = await pool.query(
    `SELECT source_snapshot, snapshot_at FROM ${S}.apps WHERE user_id = $1 AND system = $2`,
    [userId, system],
  );
  return rows[0] || null;
}

// ── App file draft (pre-publish staging) ──
// The agent assembles the app file by file here; publicar_sistema reads the draft and
// applies it. Stores only the SOURCE in base64 (same format as the publish map). Runtime
// data never enters. Key (user_id, system, path) = per app owner.
export async function putAppDraftFile(userId, system, caminho, conteudoB64) {
  await pool.query(
    `INSERT INTO ${S}.app_drafts (user_id, system, caminho, conteudo)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, system, caminho) DO UPDATE SET
       conteudo = EXCLUDED.conteudo, updated_at = now()`,
    [userId, system, caminho, conteudoB64],
  );
}

export async function getAppDraft(userId, system) {
  const { rows } = await pool.query(
    `SELECT caminho, conteudo FROM ${S}.app_drafts WHERE user_id = $1 AND system = $2`,
    [userId, system]);
  const files = {};
  for (const r of rows) files[r.caminho] = r.conteudo;
  return files;
}

export async function deleteAppDraftFile(userId, system, caminho) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.app_drafts WHERE user_id = $1 AND system = $2 AND caminho = $3`,
    [userId, system, caminho]);
  return rowCount;
}

export async function clearAppDraft(userId, system) {
  await pool.query(
    `DELETE FROM ${S}.app_drafts WHERE user_id = $1 AND system = $2`,
    [userId, system]);
}

// The user's open drafts, most recent to oldest. A draft is
// exactly "app under construction", so it's the most reliable clue to which app is
// being worked on when the assistant doesn't repeat the system name in the call.
export async function listAppDraftSystems(userId) {
  const { rows } = await pool.query(
    `SELECT system FROM ${S}.app_drafts WHERE user_id = $1
      GROUP BY system ORDER BY max(updated_at) DESC`, [userId]);
  return rows.map((r) => r.system);
}

// ── Public/private visibility + discovery + replication (Phase 3) ──
export async function setAppVisibility(userId, system, visibility, description) {
  const vis = visibility === 'public' ? 'public' : 'private';
  const { rowCount } = await pool.query(
    `UPDATE ${S}.apps SET visibility = $3,
            description = COALESCE($4, description), updated_at = now()
      WHERE user_id = $1 AND system = $2`,
    [userId, system, vis, description ?? null],
  );
  return rowCount;
}

// ── Network access: username/password for the public URL (router gate) ──
// Independent of visibility (library). access: 'private' | 'public' | null.
// null = old app, published before the gate existed: treated as open so it doesn't
// break an already-distributed link (see DDL). Returns the password in PLAIN TEXT — only
// call from a context that already resolved ownership of the app.
export async function getAppAccess(userId, system) {
  const { rows } = await pool.query(
    `SELECT access, access_user, access_pass_enc FROM ${S}.apps
      WHERE user_id = $1 AND system = $2`, [userId, system]);
  const r = rows[0];
  if (!r) return null;
  let pass = null;
  try { pass = r.access_pass_enc ? decMaybe(r.access_pass_enc) : null; } catch { pass = null; }
  return { access: r.access || null, user: r.access_user || null, pass };
}

// Saves access. Passing pass=null keeps the current password (doesn't accidentally erase it);
// to remove the credential for good, send access:'public'.
export async function setAppAccess(userId, system, { access, user, pass } = {}) {
  const acc = access === 'public' ? 'public' : 'private';
  const { rowCount } = await pool.query(
    `UPDATE ${S}.apps SET access = $3,
            access_user = COALESCE($4, access_user),
            access_pass_enc = COALESCE($5, access_pass_enc),
            updated_at = now()
      WHERE user_id = $1 AND system = $2`,
    [userId, system, acc, user ?? null, pass == null ? null : encMaybe(String(pass))],
  );
  return rowCount;
}

// Searches replicable PUBLIC apps (have a code snapshot). q matches
// system/description/label. Doesn't return the snapshot (only metadata for discovery).
export async function listPublicApps({ q, limit = 30 } = {}) {
  const vals = [];
  const where = [`a.visibility = 'public'`, `a.source_snapshot IS NOT NULL`];
  if (q && String(q).trim()) {
    vals.push(`%${String(q).trim().toLowerCase()}%`);
    where.push(`(lower(a.system) LIKE $${vals.length} OR lower(coalesce(a.description,'')) LIKE $${vals.length} OR lower(a.label) LIKE $${vals.length})`);
  }
  vals.push(Math.min(Number(limit) || 30, 100));
  const { rows } = await pool.query(
    `SELECT a.label, a.system, a.runtime, a.description, a.url, a.updated_at,
            u.name AS owner_name
       FROM ${S}.apps a
       LEFT JOIN ${S}.users u ON u.id = a.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.updated_at DESC
      LIMIT $${vals.length}`,
    vals,
  );
  return rows;
}

// Gets a public app by label+system, WITH the code snapshot (to replicate).
// Only returns if it's public and has a snapshot; otherwise null.
export async function getPublicApp(label, system) {
  const { rows } = await pool.query(
    `SELECT label, system, runtime, description, source_snapshot
       FROM ${S}.apps
      WHERE label = $1 AND system = $2 AND visibility = 'public'
            AND source_snapshot IS NOT NULL`,
    [label, system],
  );
  return rows[0] || null;
}

// ── Per-app secrets vault (env injected at container boot) ──
// Key = environment variable name (UPPERCASE/digit/_). Value encrypted in the
// database; only decrypted in memory at the moment of injecting into the container.
export const RE_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

export async function setAppSecret(userId, system, key, value) {
  const k = String(key || '').trim();
  if (!RE_ENV_KEY.test(k) || k.length > 128) return { error: 'chave_invalida' };
  if (String(value ?? '').length > 8192) return { error: 'valor_grande' };
  if (!vaultEnabled()) return { error: 'cofre_indisponivel' };
  const enc = encryptSecret(String(value ?? ''));
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`app:${userId}:${system}`]);
  await c.query(
    `INSERT INTO ${S}.app_secrets (user_id, system, key, value_enc)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, system, key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
    [userId, system, k, enc],
  );
    await c.query('COMMIT');
  } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;} finally {c.release();}
  return { ok: true };
}

export async function listAppSecrets(userId, system) {
  const { rows } = await pool.query(
    `SELECT key, updated_at FROM ${S}.app_secrets WHERE user_id = $1 AND system = $2 ORDER BY key`,
    [userId, system],
  );
  return rows;
}

export async function deleteAppSecret(userId, system, key) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.app_secrets WHERE user_id = $1 AND system = $2 AND key = $3`,
    [userId, system, String(key || '').trim()],
  );
  return rowCount;
}

// Returns {KEY: text_value} to inject as env. Skips a corrupted secret.
export async function getAppSecretsDecrypted(userId, system) {
  const { rows } = await pool.query(
    `SELECT key, value_enc FROM ${S}.app_secrets WHERE user_id = $1 AND system = $2`,
    [userId, system],
  );
  const out = {};
  for (const r of rows) {
    try { out[r.key] = decryptSecret(r.value_enc); } catch { /* pula */ }
  }
  return out;
}

// ── Mode B collaboration (single shared instance) ──
// An owner lets a CONNECTED collaborator work on THEIR OWN app in the SAME
// instance (same code, same /app/data, same container). The collaborator
// does NOT get their own app; they're added via the app_collab roster. GATE: only whoever has
// an ACCEPTED agent_connection with the owner can enter (checked at invite time). Billing by owner.

// Resolves, from ME and a contact's email/name, the connected USER
// (ACCEPTED connection). Different from resolveContactTarget: doesn't require an inbound agent,
// just the identity of the other side (to become owner or collaborator of an app).
// Returns { ok, userId, name, email } or { error }.
export async function resolveConnectedUser(fromUserId, contactQuery) {
  const q = String(contactQuery || '').trim().toLowerCase();
  if (!q) return { error: 'contato_vazio' };
  const contacts = await listContacts(fromUserId);
  const accepted = contacts.filter((c) => c.status === 'accepted');
  // Same rule as resolveContactTarget: exact email, otherwise exact name, otherwise
  // name that contains it. If the step matches more than one person, it does NOT pick the
  // first one: it returns ambiguous. Here the cost of a mistake is high, because this
  // resolver is what grants edit access to an app and entry into a Space.
  const byEmail = accepted.filter((c) => (c.personEmail || '').toLowerCase() === q);
  const byName = accepted.filter((c) => (c.personName || '').toLowerCase() === q);
  const byPart = accepted.filter((c) => (c.personName || '').toLowerCase().includes(q));
  const matches = byEmail.length ? byEmail : (byName.length ? byName : byPart);
  if (!matches.length) return { error: 'contato_nao_encontrado' };
  if (matches.length > 1) {
    return {
      error: 'contato_ambiguo',
      opcoes: matches.map((c) => ({ nome: c.personName, email: c.personEmail })),
    };
  }
  const hit = matches[0];
  return { ok: true, userId: hit.personUserId, name: hit.personName, email: hit.personEmail };
}

// Single phrasing for the ambiguous case. Lives next to the resolver because every tool that
// resolves a contact needs to say the SAME thing: who matched and that only the owner
// can break the tie. Without it, each caller printed the error code to the model.
export function contatoAmbiguoMsg(contato, opcoes = []) {
  const lista = (opcoes || []).map((o) => (o.email ? o.nome + ' (' + o.email + ')' : o.nome)).join(', ');
  return '"' + contato + '" casa com mais de um contato seu: ' + lista
    + '. Pergunte ao seu dono de qual dessas pessoas ele está falando e me diga o e-mail dela.';
}

// Adds a collaborator to an app's roster for the owner. Idempotent.
export async function addAppCollaborator(ownerUserId, system, collabUserId, agentId) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`app:${ownerUserId}:${system}`]);
    const app=await c.query(`SELECT 1 FROM ${S}.apps WHERE user_id=$1 AND system=$2`,[ownerUserId,system]);
    if(!app.rows.length)throw Error('O app não está disponível. Atualize antes de convidar alguém.');
  await c.query(
    `INSERT INTO ${S}.app_collab (owner_user_id, system, collab_user_id, added_by_agent)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (owner_user_id, system, collab_user_id) DO NOTHING`,
    [ownerUserId, system, collabUserId, agentId || null],
  );
    await c.query('COMMIT');
  } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;} finally {c.release();}
  return { ok: true };
}

export async function removeAppCollaborator(ownerUserId, system, collabUserId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.app_collab
      WHERE owner_user_id = $1 AND system = $2 AND collab_user_id = $3`,
    [ownerUserId, system, collabUserId],
  );
  return rowCount;
}

// True if collabUserId is in the app's roster (owner_user_id, system).
export async function isAppCollaborator(ownerUserId, system, collabUserId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM ${S}.app_collab
      WHERE owner_user_id = $1 AND system = $2 AND collab_user_id = $3 LIMIT 1`,
    [ownerUserId, system, collabUserId],
  );
  return rows.length > 0;
}

// Lists an owner's app collaborators (with name/email).
export async function listAppCollaborators(ownerUserId, system) {
  const { rows } = await pool.query(
    `SELECT c.collab_user_id, c.created_at, u.name, u.email
       FROM ${S}.app_collab c
       JOIN ${S}.users u ON u.id = c.collab_user_id
      WHERE c.owner_user_id = $1 AND c.system = $2
      ORDER BY c.created_at`,
    [ownerUserId, system],
  );
  return rows.map((r) => ({
    userId: r.collab_user_id, name: r.name, email: r.email, created_at: r.created_at,
  }));
}

// Apps from OTHER owners that this user can operate as a collaborator (with the
// instance owner to address/resolve). Joins with apps to bring label/url.
export async function listSharedAppsForCollaborator(collabUserId) {
  const { rows } = await pool.query(
    `SELECT c.owner_user_id, c.system, a.label, a.runtime, a.status, a.url,
            u.name AS owner_name, u.email AS owner_email
       FROM ${S}.app_collab c
       JOIN ${S}.apps a ON a.user_id = c.owner_user_id AND a.system = c.system
       JOIN ${S}.users u ON u.id = c.owner_user_id
      WHERE c.collab_user_id = $1
      ORDER BY c.created_at DESC`,
    [collabUserId],
  );
  return rows.map((r) => ({
    ownerUserId: r.owner_user_id, ownerName: r.owner_name, ownerEmail: r.owner_email,
    system: r.system, label: r.label, runtime: r.runtime, status: r.status, url: r.url,
  }));
}

// ── Spaces: shared living subject, no app/runtime ──
// spaces = definition (about) + roster (space_members) + live data (space_entries).
// Sharing gate = ACCEPTED agent_connection (checked at invite time).

function slugifySpace(name) {
  return String(name || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'espaco';
}

// Creates an owner's space and inserts them as a member. Idempotent by (owner, slug).
export async function createSpace(ownerUserId, { nome, sobre }, agentId) {
  const title = String(nome || '').trim();
  if (!title) return { error: 'nome_vazio' };
  let slug = slugifySpace(title);
  const existing = await pool.query(
    `SELECT id FROM ${S}.spaces WHERE owner_user_id = $1 AND slug = $2`, [ownerUserId, slug],
  );
  if (existing.rows[0]) return { error: 'ja_existe', id: existing.rows[0].id, slug };
  const { rows } = await pool.query(
    `INSERT INTO ${S}.spaces (owner_user_id, slug, title, about)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [ownerUserId, slug, title, String(sobre || '').trim()],
  );
  const id = rows[0].id;
  await pool.query(
    `INSERT INTO ${S}.space_members (space_id, user_id, added_by_agent)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [id, ownerUserId, agentId || null],
  );
  return { ok: true, id, slug, title };
}

// All spaces the user sees (owner OR member), with entry count.
export async function listSpacesForUser(userId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.slug, s.title, s.about, s.owner_user_id, s.updated_at, s.share_mode,
            u.name AS owner_name, u.email AS owner_email,
            (SELECT count(*) FROM ${S}.space_entries e WHERE e.space_id = s.id) AS entries,
            (s.owner_user_id = $1) AS is_owner
       FROM ${S}.spaces s
       JOIN ${S}.space_members m ON m.space_id = s.id AND m.user_id = $1
       JOIN ${S}.users u ON u.id = s.owner_user_id
      ORDER BY s.updated_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, slug: r.slug, title: r.title, about: r.about,
    ownerUserId: r.owner_user_id, ownerName: r.owner_name, ownerEmail: r.owner_email,
    updatedAt: r.updated_at, entries: Number(r.entries), isOwner: r.is_owner,
    shareMode: r.share_mode === 'manual' ? 'manual' : 'auto',
  }));
}

export async function isSpaceMember(spaceId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM ${S}.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 1`,
    [spaceId, userId],
  );
  return !!rows[0];
}

// Resolves a space by NAME/slug from the caller. Optional `dono` (name/email
// of a connected contact) disambiguates when the space belongs to another person. Mirrors
// resolveApp. Returns { ok, space } | { error }.
export async function resolveSpace(callerUserId, query, dono) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { error: 'espaco_vazio' };
  const all = await listSpacesForUser(callerUserId);
  let cands = all.filter((s) => s.slug === slugifySpace(q) || s.title.toLowerCase() === q
    || s.slug.includes(slugifySpace(q)) || s.title.toLowerCase().includes(q));
  if (dono) {
    const who = await resolveConnectedUser(callerUserId, dono);
    if (who.error) return { error: who.error, opcoes: who.opcoes };
    cands = cands.filter((s) => s.ownerUserId === who.userId);
  }
  if (!cands.length) return { error: 'espaco_nao_encontrado' };
  if (cands.length > 1) {
    return { error: 'ambiguo', options: cands.map((s) => ({ title: s.title, owner: s.ownerName })) };
  }
  return { ok: true, space: cands[0] };
}

// Sets the space's sharing mode ('auto' | 'manual'). Owner only.
export async function setSpaceMode(spaceId, ownerUserId, mode) {
  const m = mode === 'manual' ? 'manual' : 'auto';
  const { rowCount } = await pool.query(
    `UPDATE ${S}.spaces SET share_mode = $3, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2`,
    [spaceId, ownerUserId, m],
  );
  if (!rowCount) return { error: 'nao_e_dono' };
  return { ok: true, mode: m };
}

// Adds a member to the space (idempotent). Touches the space's updated_at.
export async function addSpaceMember(spaceId, userId, agentId) {
  await pool.query(
    `INSERT INTO ${S}.space_members (space_id, user_id, added_by_agent)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [spaceId, userId, agentId || null],
  );
  await pool.query(`UPDATE ${S}.spaces SET updated_at = now() WHERE id = $1`, [spaceId]);
  return { ok: true };
}

export async function removeSpaceMember(spaceId, userId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.space_members WHERE space_id = $1 AND user_id = $2`, [spaceId, userId],
  );
  return rowCount;
}

export async function listSpaceMembers(spaceId) {
  const { rows } = await pool.query(
    `SELECT m.user_id, u.name, u.email, (m.user_id = s.owner_user_id) AS is_owner
       FROM ${S}.space_members m
       JOIN ${S}.users u ON u.id = m.user_id
       JOIN ${S}.spaces s ON s.id = m.space_id
      WHERE m.space_id = $1 ORDER BY is_owner DESC, m.created_at`,
    [spaceId],
  );
  return rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, isOwner: r.is_owner }));
}

// Saves a note in the space's live data. Touches the space's updated_at.
export async function addSpaceEntry(spaceId, authorUserId, agentId, { body, tag }) {
  const text = String(body || '').trim();
  if (!text) return { error: 'nota_vazia' };
  const { rows } = await pool.query(
    `INSERT INTO ${S}.space_entries (space_id, author_user_id, author_agent, body, tag)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [spaceId, authorUserId || null, agentId || null, text, String(tag || '').trim()],
  );
  await pool.query(`UPDATE ${S}.spaces SET updated_at = now() WHERE id = $1`, [spaceId]);
  return { ok: true, id: rows[0].id };
}

// Last N entries of the space (with author). Order: most recent first.
export async function listSpaceEntries(spaceId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT e.id, e.body, e.tag, e.created_at, u.name AS author_name
       FROM ${S}.space_entries e
       LEFT JOIN ${S}.users u ON u.id = e.author_user_id
      WHERE e.space_id = $1 ORDER BY e.created_at DESC LIMIT $2`,
    [spaceId, Math.min(Number(limit) || 50, 200)],
  );
  return rows.map((r) => ({
    id: r.id, body: r.body, tag: r.tag, createdAt: r.created_at, author: r.author_name || 'alguém',
  }));
}

export async function deleteSpaceEntry(spaceId, entryId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.space_entries WHERE id = $1 AND space_id = $2`, [entryId, spaceId],
  );
  return rowCount;
}

// A specific entry (to check authorship before editing/deleting).
export async function getSpaceEntry(entryId, spaceId) {
  const { rows } = await pool.query(
    `SELECT id, space_id, author_user_id, body, tag FROM ${S}.space_entries
      WHERE id = $1 AND space_id = $2`,
    [entryId, spaceId],
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id, spaceId: rows[0].space_id,
    authorUserId: rows[0].author_user_id, body: rows[0].body, tag: rows[0].tag,
  };
}

// Edits the body and/or tag of an entry. Only the fields passed in change.
export async function updateSpaceEntry(entryId, spaceId, { body, tag }) {
  const sets = []; const vals = []; let i = 1;
  if (body != null) { sets.push(`body = $${i}`); vals.push(String(body).trim()); i += 1; }
  if (tag != null) { sets.push(`tag = $${i}`); vals.push(String(tag).trim()); i += 1; }
  if (!sets.length) return { error: 'nada_pra_mudar' };
  sets.push('updated_at = now()');
  vals.push(entryId, spaceId);
  const { rowCount } = await pool.query(
    `UPDATE ${S}.space_entries SET ${sets.join(', ')} WHERE id = $${i} AND space_id = $${i + 1}`,
    vals,
  );
  return rowCount ? { ok: true } : { error: 'nao_encontrada' };
}

// ── Trackers: structured record of dated/countable events ──────────────
// A tracker = a named series (sugar, workout, weight, spending). tracker_events is
// APPEND-ONLY: recording = INSERT of 1 row, never rewrites. Counting is always
// SQL, never the model. Scoped per user. See projetos/tracker-primitiva.md.

function slugifyTracker(name) {
  return String(name || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tracker';
}

// Finds a user's tracker by name/slug. Returns { ok, tracker } | { error }.
// error: nao_encontrado | ambiguo (with options).
export async function resolveTracker(userId, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return { error: 'nome_vazio' };
  const all = await listTrackers(userId);
  const slug = slugifyTracker(q);
  let cands = all.filter((t) => t.slug === slug || t.title.toLowerCase() === q);
  if (!cands.length) cands = all.filter((t) => t.slug.includes(slug) || t.title.toLowerCase().includes(q));
  if (!cands.length) return { error: 'nao_encontrado' };
  if (cands.length > 1) return { error: 'ambiguo', options: cands.map((t) => t.title) };
  return { ok: true, tracker: cands[0] };
}

// Finds OR creates the tracker (auto-creation on first record). Idempotent by
// (owner, slug). Returns { tracker, created }.
export async function resolveOrCreateTracker(userId, name, agentId, { kind, unit } = {}) {
  const found = await resolveTracker(userId, name);
  if (found.ok) return { tracker: found.tracker, created: false };
  if (found.error === 'ambiguo') return { error: 'ambiguo', options: found.options };
  const title = String(name || '').trim();
  if (!title) return { error: 'nome_vazio' };
  const slug = slugifyTracker(title);
  const { rows } = await pool.query(
    `INSERT INTO ${S}.trackers (owner_user_id, agent_id, slug, title, kind, unit)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_user_id, slug) DO UPDATE SET updated_at = now()
     RETURNING id, slug, title, kind, unit, enabled`,
    [userId, agentId || null, slug, title,
     kind === 'quantity' || kind === 'bool' ? kind : 'count', String(unit || '').trim()],
  );
  const r = rows[0];
  return {
    created: true,
    tracker: { id: r.id, slug: r.slug, title: r.title, kind: r.kind, unit: r.unit, enabled: r.enabled },
  };
}

// Lists the user's active trackers, with count and date of the last event.
export async function listTrackers(userId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.slug, t.title, t.kind, t.unit, t.enabled,
            (SELECT count(*) FROM ${S}.tracker_events e WHERE e.tracker_id = t.id) AS eventos,
            (SELECT max(e.event_date) FROM ${S}.tracker_events e WHERE e.tracker_id = t.id) AS ultimo
       FROM ${S}.trackers t
      WHERE t.owner_user_id = $1 AND t.enabled
      ORDER BY t.updated_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, slug: r.slug, title: r.title, kind: r.kind, unit: r.unit, enabled: r.enabled,
    eventos: Number(r.eventos),
    ultimo: r.ultimo ? String(r.ultimo).slice(0, 10) : null,
  }));
}

// Writes an event (append-only). eventDate = 'YYYY-MM-DD' (the event's date).
export async function addTrackerEvent(trackerId, userId, agentId, { eventDate, value, note, source }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.tracker_events (tracker_id, user_id, agent_id, event_date, value, note, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, to_char(event_date,'YYYY-MM-DD') AS event_date, value`,
    [trackerId, userId || null, agentId || null, eventDate,
     value == null ? 1 : Number(value), String(note || '').trim(), source || 'chat'],
  );
  await pool.query(`UPDATE ${S}.trackers SET updated_at = now() WHERE id = $1`, [trackerId]);
  return { ok: true, id: rows[0].id, eventDate: rows[0].event_date, value: Number(rows[0].value) };
}

// Aggregates a tracker's events in the [de, ate] interval (ISO, optional). The
// count ALWAYS comes from here, never from the model. `dias` = DISTINCT dates with value
// > 0 (e.g.: "how many DAYS had sugar"); `eventos` = number of rows; `soma` = total
// of the value (e.g.: spending). Returns all three, the model picks whichever makes sense.
export async function aggregateTrackerEvents(trackerId, { de, ate } = {}) {
  const vals = [trackerId]; const where = [`tracker_id = $1`];
  if (de) { vals.push(de); where.push(`event_date >= $${vals.length}`); }
  if (ate) { vals.push(ate); where.push(`event_date <= $${vals.length}`); }
  const { rows } = await pool.query(
    `SELECT count(DISTINCT event_date) FILTER (WHERE value > 0) AS dias,
            count(*) AS eventos,
            coalesce(sum(value), 0) AS soma
       FROM ${S}.tracker_events WHERE ${where.join(' AND ')}`,
    vals,
  );
  const r = rows[0] || {};
  return { dias: Number(r.dias || 0), eventos: Number(r.eventos || 0), soma: Number(r.soma || 0) };
}

// Per-day detail in the interval (for "which days" / verification). Most recent 1st.
export async function listTrackerEventsByDay(trackerId, { de, ate } = {}, limit = 60) {
  const vals = [trackerId]; const where = [`tracker_id = $1`];
  if (de) { vals.push(de); where.push(`event_date >= $${vals.length}`); }
  if (ate) { vals.push(ate); where.push(`event_date <= $${vals.length}`); }
  vals.push(Math.min(Number(limit) || 60, 200));
  const { rows } = await pool.query(
    `SELECT to_char(event_date,'YYYY-MM-DD') AS dia, count(*) AS n,
            coalesce(sum(value),0) AS soma, string_agg(nullif(note,''), '; ') AS notas
       FROM ${S}.tracker_events WHERE ${where.join(' AND ')}
      GROUP BY event_date ORDER BY event_date DESC LIMIT $${vals.length}`,
    vals,
  );
  return rows.map((r) => ({
    dia: r.dia, eventos: Number(r.n), soma: Number(r.soma), notas: r.notas || undefined,
  }));
}

// Removes events from a tracker: by specific id OR by date (all of that day).
// Append-only doesn't prevent a one-off correction; it just doesn't rewrite the rest.
export async function removeTrackerEvent(trackerId, { id, eventDate } = {}) {
  if (id) {
    const { rowCount } = await pool.query(
      `DELETE FROM ${S}.tracker_events WHERE id = $1 AND tracker_id = $2`, [id, trackerId],
    );
    return rowCount;
  }
  if (eventDate) {
    const { rowCount } = await pool.query(
      `DELETE FROM ${S}.tracker_events WHERE tracker_id = $1 AND event_date = $2`, [trackerId, eventDate],
    );
    return rowCount;
  }
  return 0;
}

// Deactivates a tracker (doesn't erase history; disappears from the list and the prompt).
export async function disableTracker(userId, trackerId) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.trackers SET enabled = false, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2`,
    [trackerId, userId],
  );
  return rowCount;
}

// ── Monitors: deterministic monitoring engine (Phase 2). A monitor =
// a named target (e.g.: "Zara Japan") with validated sources; monitor_items stores
// what's already been seen (dedup by UNIQUE). Scoped per user. See skill-monitor-compras.md.
function slugifyMonitor(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'monitor';
}

// Finds an active monitor of the user by name/slug. { ok, monitor } | { error }.
export async function resolveMonitor(userId, name) {
  const slug = slugifyMonitor(name);
  if (!String(name || '').trim()) return { error: 'nome_vazio' };
  const { rows } = await pool.query(
    `SELECT id, slug, title, target, sources, channel, baseline_done, enabled
       FROM ${S}.monitors WHERE owner_user_id = $1 AND enabled = true
        AND (slug = $2 OR lower(title) = lower($3) OR lower(target) = lower($3))
      ORDER BY (slug = $2) DESC LIMIT 5`,
    [userId, slug, String(name).trim()],
  );
  if (!rows.length) return { error: 'nao_encontrado' };
  if (rows.length > 1 && rows[0].slug !== slug) {
    return { error: 'ambiguo', options: rows.map((r) => r.title || r.slug) };
  }
  return { ok: true, monitor: rows[0] };
}

// Finds OR creates the monitor (auto-creation at setup). Idempotent by (owner, slug).
export async function resolveOrCreateMonitor(userId, name, agentId, { target, sources, channel } = {}) {
  const found = await resolveMonitor(userId, name);
  if (found.ok) return { monitor: found.monitor, created: false };
  if (found.error && found.error !== 'nao_encontrado') return found;
  const slug = slugifyMonitor(name);
  const { rows } = await pool.query(
    `INSERT INTO ${S}.monitors (owner_user_id, agent_id, slug, title, target, sources, channel)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (owner_user_id, slug) DO UPDATE SET updated_at = now()
     RETURNING id, slug, title, target, sources, channel, baseline_done, enabled`,
    [userId, agentId || null, slug, String(name).trim(), target || '',
     JSON.stringify(Array.isArray(sources) ? sources : []), channel || ''],
  );
  return { monitor: rows[0], created: true };
}

export async function listMonitors(userId) {
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.target, m.channel, m.baseline_done,
            (SELECT count(*) FROM ${S}.monitor_items i WHERE i.monitor_id = m.id) AS itens,
            (SELECT max(i.seen_at) FROM ${S}.monitor_items i WHERE i.monitor_id = m.id) AS ultimo
       FROM ${S}.monitors m
      WHERE m.owner_user_id = $1 AND m.enabled = true
      ORDER BY m.created_at`,
    [userId],
  );
  return rows;
}

// Records scraped items; returns only the ones that were NEW (the UNIQUE does the dedup).
// items: [{ key, date, title, url }]. Empty/duplicate keys are ignored.
export async function recordMonitorItems(monitorId, items) {
  const isNew = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const key = String(it?.key || it?.url || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const { rows } = await pool.query(
      `INSERT INTO ${S}.monitor_items (monitor_id, item_key, item_date, title, url)
         VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (monitor_id, item_key) DO NOTHING
       RETURNING id`,
      [monitorId, key, String(it?.date || ''), String(it?.title || ''), String(it?.url || '')],
    );
    if (rows.length) isNew.push({ key, date: it?.date || '', title: it?.title || '', url: it?.url || '' });
  }
  return isNew;
}

export async function markMonitorBaseline(monitorId) {
  await pool.query(`UPDATE ${S}.monitors SET baseline_done = true, updated_at = now() WHERE id = $1`, [monitorId]);
}

// Deactivates an entire monitor (item history stays saved).
export async function disableMonitor(userId, monitorId) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.monitors SET enabled = false, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2`,
    [monitorId, userId],
  );
  return rowCount;
}

// ── Skills: pure behavior/knowledge (SKILL.md), no data or runtime ──
// Authored by the user, installable PER ASSISTANT. Reuses resolveConnectedUser
// (Phase 2) and the Space's resolve/roster pattern. See skill-implementacao.md.

const SKILL_BODY_MAX = 8000;   // cap so it doesn't fill up the context
const SKILL_MAX_PER_AGENT = 50; // cap on skills installed per assistant
const SKILL_SCRIPT_MAX = 20000; // cap for the executable script
const SKILL_RUNTIMES = new Set(['python', 'bash']);

// Normalizes runtime + script. Returns {runtime, script} or {error}.
function normSkillScript(runtime, script) {
  const s = script == null ? null : String(script);
  const rt = String(runtime || '').trim().toLowerCase();
  if (s == null && !rt) return { runtime: undefined, script: undefined }; // nada a mexer
  const body = (s || '').trim();
  if (!body) return { runtime: '', script: '' }; // clear the script (back to text-only)
  if (!SKILL_RUNTIMES.has(rt)) return { error: 'runtime_invalido' };
  if (body.length > SKILL_SCRIPT_MAX) return { error: 'script_grande', max: SKILL_SCRIPT_MAX };
  return { runtime: rt, script: body };
}

function slugifySkill(name) {
  return String(name || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'skill';
}

// Creates an owner's skill and auto-installs it on the assistant that created it. Idempotent
// by (owner, slug): if it already exists, returns error ja_existe.
export async function createSkill(ownerUserId, { nome, quando_usar, instrucoes, visibility, script, runtime }, agentId) {
  const title = String(nome || '').trim();
  if (!title) return { error: 'nome_vazio' };
  const body = String(instrucoes || '').trim();
  if (!body) return { error: 'instrucoes_vazias' };
  if (body.length > SKILL_BODY_MAX) return { error: 'muito_grande', max: SKILL_BODY_MAX };
  const sc = normSkillScript(runtime, script);
  if (sc.error) return sc;
  const slug = slugifySkill(title);
  const existing = await pool.query(
    `SELECT id FROM ${S}.skills WHERE owner_user_id = $1 AND slug = $2`, [ownerUserId, slug],
  );
  if (existing.rows[0]) return { error: 'ja_existe', id: existing.rows[0].id, slug };
  const vis = visibility === 'connections' ? 'connections' : 'private';
  const { rows } = await pool.query(
    `INSERT INTO ${S}.skills (owner_user_id, slug, title, trigger, body, visibility, script, runtime)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ownerUserId, slug, title, String(quando_usar || '').trim(), body, vis,
     sc.script || '', sc.runtime || ''],
  );
  const id = rows[0].id;
  if (agentId) await installSkill(id, ownerUserId, agentId); // auto-instala no autor
  return { ok: true, id, slug, title };
}

export async function getSkillById(id) {
  const { rows } = await pool.query(`SELECT * FROM ${S}.skills WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Skills the user AUTHORED (regardless of installation).
export async function listSkillsAuthored(userId) {
  const { rows } = await pool.query(
    `SELECT id, slug, title, trigger, visibility, verified, install_count, updated_at
       FROM ${S}.skills WHERE owner_user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, slug: r.slug, title: r.title, trigger: r.trigger,
    visibility: r.visibility, verified: r.verified,
    installCount: Number(r.install_count), updatedAt: r.updated_at,
  }));
}

// Skills INSTALLED and enabled on this assistant, with title/trigger/owner
// (for attribution in the disclosure). isOwn = the skill's owner is this user.
export async function listInstalledSkills(agentId, userId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.slug, s.title, s.trigger, s.owner_user_id, s.verified,
            u.name AS owner_name, u.email AS owner_email,
            (s.owner_user_id = $2) AS is_own
       FROM ${S}.skill_installs i
       JOIN ${S}.skills s ON s.id = i.skill_id
       JOIN ${S}.users u ON u.id = s.owner_user_id
      WHERE i.agent_id = $1 AND i.enabled
      ORDER BY s.title`,
    [agentId, userId],
  );
  return rows.map((r) => ({
    id: r.id, slug: r.slug, title: r.title, trigger: r.trigger,
    ownerUserId: r.owner_user_id, ownerName: r.owner_name, ownerEmail: r.owner_email,
    isOwn: r.is_own, verified: r.verified,
  }));
}

// Resolves a skill by NAME/slug/id from the caller. Optional `dono`
// (connected contact) resolves a third party's skill with visibility='connections'.
// Without dono: own skill (any visibility). Mirrors resolveSpace.
export async function resolveSkill(callerUserId, query, dono) {
  const q = String(query || '').trim();
  if (!q) return { error: 'skill_vazia' };
  // id direto?
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(q)) {
    const byId = await getSkillById(q);
    if (byId) {
      if (byId.owner_user_id === callerUserId) return { ok: true, skill: byId };
      if (byId.visibility === 'connections') {
        const contacts = await listContacts(callerUserId);
        const conn = contacts.find((c) => c.personUserId === byId.owner_user_id && c.status === 'accepted');
        if (conn) return { ok: true, skill: byId, ownerName: conn.personName };
      }
      return { error: 'skill_nao_encontrada' };
    }
  }
  const slug = slugifySkill(q);
  if (dono) {
    const who = await resolveConnectedUser(callerUserId, dono);
    if (who.error) return { error: who.error, opcoes: who.opcoes };
    const { rows } = await pool.query(
      `SELECT * FROM ${S}.skills
        WHERE owner_user_id = $1 AND visibility = 'connections'
          AND (slug = $2 OR lower(title) = lower($3) OR slug LIKE $4 OR lower(title) LIKE lower($5))`,
      [who.userId, slug, q, `%${slug}%`, `%${q}%`],
    );
    if (!rows.length) return { error: 'skill_nao_encontrada' };
    if (rows.length > 1) return { error: 'ambiguo', options: rows.map((r) => ({ title: r.title, owner: who.name })) };
    return { ok: true, skill: rows[0], ownerName: who.name };
  }
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.skills
      WHERE owner_user_id = $1
        AND (slug = $2 OR lower(title) = lower($3) OR slug LIKE $4 OR lower(title) LIKE lower($5))`,
    [callerUserId, slug, q, `%${slug}%`, `%${q}%`],
  );
  if (!rows.length) return { error: 'skill_nao_encontrada' };
  if (rows.length > 1) return { error: 'ambiguo', options: rows.map((r) => ({ title: r.title, owner: 'você' })) };
  return { ok: true, skill: rows[0] };
}

// Installs (idempotent) a skill on an assistant. Increments install_count only on the
// 1st time. Respects the per-assistant cap. Reactivates if it was disabled.
export async function installSkill(skillId, userId, agentId) {
  if (!agentId) return { error: 'sem_assistente' };
  const already = await pool.query(
    `SELECT enabled FROM ${S}.skill_installs WHERE skill_id = $1 AND agent_id = $2`,
    [skillId, agentId],
  );
  if (already.rows[0]) {
    if (!already.rows[0].enabled) {
      await pool.query(
        `UPDATE ${S}.skill_installs SET enabled = true WHERE skill_id = $1 AND agent_id = $2`,
        [skillId, agentId],
      );
    }
    return { ok: true, already: true };
  }
  const cnt = await pool.query(
    `SELECT count(*) AS n FROM ${S}.skill_installs WHERE agent_id = $1 AND enabled`, [agentId],
  );
  if (Number(cnt.rows[0].n) >= SKILL_MAX_PER_AGENT) return { error: 'limite', max: SKILL_MAX_PER_AGENT };
  await pool.query(
    `INSERT INTO ${S}.skill_installs (skill_id, user_id, agent_id) VALUES ($1,$2,$3)
     ON CONFLICT (skill_id, agent_id) DO NOTHING`,
    [skillId, userId, agentId],
  );
  await pool.query(`UPDATE ${S}.skills SET install_count = install_count + 1 WHERE id = $1`, [skillId]);
  return { ok: true };
}

export async function uninstallSkill(skillId, agentId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.skill_installs WHERE skill_id = $1 AND agent_id = $2`, [skillId, agentId],
  );
  if (rowCount) await pool.query(`UPDATE ${S}.skills SET install_count = GREATEST(install_count - 1, 0) WHERE id = $1`, [skillId]);
  return rowCount;
}

// Records 1 skill USE (skill triggered: ler_skill/rodar_skill). Aggregated by
// (skill_id, user_id, dia). Fire-and-forget: error only logs, never breaks the turn.
export async function bumpSkillUse(skillId, userId) {
  if (!skillId || !userId) return;
  try {
    await pool.query(
      `INSERT INTO ${S}.skill_uses (skill_id, user_id, day, calls)
         VALUES ($1, $2, current_date, 1)
       ON CONFLICT (skill_id, user_id, day) DO UPDATE SET calls = ${S}.skill_uses.calls + 1`,
      [skillId, userId],
    );
  } catch (e) {
    console.error('[skill] bumpSkillUse failed:', e?.message ?? e);
  }
}

// The window in which a skill that was read stays "in progress" in the conversation, and how many fit at the
// same time. 24h covers a procedure that spans the day without leaving a body
// hanging forever in a thread that already changed subject; 2 is the cost cap
// (the body has an 8000 char cap, so the worst case is ~16k chars of prompt, and only
// in a thread that is actually running a skill).
const SKILL_ACTIVE_HOURS = 24;
const SKILL_ACTIVE_MAX = 2;

// Marks the skill as IN PROGRESS in this conversation (called by ler_skill). Rereading
// renews the window. Fire-and-forget: never breaks reading the skill.
export async function activateSkillInThread(threadId, skillId) {
  if (!threadId || !skillId) return;
  try {
    await pool.query(
      `INSERT INTO ${S}.skill_active (thread_id, skill_id) VALUES ($1, $2)
       ON CONFLICT (thread_id, skill_id) DO UPDATE SET activated_at = now()`,
      [threadId, skillId],
    );
  } catch (e) {
    console.error('[skill] activateSkillInThread failed:', e?.message ?? e);
  }
}

// Skills in progress in this conversation, with the body REREAD from the database (editing the skill
// mid-flow takes effect on the next turn). The JOIN with skill_installs
// ensures that uninstalling/disabling removes it from the prompt right away.
export async function listActiveSkills(threadId, agentId) {
  if (!threadId || !agentId) return [];
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.title, s.body, s.updated_at, a.activated_at
         FROM ${S}.skill_active a
         JOIN ${S}.skills s ON s.id = a.skill_id
         JOIN ${S}.skill_installs i ON i.skill_id = s.id AND i.agent_id = $2 AND i.enabled
        WHERE a.thread_id = $1
          AND a.activated_at > now() - interval '${SKILL_ACTIVE_HOURS} hours'
        ORDER BY a.activated_at DESC
        LIMIT ${SKILL_ACTIVE_MAX}`,
      [threadId, agentId],
    );
    return rows;
  } catch (e) {
    console.error('[skill] listActiveSkills failed:', e?.message ?? e);
    return [];
  }
}

// Per-skill metrics for /metrics: installs (active assistants + distinct
// users) x uses (total/7d/today + distinct users + last use). Only skills
// with at least 1 install OR 1 use. Owner resolved by name.
export async function getSkillMetrics() {
  // Skills from the admin (platform owner) show up with the brand name, not their own.
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.visibility, s.verified,
            CASE WHEN $1 <> '' AND lower(ou.email) = $1 THEN $2
                 ELSE COALESCE(ou.name, ou.email, '—') END AS owner,
            COALESCE(i.installs, 0)::bigint AS installs,
            COALESCE(i.users, 0)::bigint    AS install_users,
            COALESCE(u.total, 0)::bigint    AS uses,
            COALESCE(u.d7, 0)::bigint       AS uses_d7,
            COALESCE(u.d1, 0)::bigint       AS uses_d1,
            COALESCE(u.users, 0)::bigint    AS use_users,
            u.last_day
     FROM ${S}.skills s
     LEFT JOIN ${S}.users ou ON ou.id = s.owner_user_id
     LEFT JOIN (
       SELECT skill_id,
              count(*) FILTER (WHERE enabled)  AS installs,
              count(DISTINCT user_id)          AS users
       FROM ${S}.skill_installs GROUP BY skill_id
     ) i ON i.skill_id = s.id
     LEFT JOIN (
       SELECT skill_id,
              SUM(calls)                                          AS total,
              SUM(calls) FILTER (WHERE day >= current_date - 6)   AS d7,
              SUM(calls) FILTER (WHERE day = current_date)        AS d1,
              count(DISTINCT user_id)                             AS users,
              MAX(day)                                            AS last_day
       FROM ${S}.skill_uses GROUP BY skill_id
     ) u ON u.skill_id = s.id
     WHERE COALESCE(i.installs, 0) > 0 OR COALESCE(u.total, 0) > 0
     ORDER BY installs DESC, uses DESC, s.title`,
    [adminEmail, marca().nome],
  );
  return rows;
}

// Author-only. Updates title/trigger/body/visibility (only fields passed in).
export async function updateSkill(id, ownerUserId, patch = {}) {
  const owned = await pool.query(
    `SELECT id FROM ${S}.skills WHERE id = $1 AND owner_user_id = $2`, [id, ownerUserId],
  );
  if (!owned.rows[0]) return { error: 'nao_e_dono' };
  const sets = []; const vals = []; let i = 1;
  if (patch.title != null) {
    const t = String(patch.title).trim();
    if (!t) return { error: 'nome_vazio' };
    sets.push(`title = $${i}`); vals.push(t); i += 1;
    sets.push(`slug = $${i}`); vals.push(slugifySkill(t)); i += 1;
  }
  if (patch.trigger != null) { sets.push(`trigger = $${i}`); vals.push(String(patch.trigger).trim()); i += 1; }
  if (patch.body != null) {
    const b = String(patch.body).trim();
    if (b.length > SKILL_BODY_MAX) return { error: 'muito_grande', max: SKILL_BODY_MAX };
    sets.push(`body = $${i}`); vals.push(b); i += 1;
  }
  if (patch.visibility != null) {
    sets.push(`visibility = $${i}`); vals.push(patch.visibility === 'connections' ? 'connections' : 'private'); i += 1;
  }
  if (patch.script != null || patch.runtime != null) {
    const sc = normSkillScript(patch.runtime, patch.script);
    if (sc.error) return sc;
    if (sc.script !== undefined) { sets.push(`script = $${i}`); vals.push(sc.script); i += 1; }
    if (sc.runtime !== undefined) { sets.push(`runtime = $${i}`); vals.push(sc.runtime); i += 1; }
  }
  if (!sets.length) return { error: 'nada_pra_mudar' };
  sets.push('updated_at = now()');
  vals.push(id, ownerUserId);
  try {
    const { rowCount } = await pool.query(
      `UPDATE ${S}.skills SET ${sets.join(', ')} WHERE id = $${i} AND owner_user_id = $${i + 1}`, vals,
    );
    return rowCount ? { ok: true } : { error: 'nao_encontrada' };
  } catch (e) {
    if (String(e.code) === '23505') return { error: 'ja_existe' };
    throw e;
  }
}

// Author-only. Deletes the skill (cascade removes the installs). Error nao_e_dono.
export async function deleteSkill(id, ownerUserId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.skills WHERE id = $1 AND owner_user_id = $2`, [id, ownerUserId],
  );
  return rowCount ? { ok: true } : { error: 'nao_e_dono' };
}

// (Phase 2) Skills from a connected contact available to install.
export async function listSharableSkillsOf(connectedUserId) {
  const { rows } = await pool.query(
    `SELECT id, slug, title, trigger, install_count FROM ${S}.skills
      WHERE owner_user_id = $1 AND visibility = 'connections' ORDER BY title`,
    [connectedUserId],
  );
  return rows.map((r) => ({
    id: r.id, slug: r.slug, title: r.title, trigger: r.trigger, installCount: Number(r.install_count),
  }));
}

// (Phase 3) Verified badge — a trust/curation decision, admin ONLY.
// Not author-only on purpose: the author doesn't self-verify.
export async function setSkillVerified(id, verified) {
  const { rows } = await pool.query(
    `UPDATE ${S}.skills SET verified = $2, updated_at = now() WHERE id = $1
       RETURNING id, slug, title, verified`,
    [id, !!verified],
  );
  return rows[0] ? { ok: true, skill: rows[0] } : { error: 'skill_nao_encontrada' };
}

// ── Official skills library (visibility='public') ──────────────────
// Skills curated/verified by us, visible to EVERY user on the
// /habilidades page, installable with one tap (no connection needed). Only admin/import
// promotes a skill to 'public'; a regular user never reaches that value through their
// own tools (updateSkill clamps to 'connections'/'private').

// Lists the public library (optional search filter by title/summary/trigger).
export async function listPublicSkills({ q, viewerId } = {}) {
  const like = q ? `%${String(q).trim()}%` : null;
  const { rows } = await pool.query(
    `SELECT s.id, s.slug, s.title, s.trigger, s.summary, s.category,
            s.verified, s.install_count, (s.script IS NOT NULL) AS has_script,
            u.name AS owner_name,
            COALESCE(r.n, 0)   AS rating_count,
            r.avg              AS rating_avg,
            mine.stars         AS my_rating
       FROM ${S}.skills s
       LEFT JOIN ${S}.users u ON u.id = s.owner_user_id
       LEFT JOIN (
         SELECT skill_id, count(*) AS n, round(avg(stars)::numeric, 1) AS avg
           FROM ${S}.skill_ratings GROUP BY skill_id
       ) r ON r.skill_id = s.id
       LEFT JOIN ${S}.skill_ratings mine
              ON mine.skill_id = s.id AND mine.user_id = $2::uuid
      WHERE s.visibility = 'public'
        AND ($1::text IS NULL OR s.title ILIKE $1 OR s.summary ILIKE $1 OR s.trigger ILIKE $1)
      ORDER BY s.verified DESC, s.install_count DESC, s.title ASC`,
    [like, viewerId || null],
  );
  return rows.map((r) => ({
    id: r.id, slug: r.slug, title: r.title, trigger: r.trigger,
    summary: r.summary || '', category: r.category || 'Geral',
    verified: !!r.verified, installCount: Number(r.install_count) || 0,
    hasScript: !!r.has_script, ownerName: r.owner_name || marca().nome,
    ratingCount: Number(r.rating_count) || 0,
    ratingAvg: r.rating_avg != null ? Number(r.rating_avg) : null,
    myRating: r.my_rating != null ? Number(r.my_rating) : null,
  }));
}

// Records/updates a user's rating (1-5) on a library skill. Upsert
// by (skill_id, user_id): re-rating replaces it. Only public skills. Returns the
// updated average and total so the UI reflects it right away.
export async function rateSkill(skillId, userId, stars) {
  const n = Math.round(Number(stars));
  if (!Number.isFinite(n) || n < 1 || n > 5) return { error: 'nota_invalida' };
  const { rows: pub } = await pool.query(
    `SELECT id FROM ${S}.skills WHERE id = $1 AND visibility = 'public'`, [skillId],
  );
  if (!pub[0]) return { error: 'nao_publica' };
  await pool.query(
    `INSERT INTO ${S}.skill_ratings (skill_id, user_id, stars) VALUES ($1,$2,$3)
       ON CONFLICT (skill_id, user_id)
       DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()`,
    [skillId, userId, n],
  );
  const { rows } = await pool.query(
    `SELECT count(*) AS n, round(avg(stars)::numeric, 1) AS avg
       FROM ${S}.skill_ratings WHERE skill_id = $1`, [skillId],
  );
  return {
    ok: true,
    myRating: n,
    ratingCount: Number(rows[0]?.n) || 0,
    ratingAvg: rows[0]?.avg != null ? Number(rows[0].avg) : null,
  };
}

// Installs a skill FROM THE LIBRARY (only if it's public). Different from installSkill,
// it doesn't require ownership/connection: the skill being 'public' is already the authorization. Reuses the
// same table/limit/idempotency as installSkill.
export async function installPublicSkill(skillId, userId, agentId) {
  const { rows } = await pool.query(
    `SELECT id FROM ${S}.skills WHERE id = $1 AND visibility = 'public'`, [skillId],
  );
  if (!rows[0]) return { error: 'nao_publica' };
  return installSkill(skillId, userId, agentId);
}

// Admin/import: promotes (or updates) a skill in the official library. Sets
// category/summary and, by default, visibility='public' + verified=true. Not
// author-only on purpose (it's our own curation, just like setSkillVerified).
export async function setSkillLibrary(id, patch = {}) {
  const sets = []; const vals = []; let i = 1;
  if (patch.category != null) { sets.push(`category = $${i}`); vals.push(String(patch.category).trim()); i += 1; }
  if (patch.summary != null) { sets.push(`summary = $${i}`); vals.push(String(patch.summary).trim()); i += 1; }
  if (patch.visibility != null) { sets.push(`visibility = $${i}`); vals.push(patch.visibility === 'public' ? 'public' : (patch.visibility === 'connections' ? 'connections' : 'private')); i += 1; }
  if (patch.verified != null) { sets.push(`verified = $${i}`); vals.push(!!patch.verified); i += 1; }
  if (!sets.length) return { error: 'nada_pra_mudar' };
  sets.push('updated_at = now()');
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE ${S}.skills SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, slug, title, category, summary, visibility, verified`,
    vals,
  );
  return rows[0] ? { ok: true, skill: rows[0] } : { error: 'skill_nao_encontrada' };
}

// ── Username (= subdomain) chosen by the user ──
// Rules: 3-30 chars, lowercase/numbers/hyphen, no hyphen at the start/end.
// Some names are reserved. Uniqueness guaranteed by the UNIQUE constraint.
const RE_LABEL = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED_LABELS = new Set([
  'www', 'apex', 'api', 'admin', 'app', 'apps', 'brambs', 'mail', 'email',
  'root', 'ns', 'ns1', 'ns2', 'static', 'cdn', 'assets', 'support', 'suporte',
  'help', 'ajuda', 'blog', 'status', 'dev', 'staging', 'test', 'teste', 'ftp',
  'smtp', 'webmail', 'account', 'conta', 'billing', 'login', 'signup',
]);

export function validateLabel(desired) {
  const label = (desired || '').toString().trim().toLowerCase();
  if (!label) return { ok: false, error: 'empty' };
  if (label.length < 3 || label.length > 30) return { ok: false, error: 'length' };
  if (!RE_LABEL.test(label)) return { ok: false, error: 'invalid' };
  if (RESERVED_LABELS.has(label)) return { ok: false, error: 'reserved' };
  return { ok: true, label };
}

export async function getUserSubdomain(userId) {
  const { rows } = await pool.query(
    `SELECT subdomain FROM ${S}.users WHERE id = $1`, [userId]);
  return rows[0]?.subdomain || null;
}

// Availability: valid format, not reserved and not used by ANOTHER user.
export async function isSubdomainAvailable(desired, exceptUserId = null) {
  const v = validateLabel(desired);
  if (!v.ok) return { available: false, error: v.error };
  const { rows } = await pool.query(
    `SELECT id FROM ${S}.users WHERE subdomain = $1`, [v.label]);
  if (rows.length && rows[0].id !== exceptUserId) return { available: false, error: 'taken' };
  return { available: true, label: v.label };
}

// Changes the user's username. Blocks it if they already have published systems
// (routing is by label; renaming would orphan the containers) — in that case
// returns {ok:false,error:'has_apps'} so the UI can guide deleting/republishing first.
export async function setUserSubdomain(userId, desired) {
  const v = validateLabel(desired);
  if (!v.ok) return v;
  const apps = await listAppsForUser(userId);
  if (apps.length) return { ok: false, error: 'has_apps' };
  try {
    const { rows } = await pool.query(
      `UPDATE ${S}.users SET subdomain = $2 WHERE id = $1 RETURNING subdomain, name`,
      [userId, v.label],
    );
    if (!rows.length) return { ok: false, error: 'not_found' };
    return { ok: true, subdomain: rows[0].subdomain, name: rows[0].name };
  } catch (e) {
    if (/unique|duplicate/i.test(String(e.message))) return { ok: false, error: 'taken' };
    throw e;
  }
}

// ── Canal e-mail: dedup por Message-ID ──
export async function emailSeen(messageId) {
  if (!messageId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM ${S}.email_seen WHERE message_id = $1`, [messageId],
  );
  return rows.length > 0;
}
export async function markEmailSeen(messageId, userId = null) {
  if (!messageId) return;
  await pool.query(
    `INSERT INTO ${S}.email_seen (message_id, user_id) VALUES ($1, $2)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, userId],
  );
}

// ── Email channel: persistent queue (see the CREATE TABLE comment) ──
export async function enqueueEmail(source) {
  await pool.query(`INSERT INTO ${S}.email_queue (source) VALUES ($1)`, [source]);
}

// Claims up to `limit` pending emails to process. The claim ALREADY increments
// attempts: if the process crashes midway, the crash counts as an attempt.
export async function claimPendingEmails(limit = 10, maxAttempts = 3) {
  // Re-arms orphaned claims (process crashed with the row in 'working')...
  await pool.query(
    `UPDATE ${S}.email_queue SET status = 'pending', updated_at = now()
      WHERE status = 'working' AND updated_at < now() - interval '15 minutes'`,
  );
  // ...and buries whatever ran out of attempts (stays auditable in 'failed').
  await pool.query(
    `UPDATE ${S}.email_queue SET status = 'failed', updated_at = now()
      WHERE status = 'pending' AND attempts >= $1`,
    [maxAttempts],
  );
  const { rows } = await pool.query(
    `UPDATE ${S}.email_queue SET status = 'working', attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM ${S}.email_queue
                    WHERE status = 'pending' AND attempts < $2
                    ORDER BY created_at LIMIT $1
                    FOR UPDATE SKIP LOCKED)
      RETURNING id, source, attempts`,
    [limit, maxAttempts],
  );
  return rows;
}

// Fecha a linha: 'done' | 'skipped' | 'failed' | 'pending' (= tentar de novo).
export async function settleEmail(id, status, error = null) {
  await pool.query(
    `UPDATE ${S}.email_queue SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
    [id, status, error],
  );
}

// Returns the attempt (case 'defer': rate-limit isn't a failure, doesn't spend an attempt).
export async function unclaimEmail(id) {
  await pool.query(
    `UPDATE ${S}.email_queue SET status = 'pending', attempts = greatest(attempts - 1, 0),
       updated_at = now() WHERE id = $1`,
    [id],
  );
}

// ── Media library ──
// All functions are scoped by user_id (isolation between users).
export async function addMediaAsset({ userId, agentId = null, s3Key, kind = null, mime = null, source = null, caption = '' }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.media_assets (user_id, agent_id, s3_key, kind, mime, source, caption)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, s3_key, created_at`,
    [userId, agentId, s3Key, kind, mime, source, caption || ''],
  );
  return rows[0];
}
export async function listMediaAssets(userId, { limit = 40 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, agent_id, s3_key, kind, mime, source, caption, created_at
     FROM ${S}.media_assets WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(1, limit), 200)],
  );
  return rows;
}
// media_assets.id is a UUID. When the id comes from the MODEL (it read it from listar_midia or
// from a 🖼️ [foto id=...] marker), it may come truncated or made up; without this
// guard, Postgres drops the query with "invalid input syntax for type uuid" and the
// tool blows up instead of answering "couldn't find that file".
const idDeMidiaValido = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v ?? ''));
export async function getMediaAsset(userId, id) {
  if (!idDeMidiaValido(id)) return null;
  const { rows } = await pool.query(
    `SELECT id, agent_id, s3_key, kind, mime, source, caption, created_at
     FROM ${S}.media_assets WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  return rows[0] || null;
}
// ── File deletion tombstone (see CREATE TABLE media_deletions) ──
// Records the key that needs to disappear from the bucket. Only used INSIDE the transaction that
// removes the reference, so there's never a moment when nobody knows about the
// object anymore. `client` is the client of the ongoing transaction.
async function enfileiraExclusaoDeMidia(client, { userId = null, s3Key, origem = null }) {
  if (!s3Key) return null;
  const { rows } = await client.query(
    `INSERT INTO ${S}.media_deletions (user_id, s3_key, origem) VALUES ($1, $2, $3) RETURNING id`,
    [userId, s3Key, origem],
  );
  return rows[0].id;
}
// Gets pending tombstones to retry. Increments attempts on claim (a crash
// midway counts as an attempt) and only offers the same row again after 10
// min, so a network failure doesn't turn into a tight loop. Whatever runs out of attempts becomes
// 'failed' and STAYS in the table: the key remains recorded for someone to delete by hand.
export async function claimPendingMediaDeletions(limit = 50, maxAttempts = 12) {
  await pool.query(
    `UPDATE ${S}.media_deletions SET status = 'failed', updated_at = now()
      WHERE status = 'pending' AND attempts >= $1`,
    [maxAttempts],
  );
  const { rows } = await pool.query(
    `UPDATE ${S}.media_deletions SET attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM ${S}.media_deletions
                    WHERE status = 'pending' AND attempts < $2
                      AND (attempts = 0 OR updated_at < now() - interval '10 minutes')
                    ORDER BY created_at LIMIT $1
                    FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, s3_key, attempts`,
    [Math.min(Math.max(1, limit), 500), maxAttempts],
  );
  return rows;
}
// Closes the tombstone. 'done' = the object disappeared from the bucket (or never existed).
export async function settleMediaDeletion(id, status = 'done', error = null) {
  if (!id) return;
  await pool.query(
    `UPDATE ${S}.media_deletions SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
    [id, status, error ? String(error).slice(0, 500) : null],
  );
}
// Records a tombstone for a LIST of keys at once, outside a transaction. This is the case for
// account destruction: there's no transaction there that removes the reference (the account's
// DELETE takes the rows along via CASCADE), so the tombstone needs to be recorded
// BEFORE, otherwise a bucket failure would leave the file orphaned and unrecorded.
export async function registrarLapidesDeExclusao(userId, keys, origem = 'purge_conta') {
  const lista = [...new Set((keys || []).filter(Boolean))];
  if (!lista.length) return [];
  const { rows } = await pool.query(
    `INSERT INTO ${S}.media_deletions (user_id, s3_key, origem)
       SELECT $1, k, $3 FROM unnest($2::text[]) AS k
       RETURNING id, s3_key`,
    [userId, lista, origem],
  );
  return rows;
}
// How many tombstones haven't confirmed the delete in the bucket yet (pending + exhausted).
export async function countPendingMediaDeletions() {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM ${S}.media_deletions
      WHERE status <> 'done' GROUP BY status`,
  );
  return rows;
}
// Removes a media item from the library (scoped by owner). The row is only deleted TOGETHER
// with the tombstone's creation, in the same transaction: either both things happen, or
// neither. Returns { s3Key, tombstoneId } for the caller to delete the object and
// close the tombstone; null when nothing matched (file doesn't exist or belongs to another owner).
export async function deleteMediaAsset(userId, id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM ${S}.media_assets WHERE user_id = $1 AND id = $2 RETURNING s3_key`,
      [userId, id],
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    const s3Key = rows[0].s3_key;
    const tombstoneId = await enfileiraExclusaoDeMidia(client, { userId, s3Key, origem: 'media_assets' });
    await client.query('COMMIT');
    return { s3Key, tombstoneId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}
export async function setMediaCaption(userId, id, caption) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.media_assets SET caption = $3 WHERE user_id = $1 AND id = $2`,
    [userId, id, String(caption || '').slice(0, 2000)],
  );
  return rowCount > 0;
}

// ── Verified identity (people video generation) ──
// One identity per user. See table user_likeness. Only the user themself
// (via user_id) and the admin (review) touch this.
export async function getLikeness(userId) {
  const { rows } = await pool.query(
    `SELECT user_id, status, anchor_key, anchor_mime, verified_by, verified_at,
            rejected_reason, document_key, term_signed_at, voice_key, voice_mime,
            voice_updated_at, speech_key, speech_mime, speech_updated_at,
            face2_key, face2_mime, face3_key, face3_mime,
            created_at, updated_at
       FROM ${S}.user_likeness WHERE user_id = $1`,
    [userId],
  );
  return rows[0] || null;
}
// Saves/updates the anchor photo and RESETS to pending (every anchor change requires
// new human verification). Idempotent by user_id.
export async function setLikenessAnchor({ userId, anchorKey, anchorMime = null }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.user_likeness (user_id, status, anchor_key, anchor_mime, updated_at)
       VALUES ($1, 'pending', $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET anchor_key = EXCLUDED.anchor_key,
           anchor_mime = EXCLUDED.anchor_mime,
           status = 'pending',
           verified_by = NULL, verified_at = NULL, rejected_reason = NULL,
           updated_at = now()
     RETURNING user_id, status, anchor_key, anchor_mime`,
    [userId, anchorKey, anchorMime],
  );
  return rows[0];
}
// Changes the status (admin review). status ∈ verified|rejected|pending.
export async function setLikenessStatus({ userId, status, verifiedBy = null, rejectedReason = null }) {
  const verified = status === 'verified';
  const { rowCount } = await pool.query(
    `UPDATE ${S}.user_likeness
        SET status = $2,
            verified_by = $3,
            verified_at = CASE WHEN $4 THEN now() ELSE NULL END,
            rejected_reason = $5,
            updated_at = now()
      WHERE user_id = $1`,
    [userId, status, verifiedBy, verified, rejectedReason],
  );
  return rowCount > 0;
}
// Saves/updates (or clears, with voiceKey=null) the person's reference voice.
// UPSERT by user_id without touching the identity's status/anchor. If there isn't yet an
// identity row, creates one (status pending, no anchor) just to store the voice.
export async function setLikenessVoice({ userId, voiceKey = null, voiceMime = null }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.user_likeness (user_id, status, voice_key, voice_mime, voice_updated_at, updated_at)
       VALUES ($1, 'pending', $2, $3, now(), now())
     ON CONFLICT (user_id) DO UPDATE
       SET voice_key = EXCLUDED.voice_key,
           voice_mime = EXCLUDED.voice_mime,
           voice_updated_at = now(),
           updated_at = now()
     RETURNING user_id, voice_key, voice_mime`,
    [userId, voiceKey, voiceMime],
  );
  return rows[0];
}
// Saves/updates (or clears, with speechKey=null) the LITERAL audio to speak. Same
// pattern as setLikenessVoice: UPSERT by user_id without touching status/anchor.
export async function setLikenessSpeech({ userId, speechKey = null, speechMime = null }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.user_likeness (user_id, status, speech_key, speech_mime, speech_updated_at, updated_at)
       VALUES ($1, 'pending', $2, $3, now(), now())
     ON CONFLICT (user_id) DO UPDATE
       SET speech_key = EXCLUDED.speech_key,
           speech_mime = EXCLUDED.speech_mime,
           speech_updated_at = now(),
           updated_at = now()
     RETURNING user_id, speech_key, speech_mime`,
    [userId, speechKey, speechMime],
  );
  return rows[0];
}
// Saves/updates (or clears, with key=null) an EXTRA face photo. slot ∈ 2|3.
// Same person as the anchor, different angle; improves face reconstruction in the
// render. UPSERT by user_id without touching the identity's status/anchor.
// Swaps/clears the photo and, if there was a photo BEFORE, leaves a tombstone for the old key in the
// same transaction. Applies to both cases: removing (faceKey=null) and replacing with
// another one (the old one also needs to disappear from the bucket). Returns { ..., previousKey,
// tombstoneId } for the server to delete the object and close the tombstone.
export async function setLikenessExtraFace({ userId, slot, faceKey = null, faceMime = null }) {
  const n = Number(slot);
  if (n !== 2 && n !== 3) throw new Error('slot de face inválido (use 2 ou 3)');
  const kc = `face${n}_key`, mc = `face${n}_mime`, uc = `face${n}_updated_at`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Reads the current key BEFORE overwriting, locking the row (FOR UPDATE) so that
    // a concurrent upload to the same slot doesn't swap the photo between the read and the
    // write, which would make the tombstone point to the wrong key.
    const antes = await client.query(
      `SELECT ${kc} AS face_key FROM ${S}.user_likeness WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const anterior = antes.rows[0]?.face_key || null;
    const { rows } = await client.query(
      `INSERT INTO ${S}.user_likeness (user_id, status, ${kc}, ${mc}, ${uc}, updated_at)
         VALUES ($1, 'pending', $2, $3, now(), now())
       ON CONFLICT (user_id) DO UPDATE
         SET ${kc} = EXCLUDED.${kc},
             ${mc} = EXCLUDED.${mc},
             ${uc} = now(),
             updated_at = now()
       RETURNING user_id, ${kc} AS face_key, ${mc} AS face_mime`,
      [userId, faceKey, faceMime],
    );
    const row = rows[0];
    const previousKey = anterior && anterior !== faceKey ? anterior : null;
    const tombstoneId = await enfileiraExclusaoDeMidia(client, { userId, s3Key: previousKey, origem: `likeness_face${n}` });
    await client.query('COMMIT');
    return { ...row, previousKey, tombstoneId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}
// Admin review queue: identities awaiting human verification.
export async function listPendingLikeness({ limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT l.user_id, l.status, l.anchor_key, l.anchor_mime, l.created_at, l.updated_at,
            u.name, u.email
       FROM ${S}.user_likeness l JOIN ${S}.users u ON u.id = l.user_id
      WHERE l.status = 'pending'
      ORDER BY l.updated_at ASC
      LIMIT $1`,
    [Math.min(Math.max(1, limit), 500)],
  );
  return rows;
}

// ── People video generation jobs ──
// See table video_jobs. The agent creates the job (createVideoJob) and immediately replies
// "generating now"; the scheduler's poller advances the status and, when done, downloads+delivers.
export async function createVideoJob({ userId, agentId = null, remoteJobId = null, prompt = '', withAudio = false, durationReq = null, originChannel = null, threadId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.video_jobs
       (user_id, agent_id, remote_job_id, status, prompt, with_audio, duration_req, origin_channel, thread_id)
       VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)
     RETURNING id, user_id, agent_id, remote_job_id, status, created_at`,
    [userId, agentId, remoteJobId, String(prompt || '').slice(0, 4000), !!withAudio, durationReq, originChannel, threadId],
  );
  return rows[0];
}
// Updates a job's fields. Only overwrites what comes in defined (COALESCE).
export async function updateVideoJob(id, { status = null, remoteJobId = null, videoSeconds = null, videoKey = null, creditsCharged = null, error = null } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.video_jobs
        SET status = COALESCE($2, status),
            remote_job_id = COALESCE($3, remote_job_id),
            video_seconds = COALESCE($4, video_seconds),
            video_key = COALESCE($5, video_key),
            credits_charged = COALESCE($6, credits_charged),
            error = COALESCE($7, error),
            updated_at = now()
      WHERE id = $1 AND (status IN ('queued','processing') OR $2::text IS NULL)`,
    [id, status, remoteJobId, videoSeconds, videoKey, creditsCharged, error],
  );
  return rowCount > 0;
}
export async function getVideoJob(id) {
  const { rows } = await pool.query(`SELECT * FROM ${S}.video_jobs WHERE id = $1`, [id]);
  return rows[0] || null;
}
// Jobs the poller needs to advance (still in the worker), oldest first.
export async function listActiveVideoJobs({ limit = 25 } = {}) {
  const { rows } = await pool.query(
    `SELECT v.*, u.name AS user_name, u.email
       FROM ${S}.video_jobs v JOIN ${S}.users u ON u.id = v.user_id
      WHERE v.status IN ('queued','processing')
      ORDER BY v.created_at ASC
      LIMIT $1`,
    [Math.min(Math.max(1, limit), 200)],
  );
  return rows;
}
// How many jobs the user has in progress (anti-abuse limit: 1 at a time).
export async function countActiveVideoJobsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ${S}.video_jobs
      WHERE user_id = $1 AND status IN ('queued','processing')`,
    [userId],
  );
  return rows[0]?.n || 0;
}

// ── Home screen items: "Need to know" (kind='note') and "Suggestions"
// (kind='suggestion'). Populated by onboarding (reads emails/calendar) and kept up
// by the agent throughout conversations (tool `lembrar`). The user can delete them.
export async function listHomeItems(userId, kind = null) {
  const { rows } = kind
    ? await pool.query(
        `SELECT id, agent_id, kind, text, created_at FROM ${S}.home_items
         WHERE user_id = $1 AND kind = $2 ORDER BY created_at DESC`, [userId, kind])
    : await pool.query(
        `SELECT id, agent_id, kind, text, created_at FROM ${S}.home_items
         WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return rows;
}
export async function addHomeItem({ userId, agentId = null, kind, text }) {
  const t = String(text || '').trim();
  if (!t) return null;
  // dedupe: doesn't repeat an identical item (same user+type).
  const dup = await pool.query(
    `SELECT 1 FROM ${S}.home_items WHERE user_id = $1 AND kind = $2 AND lower(text) = lower($3)`,
    [userId, kind, t]);
  if (dup.rows.length) return null;
  const { rows } = await pool.query(
    `INSERT INTO ${S}.home_items (user_id, agent_id, kind, text) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, agentId, kind, t]);
  return rows[0].id;
}
// Trigger for automatic refresh of the home boxes. Stores when the
// last refresh was (cooldown) and a cheap "mark" of the inbox's
// state (id of the most recent email) to detect new content without running the
// model. mark null = never refreshed (first population).
export async function getHomeRefresh(userId) {
  const { rows } = await pool.query(
    `SELECT home_refresh_at, home_seen_mark FROM ${S}.users WHERE id = $1`, [userId]);
  return { at: rows[0]?.home_refresh_at || null, mark: rows[0]?.home_seen_mark || null };
}
export async function setHomeRefresh(userId, mark) {
  await pool.query(
    `UPDATE ${S}.users SET home_refresh_at = now(), home_seen_mark = $2 WHERE id = $1`,
    [userId, mark || null]);
}
export async function deleteHomeItem(userId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.home_items WHERE user_id = $1 AND id = $2`, [userId, id]);
  return rowCount > 0;
}
export async function clearHomeItems(userId, kind, agentId = null) {
  if (agentId) {
    await pool.query(
      `DELETE FROM ${S}.home_items WHERE user_id = $1 AND kind = $2 AND agent_id = $3`,
      [userId, kind, agentId]);
  } else {
    await pool.query(`DELETE FROM ${S}.home_items WHERE user_id = $1 AND kind = $2`, [userId, kind]);
  }
}

// ── Referral invites ──
// Status of a user's invites: how many they can give (total), how many have already
// been used (count of referred people) and how many remain.
export async function getInviteStatus(userId) {
  const { rows } = await pool.query(
    `SELECT u.invites_total AS total,
            (SELECT count(*)::int FROM ${S}.users c WHERE c.referred_by = u.id) AS used
       FROM ${S}.users u WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return { total: 0, used: 0, remaining: 0 };
  const total = Number(r.total) || 0, used = Number(r.used) || 0;
  return { total, used, remaining: Math.max(0, total - used) };
}

// The user's own invite code + status, for the assistant to answer when the
// person asks "what's my code to invite someone". If the person HAS invites
// but doesn't have a code yet (born after the initial backfill and got invites
// later), mints a unique 4-digit code on the spot (idempotent: only mints if it's
// missing). Read-mostly: no invites and no code, returns code=null without minting.
export async function getOrMintReferral(userId) {
  const st = await getInviteStatus(userId);
  const { rows } = await pool.query(
    `SELECT referral_code AS code FROM ${S}.users WHERE id = $1`, [userId],
  );
  let code = rows[0]?.code || null;
  if (!code && st.total > 0) {
    for (let i = 0; i < 8 && !code; i++) {
      const cand = String(1000 + Math.floor(Math.random() * 9000));
      const r = await pool.query(
        `UPDATE ${S}.users SET referral_code = $2
          WHERE id = $1 AND referral_code IS NULL
            AND NOT EXISTS (SELECT 1 FROM ${S}.users WHERE referral_code = $2)
          RETURNING referral_code AS code`,
        [userId, cand],
      );
      if (r.rows[0]) code = r.rows[0].code;
      else {
        const cur = await pool.query(`SELECT referral_code AS code FROM ${S}.users WHERE id = $1`, [userId]);
        if (cur.rows[0]?.code) code = cur.rows[0].code; // race: another process already minted it
      }
    }
  }
  return { code: code || null, ...st };
}

// Creates a user CONSUMING an invite from the referrer, resolved by the 4-digit
// CODE. Atomic consumption: the INSERT only happens if the code exists AND the owner
// still has an invite (count of referred people < invites_total). Returns the created
// user, or null (then the caller sends it to the queue). The account is born like any
// other; whatever the installer gives to a new account comes through the conta_criada event.
export async function createReferredUserByCode({ name, email, passwordHash, code }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.users (name, email, password_hash, referred_by)
     SELECT $1, $2, $3, r.id
       FROM ${S}.users r
      WHERE r.referral_code = $4
        AND (SELECT count(*) FROM ${S}.users c WHERE c.referred_by = r.id) < r.invites_total
     RETURNING id, name, email, referred_by`,
    [name, String(email).toLowerCase(), passwordHash, String(code)],
  );
  const u = rows[0];
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, referredBy: u.referred_by };
}

// TURNS ON the NEW referral model (v2) for a user, on demand (run by an
// operator). Sets the v2 flag, ensures 100 uses (invites_total) and mints a
// unique 4-digit code if missing. Idempotent. Returns the code and state, or
// null if the e-mail doesn't exist. Does NOT touch anyone's legacy code.
export async function activateReferralV2(email, { uses = 100 } = {}) {
  const e = String(email).toLowerCase();
  const upd = await pool.query(
    `UPDATE ${S}.users
        SET referral_v2 = true,
            invites_total = GREATEST(invites_total, $2)
      WHERE lower(email) = $1
      RETURNING id, name, email, referral_code AS code, invites_total`,
    [e, uses],
  );
  const u = upd.rows[0];
  if (!u) return null;
  let code = u.code || null;
  for (let i = 0; i < 8 && !code; i++) {
    const cand = String(1000 + Math.floor(Math.random() * 9000));
    const r = await pool.query(
      `UPDATE ${S}.users SET referral_code = $2
        WHERE id = $1 AND referral_code IS NULL
          AND NOT EXISTS (SELECT 1 FROM ${S}.users WHERE referral_code = $2)
        RETURNING referral_code AS code`,
      [u.id, cand],
    );
    if (r.rows[0]) code = r.rows[0].code;
    else {
      const cur = await pool.query(`SELECT referral_code AS code FROM ${S}.users WHERE id = $1`, [u.id]);
      if (cur.rows[0]?.code) code = cur.rows[0].code;
    }
  }
  return { id: u.id, name: u.name, email: u.email, code: code || null, invites_total: u.invites_total, v2: true };
}

// Releases the referral bonus, once, when the REFERRED user subscribes.
// Overhaul of 28/08: the trigger stopped being credit usage and became an
// actual subscription; BOTH sides earn 500 (referrer and referred).
// Idempotent: the conditional UPDATE on ref_bonus_done locks the grant to a
// single call, so a webhook redelivery doesn't pay twice, nor does
// resubscribing after cancelling. Returns { referrerId, referredId } if it's
// time to credit, or null. The credit itself (insertUsageEvent model
// 'referral') is done by the caller.
export async function claimReferralBonus(referredUserId) {
  const { rows } = await pool.query(
    `UPDATE ${S}.users c
        SET ref_bonus_done = true
       FROM ${S}.users r
      WHERE c.id = $1
        AND c.referred_by = r.id
        AND c.ref_bonus_done = false
      RETURNING r.id AS referrer_id, c.id AS referred_id`,
    [referredUserId],
  );
  return rows[0] ? { referrerId: rows[0].referrer_id, referredId: rows[0].referred_id } : null;
}

// Releases the SIGN-UP bonus (2026-09-08), once, when the REFERRED user sends the
// first message to their assistant. The trigger is first use, not the moment
// of sign-up, because 200 credits per created account would invite someone to
// open 10 fake accounts and reward themselves; having to talk to the
// assistant stops that without hurting real people ("only when they send the
// first message").
//
// Only the referrer earns here. The referred user already starts with Básico
// free for one cycle, and the 500 for both sides stays tied to subscribing
// (claimReferralBonus). Idempotent by the same mechanism: the conditional
// UPDATE on ref_signup_bonus_done passes only once, so it can be called on
// every first thread turn without paying again. Returns { referrerId,
// referredId } if it's time to credit, or null. The caller does the credit.
export async function claimReferralSignupBonus(referredUserId) {
  const { rows } = await pool.query(
    `UPDATE ${S}.users c
        SET ref_signup_bonus_done = true
       FROM ${S}.users r
      WHERE c.id = $1
        AND c.referred_by = r.id
        AND c.ref_signup_bonus_done = false
      RETURNING r.id AS referrer_id, c.id AS referred_id`,
    [referredUserId],
  );
  return rows[0] ? { referrerId: rows[0].referrer_id, referredId: rows[0].referred_id } : null;
}

// How many accounts exist. It decides whether the waitlist is on: sign-up
// stays open until the database hits the beta cap (28/08).
export async function countUsers() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${S}.users`);
  return Number(rows[0]?.n) || 0;
}

// Does any user exist with this code? (to classify the reason for the queue.)
export async function referralCodeExists(code) {
  const { rows } = await pool.query(
    `SELECT 1 FROM ${S}.users WHERE referral_code = $1 LIMIT 1`, [String(code)],
  );
  return rows.length > 0;
}

// ── OAuth tokens for external connectors (GitHub, Slack, ...) ──
export async function saveOAuthToken(userId, provider, { access_token, refresh_token = null, scope = '', expiry = null, meta = null }, { refresh = false } = {}) {
  await pool.query(
    `INSERT INTO ${S}.oauth_tokens (user_id, provider, access_token, refresh_token, scope, expiry, meta, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, ${S}.oauth_tokens.refresh_token),
       scope = EXCLUDED.scope, expiry = EXCLUDED.expiry,
       meta = COALESCE(EXCLUDED.meta, ${S}.oauth_tokens.meta), updated_at = now(),
       confirmation_version = CASE WHEN $8 THEN ${S}.oauth_tokens.confirmation_version ELSE EXCLUDED.confirmation_version END`,
    [userId, provider, encMaybe(access_token), encMaybe(refresh_token), scope, expiry, meta ? JSON.stringify(meta) : null, refresh],
  );
}

export async function getOAuthToken(userId, provider) {
  const { rows } = await pool.query(`SELECT * FROM ${S}.oauth_tokens WHERE user_id = $1 AND provider = $2`, [userId, provider]);
  const row = rows[0];
  if (!row) return null;
  row.access_token = decMaybe(row.access_token);
  row.refresh_token = decMaybe(row.refresh_token);
  return row;
}

export async function listOAuthProviders(userId) {
  const { rows } = await pool.query(`SELECT provider FROM ${S}.oauth_tokens WHERE user_id = $1 AND access_token IS NOT NULL`, [userId]);
  return rows.map((r) => r.provider);
}

export async function deleteOAuthToken(userId, provider) {
  await pool.query(`DELETE FROM ${S}.oauth_tokens WHERE user_id = $1 AND provider = $2`, [userId, provider]);
}

// LGPD: when a store uninstalls the app / requests deletion (Nuvemshop's
// store/redact webhook), we delete its token by the store_id stored in the meta. Returns how many
// tokens were removed.
export async function deleteOAuthTokenByStoreId(provider, storeId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.oauth_tokens WHERE provider = $1 AND meta->>'store_id' = $2`,
    [provider, String(storeId)],
  );
  return rowCount;
}

// ── Credential vault (secret_enc = AES-256-GCM encrypted secret; NEVER leaves here in plaintext) ──
export async function addConnection(userId, { provider, kind = 'apikey', label = '', secretEnc, meta = {} }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.connections (user_id, provider, kind, label, secret_enc, meta)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, provider, kind, label, meta, created_at`,
    [userId, clean(provider), clean(kind), clean(label), secretEnc, cleanDeep(meta)],
  );
  return rows[0] || null;
}

// Lists WITHOUT the secret (metadata only) — this is what the UI/API exposes.
export async function listConnections(userId) {
  const { rows } = await pool.query(
    `SELECT id, provider, kind, label, meta, created_at, updated_at
     FROM ${S}.connections WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

// No credentials are selected or persisted in an approval's access snapshot.
// Reconnecting an OAuth account invalidates old approvals; routine token refresh
// preserves its generation. Vault rotations use their existing update timestamp.
export async function getConfirmationAuthorizationContext(userId) {
  const { rows } = await pool.query(`SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('provider',o.provider,'version',o.confirmation_version,'scope',o.scope) ORDER BY o.provider)
      FROM ${S}.oauth_tokens o WHERE o.user_id=$1 AND o.access_token IS NOT NULL),'[]'::jsonb) AS oauth,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'provider',c.provider,'updated',c.updated_at) ORDER BY c.id)
      FROM ${S}.connections c WHERE c.user_id=$1),'[]'::jsonb) AS vault`, [userId]);
  return rows[0];
}

// Brings the encrypted secret (secret_enc) — use only at the moment of the tool call, scoped by user_id.
export async function getConnection(userId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.connections WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  return rows[0] || null;
}

// Brings it by provider (useful for tools that look up the credential by service).
export async function getConnectionByProvider(userId, provider, label = null) {
  const vals = [userId, clean(provider)];
  let q = `SELECT * FROM ${S}.connections WHERE user_id = $1 AND provider = $2`;
  if (label) { vals.push(clean(label)); q += ` AND label = $3`; }
  q += ` ORDER BY created_at DESC LIMIT 1`;
  const { rows } = await pool.query(q, vals);
  return rows[0] || null;
}

export async function deleteConnection(userId, id) {
  await pool.query(`DELETE FROM ${S}.connections WHERE user_id = $1 AND id = $2`, [userId, id]);
}

// Swaps the encrypted secret of an existing connection (e.g.: the user sent a new API
// key after the old one expired/became invalid). Scoped by user_id.
export async function updateConnectionSecret(userId, id, secretEnc, { label = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE ${S}.connections SET secret_enc = $3, updated_at = now()${label != null ? ', label = $4' : ''}
     WHERE user_id = $1 AND id = $2 RETURNING id, provider, kind, label`,
    label != null ? [userId, id, secretEnc, clean(label)] : [userId, id, secretEnc],
  );
  return rows[0] || null;
}

// Saves the webhook event. Returns false if it had already been processed (dedup
// by PK), which is how we implement idempotency for Asaas's "at least once".
export async function recordAsaasEvent(eventId, { accountId = '', event = '', payload = {} } = {}) {
  const { rowCount } = await pool.query(
    `INSERT INTO ${S}.asaas_events (event_id, account_id, event, payload)
     VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING`,
    [clean(eventId), clean(accountId), clean(event), cleanDeep(payload)],
  );
  return rowCount > 0;
}

// Saves the operation right after Asaas returns its id. The
// "delivered" state is only used when the confirmed response itself already brought the link,
// because in that case renderConfirmed delivers it in the same turn and the webhook shouldn't
// send the same thing again.
export async function saveAsaasOperation(userId, {
  agentId = null, threadId = null, accountId = '', id, tipo, status = '', valor = null,
  comprovante = null, comprovanteEntregue = false, modoExecucao = null, originChannel = 'web',
  agendadaParaSolicitada = null, agendadaParaProvedor = null, vencimento = null,
} = {}) {
  const kind = tipo === 'boleto' ? 'boleto' : 'pix';
  const operationId = clean(id);
  if (!operationId) return null;
  const dateOrNull = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
  const executionMode = ['immediate', 'scheduled'].includes(modoExecucao) ? modoExecucao : null;
  const origin = ['web', 'telegram', 'whatsapp', 'email'].includes(originChannel) ? originChannel : 'web';
  const { rows } = await pool.query(
    `INSERT INTO ${S}.asaas_operations
       (provider_operation_id, owner_user_id, agent_id, thread_id, account_id,
        kind, status, value, receipt_url, receipt_notification_state, origin_channel,
        execution_mode, requested_schedule_date, provider_schedule_date, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (provider_operation_id) DO UPDATE SET
       agent_id=COALESCE(${S}.asaas_operations.agent_id,EXCLUDED.agent_id),
       thread_id=COALESCE(${S}.asaas_operations.thread_id,EXCLUDED.thread_id),
       account_id=COALESCE(NULLIF(${S}.asaas_operations.account_id,''),EXCLUDED.account_id),
       origin_channel=COALESCE(${S}.asaas_operations.origin_channel,EXCLUDED.origin_channel),
       status=CASE
         WHEN upper(${S}.asaas_operations.status) IN ('DONE','PAID','FAILED','CANCELLED','REFUNDED')
          AND upper(EXCLUDED.status) NOT IN ('DONE','PAID','FAILED','CANCELLED','REFUNDED')
         THEN ${S}.asaas_operations.status
         ELSE EXCLUDED.status
       END,
       value=COALESCE(EXCLUDED.value,${S}.asaas_operations.value),
       receipt_url=COALESCE(EXCLUDED.receipt_url,${S}.asaas_operations.receipt_url),
       execution_mode=COALESCE(EXCLUDED.execution_mode,${S}.asaas_operations.execution_mode),
       requested_schedule_date=COALESCE(EXCLUDED.requested_schedule_date,${S}.asaas_operations.requested_schedule_date),
       provider_schedule_date=COALESCE(EXCLUDED.provider_schedule_date,${S}.asaas_operations.provider_schedule_date),
       due_date=COALESCE(EXCLUDED.due_date,${S}.asaas_operations.due_date),
       receipt_notification_state=CASE WHEN EXCLUDED.receipt_notification_state='delivered' THEN 'delivered' ELSE ${S}.asaas_operations.receipt_notification_state END,
       updated_at=now()
     WHERE ${S}.asaas_operations.owner_user_id=EXCLUDED.owner_user_id
     RETURNING *`,
    [operationId, userId, agentId, threadId, clean(accountId), kind, clean(status),
      Number.isFinite(Number(valor)) ? Number(valor) : null, comprovante ? clean(comprovante) : null,
      comprovanteEntregue ? 'delivered' : 'pending', origin, executionMode,
      dateOrNull(agendadaParaSolicitada), dateOrNull(agendadaParaProvedor), dateOrNull(vencimento)],
  );
  return rows[0] || null;
}

// One-off query used by the turn that just created an operation. The
// link with owner_user_id prevents a known id from another account from being
// observed. Doesn't do polling on its own and doesn't change state.
export async function getAsaasOperationForOwner(userId, operationId) {
  const op = clean(operationId);
  if (!userId || !op) return null;
  const { rows } = await pool.query(
    `SELECT o.*,
            EXISTS (
              SELECT 1 FROM ${S}.asaas_operations newer
               WHERE newer.owner_user_id=o.owner_user_id
                 AND newer.kind=o.kind
                 AND newer.created_at>o.created_at
            ) AS has_later_attempt
       FROM ${S}.asaas_operations o
      WHERE o.provider_operation_id=$1 AND o.owner_user_id=$2`,
    [op, userId],
  );
  return rows[0] || null;
}

const asaasScheduleRow = (row) => {
  if (!row) return null;
  const out = { ...row };
  try { out.payload = JSON.parse(decMaybe(out.payload_enc) || '{}'); }
  catch { out.payload = null; }
  delete out.payload_enc;
  return out;
};

export async function createAsaasBillSchedule(userId, {
  agentId = null, threadId = null, accountId = '', originChannel = 'web', executeOn,
  payload = {}, expectedHash, externalReference,
} = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(executeOn || '')) ? String(executeOn) : null;
  const origin = ['web', 'telegram', 'whatsapp', 'email'].includes(originChannel) ? originChannel : 'web';
  if (!userId || !date || !expectedHash || !externalReference) throw new Error('Agendamento financeiro incompleto.');
  const { rows } = await pool.query(
    `INSERT INTO ${S}.asaas_bill_schedules
       (owner_user_id,agent_id,thread_id,account_id,origin_channel,execute_on,payload_enc,expected_hash,external_reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (external_reference) DO UPDATE SET updated_at=now()
     WHERE ${S}.asaas_bill_schedules.owner_user_id=EXCLUDED.owner_user_id
     RETURNING *`,
    [userId, agentId, threadId, clean(accountId), origin, date,
      encMaybe(JSON.stringify(cleanDeep(payload || {}))), clean(expectedHash), clean(externalReference)],
  );
  return asaasScheduleRow(rows[0] || null);
}

export async function getAsaasBillScheduleForOwner(userId, id) {
  if (!userId || !id) return null;
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.asaas_bill_schedules WHERE id=$1 AND owner_user_id=$2`,
    [clean(id), userId],
  );
  return asaasScheduleRow(rows[0] || null);
}

export async function listAsaasBillSchedulesForOwner(userId, limit = 20) {
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  const { rows } = await pool.query(
    `SELECT id,owner_user_id,agent_id,thread_id,account_id,origin_channel,execute_on,status,
            payload_enc,expected_hash,external_reference,provider_operation_id,outcome,created_at,updated_at,cancelled_at,finished_at
       FROM ${S}.asaas_bill_schedules
      WHERE owner_user_id=$1
      ORDER BY created_at DESC LIMIT $2`,
    [userId, n],
  );
  return rows.map(asaasScheduleRow);
}

// Compare-and-set cancellation: only a schedule that's still entirely local
// can be canceled. If the worker already claimed it, we don't pretend it stopped.
export async function cancelAsaasBillSchedule(userId, id, expectedHash = null) {
  const vals = [clean(id), userId];
  let hashClause = '';
  if (expectedHash) { vals.push(clean(expectedHash)); hashClause = ` AND expected_hash=$${vals.length}`; }
  const { rows } = await pool.query(
    `UPDATE ${S}.asaas_bill_schedules
        SET status='cancelled', cancelled_at=now(), finished_at=now(), lease_until=NULL, updated_at=now()
      WHERE id=$1 AND owner_user_id=$2 AND status='scheduled'${hashClause}
      RETURNING id,execute_on,status,external_reference,cancelled_at`,
    vals,
  );
  return rows[0] || null;
}

// One process per row. An expired `executing` is NOT re-run: it may have made a
// POST and died before saving the response. It becomes `uncertain`, avoiding paying
// twice; reconciliation by externalReference should be manual/observable.
export async function claimDueAsaasBillSchedules(limit = 10) {
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  const { rows: overdue } = await pool.query(
    `UPDATE ${S}.asaas_bill_schedules
        SET status='needs_review',
            outcome=outcome || '{"reason":"execution_date_missed"}'::jsonb,
            updated_at=now(), finished_at=now()
      WHERE status='scheduled'
        AND execute_on < (now() AT TIME ZONE 'America/Sao_Paulo')::date
      RETURNING *`,
  );
  const { rows: stale } = await pool.query(
    `UPDATE ${S}.asaas_bill_schedules
        SET status='uncertain', lease_until=NULL,
            outcome=outcome || '{"reason":"lease_expired_after_possible_submission"}'::jsonb,
            updated_at=now(), finished_at=now()
      WHERE status='executing' AND lease_until < now()
      RETURNING *`,
  );
  const { rows } = await pool.query(
    `WITH due AS (
       SELECT id FROM ${S}.asaas_bill_schedules
        WHERE status='scheduled' AND execute_on = (now() AT TIME ZONE 'America/Sao_Paulo')::date
        ORDER BY execute_on,id FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE ${S}.asaas_bill_schedules s
        SET status='executing', lease_until=now()+interval '5 minutes', updated_at=now()
       FROM due WHERE s.id=due.id RETURNING s.*`,
    [n],
  );
  return [
    ...overdue.map((row) => ({ ...asaasScheduleRow(row), recovered_needs_review: true })),
    ...stale.map((row) => ({ ...asaasScheduleRow(row), recovered_uncertain: true })),
    ...rows.map(asaasScheduleRow),
  ];
}

export async function finishAsaasBillSchedule(id, {
  status, providerOperationId = null, outcome = {}, expectedCurrent = 'executing',
} = {}) {
  const allowed = new Set(['submitted','completed','failed','needs_review','uncertain','awaiting_authorization']);
  if (!allowed.has(status)) throw new Error('Estado final inválido para agendamento financeiro.');
  const { rows } = await pool.query(
    `UPDATE ${S}.asaas_bill_schedules
        SET status=$2, provider_operation_id=COALESCE($3,provider_operation_id), outcome=$4,
            lease_until=NULL, updated_at=now(),
            finished_at=CASE WHEN $2 IN ('completed','failed','needs_review','uncertain') THEN now() ELSE finished_at END
      WHERE id=$1 AND status=$5 RETURNING *`,
    [clean(id), status, providerOperationId ? clean(providerOperationId) : null, cleanDeep(outcome || {}), expectedCurrent],
  );
  return asaasScheduleRow(rows[0] || null);
}

export async function saveAsaasFinancialIntent(userId, {
  providerOperationId, accountId = '', kind, externalReference = null, expectedHash, expiresAt = null,
} = {}) {
  const type = String(kind || '').toUpperCase();
  if (!userId || !providerOperationId || !['BILL','TRANSFER'].includes(type) || !expectedHash) {
    throw new Error('Intenção financeira incompleta.');
  }
  const { rows } = await pool.query(
    `INSERT INTO ${S}.asaas_financial_intents
       (provider_operation_id,owner_user_id,account_id,kind,external_reference,expected_hash,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()+interval '2 days'))
     ON CONFLICT (provider_operation_id) DO UPDATE SET
       account_id=CASE WHEN ${S}.asaas_financial_intents.account_id='' THEN EXCLUDED.account_id ELSE ${S}.asaas_financial_intents.account_id END,
       external_reference=COALESCE(${S}.asaas_financial_intents.external_reference,EXCLUDED.external_reference),
       expected_hash=CASE WHEN ${S}.asaas_financial_intents.state='submitted' THEN EXCLUDED.expected_hash ELSE ${S}.asaas_financial_intents.expected_hash END,
       updated_at=now()
     WHERE ${S}.asaas_financial_intents.owner_user_id=EXCLUDED.owner_user_id
       AND ${S}.asaas_financial_intents.kind=EXCLUDED.kind
     RETURNING *`,
    [clean(providerOperationId), userId, clean(accountId), type,
      externalReference ? clean(externalReference) : null, clean(expectedHash), expiresAt],
  );
  return rows[0] || null;
}

export async function decideAsaasFinancialIntent({ providerOperationId, kind, payloadHash } = {}) {
  const id = clean(providerOperationId);
  const type = String(kind || '').toUpperCase();
  const hash = clean(payloadHash);
  if (!id || !['BILL','TRANSFER'].includes(type) || !hash) return { approved: false, reason: 'invalid_payload' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM ${S}.asaas_financial_intents WHERE provider_operation_id=$1 FOR UPDATE`, [id],
    );
    const row = rows[0];
    if (!row) { await client.query('COMMIT'); return { approved: false, reason: 'unknown_operation' }; }
    let approved = false;
    let reason = '';
    if (row.kind !== type) reason = 'type_mismatch';
    else if (row.expected_hash !== hash) reason = 'payload_mismatch';
    else if (new Date(row.expires_at).getTime() < Date.now()) reason = 'expired_intent';
    else if (row.state === 'refused' || row.state === 'terminal') reason = 'intent_closed';
    else { approved = true; reason = 'exact_match'; }
    await client.query(
      `UPDATE ${S}.asaas_financial_intents
          SET state=$2,last_payload_hash=$3,decision_reason=$4,
              authorization_attempts=authorization_attempts+1,updated_at=now()
        WHERE provider_operation_id=$1`,
      [id, approved ? 'approved' : 'refused', hash, reason],
    );
    await client.query('COMMIT');
    return { approved, reason, ownerUserId: row.owner_user_id, accountId: row.account_id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export async function finishAsaasReceiptNotification(operationId, delivered) {
  const { rows } = await pool.query(
    `UPDATE ${S}.asaas_operations
       SET receipt_notification_state=$2, updated_at=now()
     WHERE provider_operation_id=$1 AND receipt_notification_state='dispatching'
     RETURNING *`,
    [clean(operationId), delivered ? 'delivered' : 'failed'],
  );
  return rows[0] || null;
}

// Recovers notices that were left pending, failed, or whose process died in the
// middle of sending. The SKIP LOCKED makes the function safe even if in the future there's
// more than one process draining the same queue.
export async function claimDueAsaasReceiptNotifications(limit = 20) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const { rows } = await pool.query(
    `WITH due AS (
       SELECT provider_operation_id
       FROM ${S}.asaas_operations
       WHERE (
           (receipt_url IS NOT NULL AND receipt_url<>'')
           OR upper(status) IN ('FAILED','CANCELLED','REFUNDED')
         )
         AND (
           receipt_notification_state='pending'
           OR (receipt_notification_state='failed' AND updated_at < now()-interval '5 minutes')
           OR (receipt_notification_state='dispatching' AND updated_at < now()-interval '5 minutes')
         )
       ORDER BY updated_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE ${S}.asaas_operations a
       SET receipt_notification_state='dispatching',
           receipt_notification_attempts=receipt_notification_attempts+1,
           updated_at=now()
     FROM due
     WHERE a.provider_operation_id=due.provider_operation_id
     RETURNING a.*`,
    [n],
  );
  return rows;
}

// ── MCP servers (external connectors via Model Context Protocol) ──
// headers usually carries a credential (Authorization: Bearer ...), so the value
// lives encrypted in headers_enc and the jsonb column only serves what's legacy. The
// caller keeps receiving/sending the normal object.
export function mcpRow(r) {
  if (!r) return r;
  const out = { ...r };
  if (out.headers_enc) {
    try { out.headers = JSON.parse(decMaybe(out.headers_enc) || '{}'); }
    catch { out.headers = {}; }
  }
  delete out.headers_enc;
  return out;
}

export async function listMcpServers(userId) {
  const { rows } = await pool.query(
    `SELECT id, label, url, headers, headers_enc, agent_id, enabled, created_at
       FROM ${S}.mcp_servers WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows.map(mcpRow);
}

export async function addMcpServer({ userId, label, url, headers = {}, agentId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.mcp_servers (user_id, agent_id, label, url, headers, headers_enc)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,$5) RETURNING id, label, url, agent_id, enabled`,
    [userId, agentId, label, url, encMaybe(JSON.stringify(headers || {}))],
  );
  return rows[0];
}

export async function deleteMcpServer(userId, id) {
  await pool.query(`DELETE FROM ${S}.mcp_servers WHERE user_id = $1 AND id = $2`, [userId, id]);
}

// ── Model usage/cost ──
// Records a call to the provider. `e` carries the dimensions + the already-computed tokens.
// user_id is who used it; org_id is who pays, resolved by the payer-account
// port under the account lock, so joining or leaving the business midway doesn't
// leave the row against the wrong balance. Explicit `e.orgId` forces the account (null =
// personal); without userId and with orgId, it's a direct entry against the business.
export async function insertUsageEvent(e) {
  const insert=(client,orgId)=>client.query(
    `INSERT INTO ${S}.usage_events
       (user_id, agent_id, thread_id, turn_id, kind, model,
        tok_in, tok_cached, tok_out, tok_think, tok_total, cost_usd, bill_credits, org_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [e.userId || null, e.agentId || null, e.threadId || null, e.turnId || null,
     e.kind || 'chat', e.model || '',
     e.in || 0, e.cached || 0, e.out || 0, e.think || 0, e.total || 0, e.cost || 0,
     e.billCredits == null ? null : Math.max(0, Math.round(e.billCredits)), orgId || null],
  );
  return transacaoPagadora(pool,{userId:e.userId||null,orgId:e.orgId},insert);
}

// Is there a usage_event with this turn_id? Used for idempotency of package
// purchases (turn_id = Stripe checkout session id), so the webhook doesn't
// credit twice if Stripe redelivers the event.
export async function usageEventExistsByTurn(turnId) {
  if (!turnId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM ${S}.usage_events WHERE turn_id = $1 LIMIT 1`, [turnId],
  );
  return rows.length > 0;
}

// Counts calls to a model since `from` (ISO). Used to apply Tavily's
// free allowance (1000 searches/month) — within the allowance the cost is recorded as zero.
export async function countUsageByModelSince(model, from) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ${S}.usage_events WHERE model = $1 AND ts >= $2`,
    [model, from],
  );
  return rows[0]?.n || 0;
}

// Flexible aggregation for the dashboard. `by` defines the grouping axis;
// from/to filter the window (ISO). Optional userId restricts to one user.
const USAGE_GROUPS = {
  hour:   `to_char(date_trunc('hour',  ts AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD HH24:00')`,
  day:    `to_char(date_trunc('day',   ts AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD')`,
  month:  `to_char(date_trunc('month', ts AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM')`,
  kind:   `kind`,
  model:  `model`,
  user:   `user_id::text`,
  agent:  `agent_id::text`,
  thread: `thread_id::text`,
  turn:   `turn_id::text`,
};

// A package moved to the business at join time (kind 'grant-moved', org-credit-move.mjs)
// is not new credit: the reports count only the original row. The leftover plan of
// whoever creates the business (kind 'plan-residual', org-billing.mjs) is also excluded: it's the
// month the creator already paid for, not revenue or new credit.
export const SEM_PACOTE_LEVADO = "kind NOT IN ('grant-moved','plan-residual')";
export async function getUsage({ by = 'day', from, to, userId } = {}) {
  const expr = USAGE_GROUPS[by] || USAGE_GROUPS.day;
  const where = [SEM_PACOTE_LEVADO], vals = [];
  if (from)   { vals.push(from);   where.push(`ts >= $${vals.length}`); }
  if (to)     { vals.push(to);     where.push(`ts <  $${vals.length}`); }
  if (userId) { vals.push(userId); where.push(`user_id = $${vals.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT ${expr} AS bucket,
            count(*)            AS calls,
            count(DISTINCT turn_id) AS turns,
            sum(tok_in)         AS tok_in,
            sum(tok_cached)     AS tok_cached,
            sum(tok_out)        AS tok_out,
            sum(tok_think)      AS tok_think,
            sum(tok_total)      AS tok_total,
            sum(cost_usd)       AS cost_usd
       FROM ${S}.usage_events
       ${w}
       GROUP BY bucket
       ORDER BY bucket DESC
       LIMIT 500`,
    vals,
  );
  return rows;
}

// General totals (dashboard top cards) in the window.
export async function getUsageTotals({ from, to, userId } = {}) {
  const where = [SEM_PACOTE_LEVADO], vals = [];
  if (from)   { vals.push(from);   where.push(`ts >= $${vals.length}`); }
  if (to)     { vals.push(to);     where.push(`ts <  $${vals.length}`); }
  if (userId) { vals.push(userId); where.push(`user_id = $${vals.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT count(*) AS calls, count(DISTINCT turn_id) AS turns,
            count(DISTINCT user_id) AS users,
            sum(tok_in) AS tok_in, sum(tok_cached) AS tok_cached,
            sum(tok_out) AS tok_out, sum(tok_think) AS tok_think,
            sum(tok_total) AS tok_total, sum(cost_usd) AS cost_usd
       FROM ${S}.usage_events ${w}`,
    vals,
  );
  return rows[0];
}

// ── Listing a person's content, for the admin panel (28/08) ──
// Returns ONLY METADATA: conversation title, assistant, dates, message count;
// file name/type/date. Does NOT return message text or a signed media link,
// on purpose: the panel is for knowing WHAT the person has stored, not for
// reading their conversation or opening the photo. Same principle as the rest
// of /metrics (aggregates, doesn't expose content), just item by item.
export async function listUserThreads(userId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.status, t.created_at, t.updated_at, t.deleted_at,
            a.name AS agent_name,
            (SELECT count(*) FROM ${S}.messages m WHERE m.thread_id = t.id) AS msgs
       FROM ${S}.threads t
       LEFT JOIN ${S}.agents a ON a.id = t.agent_id
      WHERE t.user_id = $1
      ORDER BY t.updated_at DESC
      LIMIT $2`,
    [userId, Math.min(500, Math.max(1, limit))],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title || '(sem título)',
    agent: r.agent_name || '—',
    status: r.deleted_at ? 'apagada' : (r.status || 'open'),
    msgs: Number(r.msgs) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// The person's media. `kind` filters by type (image/document/audio/video); without a
// filter, everything comes back (which is the number in the "Files" box).
export async function listUserMedia(userId, { kind = null, limit = 200 } = {}) {
  const params = [userId, Math.min(500, Math.max(1, limit))];
  let where = 'm.user_id = $1';
  if (kind) { params.push(kind); where += ` AND m.kind = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT m.id, m.s3_key, m.kind, m.mime, m.source, m.caption, m.created_at,
            a.name AS agent_name
       FROM ${S}.media_assets m
       LEFT JOIN ${S}.agents a ON a.id = m.agent_id
      WHERE ${where}
      ORDER BY m.created_at DESC
      LIMIT $2`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    // A HUMAN name when there is one: the caption holds the real file name
    // ("contrato.pdf"), while the bucket key is a meaningless uuid (all the
    // list used to show, 28/08). Never the whole key, which would allow
    // building/guessing an object path.
    name: String(r.caption || '').trim() || String(r.s3_key || '').split('/').pop() || '(sem nome)',
    kind: r.kind || '—',
    mime: r.mime || '',
    source: r.source || '',
    caption: r.caption || '',
    agent: r.agent_name || '—',
    createdAt: r.created_at,
  }));
}

// Last message EACH user sent TO the assistant (role='user'), all-time.
// Used in metrics so the "Last message" column reflects the PERSON's
// interaction, not any activity (e.g. a broadcast/assistant turn)
// that bumps usage_events and made it look like everyone had spoken.
export async function getLastUserMsgMap() {
  const { rows } = await pool.query(
    `SELECT a.user_id, max(m.ts) AS last_user_ts
       FROM ${S}.messages m
       JOIN ${S}.agents a ON a.id = m.agent_id
      WHERE m.role = 'user'
      GROUP BY a.user_id`,
  );
  const map = new Map();
  for (const r of rows) map.set(r.user_id, r.last_user_ts);
  return map;
}

// Sign-ups per day (the Sign-ups tab of /metrics). Groups users.created_at by
// day in the São Paulo timezone. Optional from/to filter (dates YYYY-MM-DD, BRT).
export async function getSignupsByDay({ from, to } = {}) {
  const where = ['u.created_at IS NOT NULL'], vals = [];
  if (from) { vals.push(from); where.push(`(u.created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $${vals.length}`); }
  if (to)   { vals.push(to);   where.push(`(u.created_at AT TIME ZONE 'America/Sao_Paulo')::date <= $${vals.length}`); }
  const w = `WHERE ${where.join(' AND ')}`;
  const { rows } = await pool.query(
    `SELECT to_char((u.created_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS dia,
            count(*) AS cadastros
       FROM ${S}.users u
       ${w}
      GROUP BY dia
      ORDER BY dia ASC`,
    vals,
  );
  return rows.map((r) => ({ dia: r.dia, cadastros: Number(r.cadastros) || 0 }));
}

// Total registered users (all-time). Used in the "Active people" card of
// /metrics ("out of Y registered people").
export async function countRegisteredUsers() {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM ${S}.users`);
  return Number(rows[0]?.n) || 0;
}

// Users registered BEFORE a date (BRT, YYYY-MM-DD) — baseline for the
// cumulative sign-ups chart. Without `before`, returns 0.
export async function countUsersBefore(before) {
  if (!before) return 0;
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM ${S}.users u
      WHERE u.created_at IS NOT NULL
        AND (u.created_at AT TIME ZONE 'America/Sao_Paulo')::date < $1`,
    [before],
  );
  return Number(rows[0]?.n) || 0;
}

// Cost breakdown PER MODEL in the window (all events, including system
// use with no user_id — housekeeping/classifier). The dashboard maps each
// model to a category (text/fallback/multimodal/search). Sorted by cost.
export async function getUsageByModel({ from, to } = {}) {
  const where = ["e." + SEM_PACOTE_LEVADO], vals = [];
  if (from) { vals.push(from); where.push(`e.ts >= $${vals.length}`); }
  if (to)   { vals.push(to);   where.push(`e.ts <  $${vals.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT coalesce(e.model, '(sem modelo)') AS model,
            count(*)         AS calls,
            sum(e.tok_total) AS tok_total,
            sum(e.cost_usd)  AS cost_usd
       FROM ${S}.usage_events e
       ${w}
       GROUP BY e.model
       ORDER BY sum(e.cost_usd) DESC NULLS LAST`,
    vals,
  );
  return rows;
}

// ── Routines (time-based recurring tasks) ──
export async function createRoutine({ userId, agentId, title, prompt, hour, minute, days, tz, channel, repeatEveryMin, repeatUntil, nextRun, curation, emailSearch }) {
  // Explicit type when a structured search comes in: avoids the curation heuristic
  // blocking an email prompt that mentions "newsletter summary".
  const tipo=emailSearchTipo(emailSearch,curation);
  const config=composeRoutineConfig(null,{tipo,curation,emailSearch,prompt,channel:channel||'email'})||{};
  const { rows } = await pool.query(
    `INSERT INTO ${S}.routines (user_id, agent_id, title, prompt, hour, days, tz, channel, repeat_every_min, repeat_until, next_run, config, minute)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, agent_id, title, prompt, hour, minute, days, tz, channel, enabled, repeat_every_min, repeat_until, next_run, config`,
    [userId, agentId, title, prompt, Number(hour ?? 7), days || 'daily',
     tz || 'America/Sao_Paulo', channel || 'email',
     repeatEveryMin ?? null, repeatUntil ?? null, nextRun ?? null, JSON.stringify(config), Number(minute ?? 0)],
  );
  return rows[0];
}

// Curation and email search are mutually exclusive types: both "prepare" steps run
// (each validates what's theirs and throws in pt-BR) and the resulting config is the
// composition. undefined for both = nothing changes.
function emailSearchTipo(emailSearch,curation){
  if(emailSearch!==undefined&&curation!==undefined)throw Error('Passe curadoria OU busca_email, não os dois.');
  return emailSearch!==undefined?'busca_email':undefined;
}
export function composeRoutineConfig(current,{tipo,curation,emailSearch,prompt,channel}){
  const a=prepareCurationChange(current,{tipo,curadoria:curation,prompt,channel});
  const base=a?{...current,config:a}:current;
  const b=prepareEmailSearchChange(base,{tipo,busca_email:emailSearch,prompt,channel});
  return b||a;
}

// INTERVAL mode: advances the routine's next trigger (next_run). Pass nextRunIso=null
// to END the recurrence (turns off the routine, e.g.: the repeat_until window ended).
export async function markRoutineNext(id, nextRunIso) {
  if (nextRunIso === null) {
    await pool.query(`UPDATE ${S}.routines SET enabled = false, next_run = NULL WHERE id = $1`, [id]);
  } else {
    await pool.query(`UPDATE ${S}.routines SET next_run = $2 WHERE id = $1`, [id, nextRunIso]);
  }
}

// The user's routines (for the UI), with the assistant's name.
export async function listRoutinesForUser(userId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.agent_id, r.title, r.prompt, r.hour, r.minute, r.days, r.tz, r.channel,
            r.enabled, r.last_run_day, r.repeat_every_min, r.repeat_until, r.next_run, r.config,
            a.name AS agent_name
       FROM ${S}.routines r JOIN ${S}.agents a ON a.id = r.agent_id
       WHERE r.user_id = $1 ORDER BY r.hour, r.minute, r.created_at`,
    [userId],
  );
  return rows;
}

// Routines that are candidates to fire (the scheduler filters hour/day/dedup in memory).
// Already brings the owner's email and the assistant's name to assemble and deliver.
export async function listDueRoutines() {
  const { rows } = await pool.query(
    `SELECT r.*, u.email, u.name AS user_name, u.language AS user_language, a.name AS agent_name
       FROM ${S}.routines r
       JOIN ${S}.users u ON u.id = r.user_id
       JOIN ${S}.agents a ON a.id = r.agent_id
       WHERE r.enabled = true
         AND a.archived_at IS NULL
         AND u.deleted_at IS NULL`,
  );
  return rows;
}

export async function markRoutineRun(id, day) {
  await pool.query(`UPDATE ${S}.routines SET last_run_day = $2 WHERE id = $1`, [id, day]);
}

// SINGLE future trigger of an existing routine. Doesn't touch the routine's cadence and
// doesn't reuse reminders (which only deliver fixed text, without running the agent).
export async function createRoutineOneShot({ userId, routineId, runAt }) {
  const {rows}=await pool.query(
    `INSERT INTO ${S}.routine_one_shots(routine_id,user_id,run_at)
       SELECT r.id,r.user_id,$3::timestamptz FROM ${S}.routines r
        WHERE r.id=$2 AND r.user_id=$1 AND r.enabled=true
      ON CONFLICT (routine_id,run_at) WHERE status='pending' DO NOTHING
      RETURNING id,routine_id,run_at,status`,[userId,routineId,runAt]);
  if(rows.length)return {...rows[0],duplicate:false};
  const existing=await pool.query(
    `SELECT id,routine_id,run_at,status FROM ${S}.routine_one_shots
      WHERE user_id=$1 AND routine_id=$2 AND run_at=$3 AND status='pending' LIMIT 1`,[userId,routineId,runAt]);
  return existing.rows[0]?{...existing.rows[0],duplicate:true}:null;
}

export async function listDueRoutineOneShots() {
  const {rows}=await pool.query(
    `SELECT o.id AS one_shot_id,o.run_at AS one_shot_run_at,r.*,
            u.email,u.name AS user_name,u.language AS user_language,a.name AS agent_name
       FROM ${S}.routine_one_shots o
       JOIN ${S}.routines r ON r.id=o.routine_id AND r.user_id=o.user_id
       JOIN ${S}.users u ON u.id=r.user_id
       JOIN ${S}.agents a ON a.id=r.agent_id
      WHERE o.status='pending' AND o.run_at<=now() AND r.enabled=true
      ORDER BY o.run_at LIMIT 20`);
  return rows;
}

export async function claimRoutineOneShot(id) {
  const {rows}=await pool.query(
    `UPDATE ${S}.routine_one_shots SET status='running',started_at=now()
      WHERE id=$1 AND status='pending' AND run_at<=now() RETURNING id`,[id]);
  return rows.length===1;
}

export async function finishRoutineOneShot(id,status,outcome={}) {
  if(!['completed','partial','failed','uncertain'].includes(status))throw Error('Estado de execução extra inválido.');
  const {rows}=await pool.query(
    `UPDATE ${S}.routine_one_shots SET status=$2,outcome=$3::jsonb,finished_at=now()
      WHERE id=$1 AND status='running' RETURNING id`,[id,status,JSON.stringify(outcome||{})]);
  return rows.length===1;
}

export async function recoverRoutineOneShots() {
  const {rowCount}=await pool.query(
    `UPDATE ${S}.routine_one_shots SET status='uncertain',finished_at=now(),
            outcome=jsonb_build_object('reason','worker_interrupted')
      WHERE status='running' AND started_at<now()-interval '10 minutes'`);
  return rowCount;
}

// Targets of an admin broadcast: one agent per owner (the most recent), already with
// the owner's email and name + the assistant's name to run and deliver. Only owners with
// an email on file (today the broadcast channel is email). 1 message per person:
// when a person has more than one agent, the main one is the FIRST created (ASC).
export async function listBroadcastTargets() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u.id)
            u.id AS user_id, u.name AS user_name, u.email, u.created_at,
            a.id AS agent_id, a.name AS agent_name,
            la.last_user_ts
       FROM ${S}.users u
       JOIN ${S}.agents a ON a.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT max(m.ts) AS last_user_ts
           FROM ${S}.messages m
           JOIN ${S}.agents a2 ON a2.id = m.agent_id
          WHERE a2.user_id = u.id AND m.role = 'user'
       ) la ON true
      WHERE u.email IS NOT NULL AND u.email <> '' AND a.archived_at IS NULL
      ORDER BY u.id, a.created_at ASC`,
  );
  return rows;
}

// Saves/updates the DELIVERY status of ONE WhatsApp message (webhook
// value.statuses). Upsert by wamid; does NOT downgrade an already more advanced status
// (rank), but 'failed' (rank 9) always wins. Idempotent for webhook redelivery.
const WA_STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 9 };
export async function recordWaStatus({ wamid, recipient = '', status = '', errorCode = null, errorTitle = null, errorMessage = null, statusAt = null, raw = null }) {
  if (!wamid) return null;
  const rank = WA_STATUS_RANK[status] ?? 0;
  const at = statusAt ? new Date(Number(statusAt) * 1000).toISOString() : null;
  const { rows } = await pool.query(
    `INSERT INTO ${S}.wa_message_status
       (wamid, recipient, status, rank, error_code, error_title, error_message, status_at, updated_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9::jsonb)
     ON CONFLICT (wamid) DO UPDATE SET
       recipient     = COALESCE(NULLIF(EXCLUDED.recipient,''), ${S}.wa_message_status.recipient),
       status        = CASE WHEN EXCLUDED.rank >= ${S}.wa_message_status.rank THEN EXCLUDED.status ELSE ${S}.wa_message_status.status END,
       rank          = GREATEST(EXCLUDED.rank, ${S}.wa_message_status.rank),
       error_code    = COALESCE(EXCLUDED.error_code, ${S}.wa_message_status.error_code),
       error_title   = COALESCE(EXCLUDED.error_title, ${S}.wa_message_status.error_title),
       error_message = COALESCE(EXCLUDED.error_message, ${S}.wa_message_status.error_message),
       status_at     = COALESCE(EXCLUDED.status_at, ${S}.wa_message_status.status_at),
       updated_at    = now(),
       raw           = COALESCE(EXCLUDED.raw, ${S}.wa_message_status.raw)
     RETURNING wamid`,
    [wamid, recipient, status, rank, errorCode, errorTitle, errorMessage, at, raw ? JSON.stringify(raw) : null],
  );
  return rows[0]?.wamid || null;
}

// Queries the delivery status of a list of wamids (post-send correlation).
export async function getWaStatuses(wamids = []) {
  if (!Array.isArray(wamids) || !wamids.length) return [];
  const { rows } = await pool.query(
    `SELECT wamid, recipient, status, error_code, error_title, error_message, status_at, updated_at
       FROM ${S}.wa_message_status WHERE wamid = ANY($1)`,
    [wamids],
  );
  return rows;
}

// ── ROUTINE OFFER BOOK ────────────────────────────────────────────────
// A single record that BOTH paths (assistant in conversation and team on
// /broadcast) write and read. Everything here is deterministic: what decides whether it can
// make an offer is a count and a date, not intent reading.

// The whole cadence (25/09): 3 days between one offer and the next, and the
// person's explicit opt-out. Nothing else. No offer cap or long wait, and
// nothing counts as refusal (not silence, not cancelling a routine): only
// "I don't want more suggestions" stops the offers.
export const OFERTA_COOLDOWN_DIAS = 3;

// Records that an offer WAS MADE. Called by the tool oferecer_rotina (via
// 'chat') and by the panel's send (via 'painel'). Append-only: two offers become
// two rows, because knowing we already pushed once is exactly the point.
export async function openRoutineOffer({ userId, agentId = null, padrao = '', titulo = '', via = 'chat' }) {
  if (!userId) return null;
  const { rows } = await pool.query(
    `INSERT INTO ${S}.routine_offers (user_id, agent_id, padrao, titulo, via)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, agentId, String(padrao || '').slice(0, 40), clean(String(titulo || '')).slice(0, 160),
      via === 'painel' ? 'painel' : 'chat'],
  );
  return rows[0] || null;
}

// The window in which a new routine IS, in practice, the answer to the offer: the person
// said "sure" and the schedule was born right there, in the same conversation. Outside it, the
// routine only closes the offer if it TALKS ABOUT THE SAME THING that was offered.
export const OFERTA_ACEITE_JANELA_MIN = 30;

// Connector words don't say what the routine is about, so they can't count
// as a match (otherwise "summary OF THE calendar" would match anything).
const ACEITE_VAZIAS = new Set([
  'para', 'pelo', 'pela', 'pelos', 'pelas', 'esse', 'essa', 'este', 'esta', 'isso',
  'como', 'quando', 'onde', 'todo', 'toda', 'todos', 'todas', 'cada', 'meu', 'minha',
  'sobre', 'entre', 'depois', 'antes', 'sempre', 'aqui', 'mais', 'menos', 'ainda',
]);

// Tokens that actually state the SUBJECT: no accents, no punctuation, no short
// word, no stray hour/number ("7am", "14").
function aceiteTokens(texto) {
  return new Set(String(texto || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 4 && !ACEITE_VAZIAS.has(w) && !/^\d+h?$/.test(w)));
}

/**
 * Does the routine that just got created match THIS offer?
 *
 * Exists because "created a routine" isn't the same as "accepted the offer": on
 * 2026-09-17 a user created an email routine and it closed, as a side effect, a
 * calendar-summary offer made a day earlier, which he never answered. The
 * metric started counting a conversion that never happened.
 *
 * Deliberately deterministic, with no intent reading by the model: either
 * PROXIMITY counts (the routine was born right after the offer, in the same conversation) or
 * SUBJECT MATCH (two content terms in common in the title). When in
 * doubt, the offer stays open, which is the cheap side of the error: at most the person
 * shows up as "hasn't answered yet" on something they already have.
 */
export function ofertaCorresponde(oferta, { titulo = '', criadaEm = Date.now() } = {}) {
  if (!oferta) return false;
  const dt = new Date(criadaEm).getTime() - new Date(oferta.offered_at).getTime();
  if (dt >= 0 && dt <= OFERTA_ACEITE_JANELA_MIN * 60_000) return true;
  const ofertado = aceiteTokens(oferta.titulo);
  const criado = aceiteTokens(titulo);
  let comuns = 0;
  for (const w of ofertado) if (criado.has(w)) comuns += 1;
  return comuns >= 2;
}

// Closes as ACCEPTED the offer that the new routine actually fulfills. Called when a
// schedule is actually born (criar_rotina): acceptance is the FACT that the routine
// exists, not the "sure" in the conversation (which the model could misread). But it's
// the fact that THE OFFERED ROUTINE exists: closes at most ONE offer, from the same
// assistant, and only if it matches. With no matching offer it does nothing —
// creating a routine on one's own is normal and can't become a conversion.
export async function acceptRoutineOffers({ userId, agentId = null, routineId = null, titulo = '' }) {
  if (!userId) return 0;
  const { rows } = await pool.query(
    `SELECT id, agent_id, padrao, titulo, offered_at FROM ${S}.routine_offers
      WHERE user_id = $1 AND status = 'aberta' ORDER BY offered_at DESC`,
    [userId],
  );
  const alvo = rows.find((o) => (!agentId || !o.agent_id || o.agent_id === agentId)
    && ofertaCorresponde(o, { titulo, criadaEm: Date.now() }));
  if (!alvo) return 0;
  const { rowCount } = await pool.query(
    `UPDATE ${S}.routine_offers
        SET status = 'aceita', routine_id = coalesce($2, routine_id), closed_at = now()
      WHERE id = $1 AND status = 'aberta'`,
    [alvo.id, routineId],
  );
  return rowCount || 0;
}

export async function listRoutineOffers(userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT o.*, a.name AS agent_name FROM ${S}.routine_offers o
       LEFT JOIN ${S}.agents a ON a.id = o.agent_id
      WHERE o.user_id = $1 ORDER BY o.offered_at DESC LIMIT $2`,
    [userId, Math.min(50, Math.max(1, Number(limit) || 10))],
  );
  return rows;
}

// Hard opt-out. default '*' = suggest nothing; a catalog id = only that type.
export async function setRoutineOfferOptOut({ userId, padrao = '*', motivo = '', origem = 'chat' }) {
  if (!userId) return null;
  const p = String(padrao || '*').slice(0, 40) || '*';
  const { rows } = await pool.query(
    `INSERT INTO ${S}.routine_offer_optouts (user_id, padrao, motivo, origem)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, padrao) DO UPDATE SET motivo = EXCLUDED.motivo, origem = EXCLUDED.origem
     RETURNING *`,
    [userId, p, clean(String(motivo || '')).slice(0, 300), origem === 'painel' ? 'painel' : 'chat'],
  );
  return rows[0] || null;
}

export async function clearRoutineOfferOptOut({ userId, padrao = null }) {
  if (!userId) return 0;
  const { rowCount } = padrao
    ? await pool.query(`DELETE FROM ${S}.routine_offer_optouts WHERE user_id = $1 AND padrao = $2`, [userId, padrao])
    : await pool.query(`DELETE FROM ${S}.routine_offer_optouts WHERE user_id = $1`, [userId]);
  return rowCount || 0;
}

// The QUESTION both paths ask: can I make an offer now, and if not, why?
// Always returns the history along with it, because the screen needs to SHOW the reason for the
// suppression (hiding it without saying why is what makes someone force it again).
export async function routineOfferGate(userId, padrao = null) {
  const vazio = { pode: false, motivo: 'sem usuário', ofertas: 0, ultima: null, aberta: null, optout: null };
  if (!userId) return vazio;
  const [offs, opts] = await Promise.all([
    pool.query(
      `SELECT status, padrao, titulo, via, offered_at,
              extract(epoch FROM (now() - offered_at)) / 86400 AS dias
         FROM ${S}.routine_offers WHERE user_id = $1 ORDER BY offered_at DESC LIMIT 20`, [userId]),
    pool.query(`SELECT padrao, motivo, created_at FROM ${S}.routine_offer_optouts WHERE user_id = $1`, [userId]),
  ]);
  const rows = offs.rows;
  const optouts = opts.rows;
  const bloqueio = optouts.find((o) => o.padrao === '*' || (padrao && o.padrao === padrao)) || null;
  const ultima = rows[0] || null;
  const aberta = rows.find((r) => r.status === 'aberta') || null;
  const naoAceitas = rows.filter((r) => r.status !== 'aceita').length;
  const base = {
    ofertas: rows.length, naoAceitas, ultima, aberta,
    optout: bloqueio ? { padrao: bloqueio.padrao, motivo: bloqueio.motivo, em: bloqueio.created_at } : null,
    optouts,
  };
  if (bloqueio) {
    return { ...base, pode: false, motivo: bloqueio.padrao === '*' ? 'a pessoa pediu pra não sugerir agendamento' : `a pessoa dispensou ofertas de ${bloqueio.padrao}` };
  }
  if (ultima && Number(ultima.dias) < OFERTA_COOLDOWN_DIAS) {
    return { ...base, pode: false, motivo: `já ofereci há ${Math.floor(Number(ultima.dias))}d (${ultima.via})` };
  }
  return { ...base, pode: true, motivo: '' };
}

// How many LIVE schedules the person has (routine and reminder count the same, same
// rule as the goal: a series of reminders is ONE schedule). It's the number that decides whether
// the assistant should still think about making an offer.
export async function countUserSchedules(userId) {
  if (!userId) return 0;
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM ${S}.routines r WHERE r.user_id = $1 AND r.enabled)
          + (SELECT count(DISTINCT split_part(rm.message, E'\\n', 1))::int FROM ${S}.reminders rm
              WHERE rm.user_id = $1 AND rm.status = 'pending' AND rm.run_at > now()) AS n`,
    [userId],
  );
  return Number(rows[0]?.n || 0);
}

// Persists an agent-initiated conversation OPENER (assistant message only,
// no user turn): writes to the thread's history + inserts 1 row in messages.
// Used by lifecycle campaigns (welcome/reactivation) — the agent "opens" the
// conversation with the owner and the text stays in the history to give continuity if they engage.
export async function persistAgentOpening({ agentId, userId, title, text }) {
  const thread = await getOrCreateThreadByTitle({ agentId, userId, title });
  if (!(await appendAssistantToThread({ threadId: thread.id, userId, text }))) throw new Error('THREAD_NOT_FOUND');
  return thread.id;
}

// History and transcript commit together; no full snapshot replacement.
export async function appendAssistantToThread({ threadId, userId, text, deliveryKey, attachments, pergunta }) {
  return appendThreadMessage(pool, S, { threadId, userId, text, clean, deliveryKey, attachments, pergunta });
}

export async function updateRoutine(id, userId, fields) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const {rows}=await c.query(`SELECT * FROM ${S}.routines WHERE id=$1 AND user_id=$2 FOR UPDATE`,[id,userId]);
    const current=rows[0];if(!current)throw Error('Rotina não encontrada.');
    // Heartbeats are operational state, not a change to the user's proposal.
    const stableConfig=value=>{const {execution,...rest}=value||{};return JSON.stringify(rest,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);};
    if(fields.expected && Object.entries(fields.expected).some(([k,v])=>!['agent_id','config','prompt','channel','hour','minute','days','tz','enabled','title','repeat_every_min','repeat_until'].includes(k)||(k==='config'?stableConfig(current[k])!==stableConfig(v):JSON.stringify(current[k])!==JSON.stringify(v))))throw Object.assign(Error('A rotina mudou desde a proposta. Atualize a lista e confirme novamente.'),{code:'ROUTINE_CHANGED'});
    const config=composeRoutineConfig(current,{tipo:emailSearchTipo(fields.emailSearch,fields.curation),curation:fields.curation,emailSearch:fields.emailSearch,prompt:fields.prompt,channel:fields.channel});
    if(current.config?.flight_monitor&&fields.prompt!==undefined)throw Error('Monitor de voos exige revisão dos parâmetros estruturados. Nada foi alterado.');
    const allowed=['title','prompt','hour','minute','days','tz','channel','enabled','repeat_until'];
    const sets=[],vals=[id,userId];
    for(const k of allowed)if(fields[k]!==undefined){vals.push(fields[k]);sets.push(`${k}=$${vals.length}`);}
    if(config){vals.push(JSON.stringify(config));sets.push(`config=$${vals.length}::jsonb`);}
    const saved=sets.length ? (await c.query(`UPDATE ${S}.routines SET ${sets.join(', ')} WHERE id=$1 AND user_id=$2 RETURNING *`,vals)).rows[0] : current;
    await c.query('COMMIT');return {ok:true,routine:saved};
  } catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}

export async function deleteRoutine(id, userId, expected) {
  const guarded = expected !== undefined;
  const { rows } = await pool.query(
    `DELETE FROM ${S}.routines r WHERE id=$1 AND user_id=$2${guarded ? ` AND (to_jsonb(r) #- '{config,execution}') @> (($3::jsonb - 'repeat_until') #- '{config,execution}') AND (NOT ($3::jsonb ? 'repeat_until') OR repeat_until IS NOT DISTINCT FROM ($3::jsonb->>'repeat_until')::timestamptz)` : ''} RETURNING id`,
    guarded ? [id,userId,JSON.stringify(expected)] : [id,userId],
  );
  if (guarded && !rows.length) throw Object.assign(Error('A rotina mudou ou não está disponível. Atualize a lista e confirme novamente.'), {code:'ROUTINE_CHANGED'});
}

export async function getRoutineOwned(id, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.routines WHERE id = $1 AND user_id = $2`, [id, userId],
  );
  return rows[0] || null;
}

// ── One-off reminders (created by the agent in the conversation) ──
export async function createReminder(args) {
  // Reminder, request identity and first occurrence commit together. The store
  // also scopes ownership and refuses a duplicate with different delivery terms.
  return reminderExecutionStore.create(args);
}

// Reminders ready to fire: already past their time and still pending.
// Brings the owner's email and the assistant's name to assemble/deliver.
export async function listDueReminders() {
  return reminderExecutionStore.listDue();
}

// User's future reminders (for UI/queries).
export async function listRemindersForUser(userId, options) {
  return reminderExecutionStore.listForUser(userId, options);
}

export async function cancelReminder(id, userId, options) {
  return reminderExecutionStore.cancel(id, userId, options);
}
export const rescheduleReminder = (id,userId,change) => reminderExecutionStore.reschedule(id,userId,change);

// ── Threads (topics/tasks; each one a resumable conversation) ──
export async function createThread({ agentId, userId, title }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.threads (agent_id, user_id, title) VALUES ($1,$2,$3)
     RETURNING id, agent_id, user_id, title, status, summary, history`,
    [agentId, userId, title || ''],
  );
  return rows[0];
}

// All of the user's threads (across all assistants), with the assistant's name.
export async function listThreads(userId) {
  // Hides the internal onboarding thread ("✨ Boas-vindas"): it carries the
  // internal prompt and isn't a real conversation of the user's.
  const { rows } = await pool.query(
    `SELECT t.id, t.agent_id, t.title, t.status, t.updated_at, a.name AS agent_name,
            t.favorite, (t.archived_at IS NOT NULL) AS archived,
            left((SELECT m.content FROM ${S}.messages m
                    WHERE m.thread_id = t.id
                    ORDER BY m.ts DESC, m.id DESC LIMIT 1), 200) AS last_msg,
            -- Não lida = chegou algo do assistente DEPOIS da última vez que a
            -- pessoa abriu a conversa. Mensagem do próprio usuário nunca acende
            -- a bolinha (ele acabou de escrever, sabe que está lá).
            EXISTS (SELECT 1 FROM ${S}.messages m
                      WHERE m.thread_id = t.id AND m.role <> 'user'
                        AND m.ts > t.last_read_at) AS unread
       FROM ${S}.threads t JOIN ${S}.agents a ON a.id = t.agent_id
       WHERE t.user_id = $1 AND t.title <> '✨ Boas-vindas' AND t.deleted_at IS NULL
       ORDER BY t.favorite DESC, t.updated_at DESC`,
    [userId],
  );
  return rows;
}

// Recent activity from the user's OTHER conversations (all assistants/channels),
// to give the current assistant a sense of what's going on outside this thread.
// Returns title, assistant name, when it was, the summary (if any) and the last
// user message in that thread. Excludes the current thread and the internal onboarding one.
export async function recentCrossChannelThreads(userId, excludeThreadId, limit = 6) {
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.updated_at, t.summary, a.name AS agent_name,
            (SELECT m.content FROM ${S}.messages m
               WHERE m.thread_id = t.id AND m.role = 'user'
               ORDER BY m.ts DESC LIMIT 1) AS last_user_msg
       FROM ${S}.threads t JOIN ${S}.agents a ON a.id = t.agent_id
       WHERE t.user_id = $1
         AND t.id <> $2
         AND t.title <> '✨ Boas-vindas'
         AND t.deleted_at IS NULL
         AND t.updated_at > now() - interval '7 days'
       ORDER BY t.updated_at DESC
       LIMIT $3`,
    [userId, excludeThreadId || '00000000-0000-0000-0000-000000000000', limit],
  );
  return rows;
}

// Map: channel name as the user says it -> fixed title of that channel's thread.
// Web/free-form titles return null (they fall back to word search).
export function channelToThreadTitle(channel) {
  if (!channel) return null;
  const c = String(channel).toLowerCase().trim();
  if (/extens|chrome|navegad/.test(c)) return '🧩 Extensão Chrome';
  if (/whats|zap/.test(c)) return 'WhatsApp';
  if (/telegram|\btele\b/.test(c)) return 'Telegram';
  if (/recado|broadcast/.test(c)) return '📣 Recado';
  return null;
}

// RECALL across channels: searches the OTHER conversations of the SAME assistant + SAME owner.
// Scope LOCKED by (agentId,userId) — the model only passes filters (search/channel/dates).
// Excludes the internal onboarding thread and (optionally) the current thread.
export async function searchThreads({ agentId, userId, q, channel, since, until, excludeThreadId, limit = 10 }) {
  const params = [agentId, userId];
  const where = [`t.agent_id = $1`, `t.user_id = $2`, `t.title <> '✨ Boas-vindas'`, `t.deleted_at IS NULL`];
  const title = channelToThreadTitle(channel);
  if (title) { params.push(title); where.push(`t.title = $${params.length}`); }
  if (excludeThreadId) { params.push(excludeThreadId); where.push(`t.id <> $${params.length}`); }
  if (since) { params.push(since); where.push(`t.updated_at >= $${params.length}`); }
  if (until) { params.push(until); where.push(`t.updated_at <= $${params.length}`); }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    const p = `$${params.length}`;
    where.push(`(t.title ILIKE ${p} OR t.summary ILIKE ${p}
       OR EXISTS (SELECT 1 FROM ${S}.messages m WHERE m.thread_id = t.id AND m.content ILIKE ${p}))`);
  }
  const lim = Math.min(Math.max(1, Number(limit) || 10), 25);
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.updated_at, t.summary,
            (SELECT count(*) FROM ${S}.messages m WHERE m.thread_id = t.id) AS msg_count,
            (SELECT m.content FROM ${S}.messages m
               WHERE m.thread_id = t.id AND m.role = 'user' ORDER BY m.ts DESC LIMIT 1) AS last_user_msg
       FROM ${S}.threads t
       WHERE ${where.join(' AND ')}
       ORDER BY t.updated_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows;
}

// RECALL: reads the content of ONE thread of the owner/assistant themself. Resolves by id,
// or by channel/title, or by the best search match. Returns summary + messages
// (the ones matching the search, or the last N), with a hard cap (token cost).
export async function readThreadContent({ agentId, userId, threadId, channel, q, limit = 30 }) {
  let thread = null;
  if (threadId) {
    const { rows } = await pool.query(
      `SELECT id, title, summary, updated_at FROM ${S}.threads
         WHERE id = $1 AND agent_id = $2 AND user_id = $3`,
      [threadId, agentId, userId],
    );
    thread = rows[0] || null;
  } else {
    const found = await searchThreads({ agentId, userId, q, channel, limit: 1 });
    if (found[0]) {
      const { rows } = await pool.query(
        `SELECT id, title, summary, updated_at FROM ${S}.threads WHERE id = $1`, [found[0].id]);
      thread = rows[0] || null;
    }
  }
  if (!thread) return null;
  const cap = Math.min(Math.max(1, Number(limit) || 30), 60);
  let rows;
  if (q && String(q).trim()) {
    ({ rows } = await pool.query(
      `SELECT role, content, ts FROM ${S}.messages
         WHERE thread_id = $1 AND content ILIKE $2 ORDER BY ts DESC LIMIT $3`,
      [thread.id, `%${String(q).trim()}%`, cap]));
  } else {
    ({ rows } = await pool.query(
      `SELECT role, content, ts FROM ${S}.messages
         WHERE thread_id = $1 ORDER BY ts DESC LIMIT $2`,
      [thread.id, cap]));
  }
  return { thread, messages: rows.reverse() };
}

// Thread validando o dono (carrega o history pra rodar a conversa).
export async function getThreadOwned(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, agent_id, user_id, title, status, summary, history, webhook_skill FROM ${S}.threads WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

// Binds a thread to a webhook skill (persists the slug for the ping-pong).
export async function setThreadWebhookSkill(id, slug) {
  await pool.query(`UPDATE ${S}.threads SET webhook_skill = $2 WHERE id = $1`, [id, String(slug || '')]);
}

// The conversation's app focus (sticky route-guard). Returns null when there's no focus.
export async function getThreadAppFocus(threadId) {
  if (!threadId) return null;
  const { rows } = await pool.query(
    `SELECT app_focus, app_focus_at FROM ${S}.threads WHERE id = $1`, [threadId]);
  if (!rows.length || !rows[0].app_focus) return null;
  return { system: rows[0].app_focus, at: rows[0].app_focus_at };
}

// Saves (or clears, with an empty system) the conversation's app focus. Every write
// re-stamps the clock: the focus dies from SILENCE, not from absolute age.
export async function setThreadAppFocus(threadId, system) {
  if (!threadId) return;
  const slug = String(system || '');
  await pool.query(
    `UPDATE ${S}.threads
        SET app_focus = $2,
            app_focus_at = CASE WHEN $2 = '' THEN NULL ELSE now() END
      WHERE id = $1`,
    [threadId, slug],
  );
}

// Raw messages of a thread (to recover the history in the UI).
export async function getThreadMessages(threadId) {
  // Tie-break by id: each turn writes user+assistant in the SAME INSERT, so
  // both get the same ts (now() = transaction time). ORDER BY ts alone leaves
  // the tie undefined and sometimes the user's question showed up AFTER the
  // answer when reopening the conversation. The bigserial is assigned in VALUES order
  // (user before assistant), so ts, id returns the real order of the dialogue.
  const { rows } = await pool.query(
    `SELECT id, role, content, ts, attachments FROM ${S}.messages WHERE thread_id = $1 ORDER BY ts, id`,
    [threadId],
  );
  return rows;
}

// Marks the conversation as read up to a message (the last one the interface REALLY
// showed). Marking up to the message instead of now() closes the race: if something arrives
// between the read and this write, it stays unread.
// greatest() guards against out-of-order calls (a slow poll arriving late).
//
// upToMsgId is the message's ID, NOT its ts. Passing the ts doesn't work: Postgres
// stores timestamptz with microsecond precision, the driver delivers a JS Date (millisecond)
// and toISOString() truncates it. The saved value ended up ~0.5ms BEFORE the real ts, so
// `m.ts > last_read_at` stayed true and the unread dot never cleared.
// By resolving the ts inside the database itself, the precision never leaves it.
export async function markThreadRead(id, userId, upToMsgId) {
  if (!id || !userId) return;
  const msgId = Number(upToMsgId);
  const upTo = Number.isFinite(msgId) && msgId > 0 ? msgId : null;
  await pool.query(
    upTo
      ? `UPDATE ${S}.threads SET last_read_at = greatest(
           last_read_at, coalesce((SELECT m.ts FROM ${S}.messages m WHERE m.id = $3), last_read_at))
         WHERE id = $1 AND user_id = $2`
      : `UPDATE ${S}.threads SET last_read_at = now() WHERE id = $1 AND user_id = $2`,
    upTo ? [id, userId, upTo] : [id, userId],
  );
}

// Reuses (or creates) a fixed thread by title — used by the Telegram channel,
// which is just one continuous conversation (one thread per bot).
export async function getOrCreateThreadByTitle({ agentId, userId, title }) {
  const { rows } = await pool.query(
    `SELECT id, agent_id, user_id, title, status, summary, history, deleted_at FROM ${S}.threads
       WHERE agent_id = $1 AND user_id = $2 AND title = $3 ORDER BY updated_at DESC LIMIT 1`,
    [agentId, userId, title],
  );
  if (rows[0]) {
    // New activity on a channel whose thread the user had deleted: reactivates it.
    if (rows[0].deleted_at) {
      await pool.query(`UPDATE ${S}.threads SET deleted_at = NULL WHERE id = $1`, [rows[0].id]);
      rows[0].deleted_at = null;
    }
    return rows[0];
  }
  return createThread({ agentId, userId, title });
}

export async function renameThread(id, userId, title) {
  await pool.query(`UPDATE ${S}.threads SET title = $3 WHERE id = $1 AND user_id = $2`, [id, userId, title]);
}

export async function setThreadStatus(id, userId, status) {
  await pool.query(`UPDATE ${S}.threads SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2`, [id, userId, status]);
}

// Deletes a conversation "for the user": SOFT delete. The row and the messages
// STAY in the database; we only mark deleted_at so it disappears from the interface and from recall.
// New activity on the channel reactivates the thread (getOrCreateThreadByTitle clears the
// flag). Returns how many rows it marked (0 = wasn't the user's / already deleted).
export async function deleteThread(id, userId) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.threads SET deleted_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return rowCount;
}

// Favorite/unfavorite a conversation (highlight at the top of the list).
export async function setThreadFavorite(id, userId, on) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.threads SET favorite = $3
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId, !!on],
  );
  return rowCount;
}

// Archive/unarchive (removes/brings back from the main list, without deleting).
export async function setThreadArchived(id, userId, on) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.threads SET archived_at = ${on ? 'now()' : 'NULL'}
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return rowCount;
}

// Saves the user's question ON ARRIVAL, already before the turn runs.
// Before, both rows (question + answer) were born together at the END of the turn, so
// during the 60-90s of processing the question simply didn't exist in the database:
// the conversation list kept showing the PREVIOUS answer as the last message and the
// conversation didn't move to the top. And if the turn died midway, the question vanished.
// Now the row is born here; saveThreadTurn only fills in its final text.
// Returns the row's id (or null on failure: the end of the turn falls back to inserting both).
export async function startThreadTurn(threadId, agentId, content, title) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.messages (agent_id, thread_id, role, content, attachments)
       VALUES ($1,$2,'user',$3,NULL) RETURNING id`,
    [agentId, threadId, clean(content ?? '')],
  );
  // Moves the conversation to the top of the list right away (ordering is by updated_at).
  // The title is only filled in if it's still empty; never overwrites what exists.
  await pool.query(
    title
      ? `UPDATE ${S}.threads SET updated_at = now(), title = coalesce(nullif(title, ''), $2) WHERE id = $1`
      : `UPDATE ${S}.threads SET updated_at = now() WHERE id = $1`,
    title ? [threadId, clean(title)] : [threadId],
  );
  return rows[0]?.id ?? null;
}

// Persists a thread exchange: history+summary in the thread + raw log (with thread_id).
// `interjecoes` = messages the user sent AFTER the turn started and that
// were absorbed by the turn itself (see pollNewUserMsg in core-proto/core.mjs).
// They become 'user' rows BETWEEN the question and the answer: without this, the
// user's message wouldn't show up anywhere in the conversation (it would only stay in the history
// jsonb) and the history would lie about what was said. Order guaranteed by the
// bigserial: the listing is ORDER BY ts, id.
export async function saveThreadTurn(threadId, agentId, { history, summary, userMsg, assistantMsg, title, attachments, userMsgId, interjecoes = [], baseHistory, skipAssistant = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT history FROM ${S}.threads WHERE id=$1 AND agent_id=$2 FOR UPDATE`, [threadId, agentId]);
    if (!rows.length) throw new Error('THREAD_NOT_FOUND');
    // Mandatory snapshot: never guess the base from the current state.
    const base = cleanDeep(baseHistory);
    const merged = mergeThreadHistory(base, rows[0].history, cleanDeep(history));
    const histJson = JSON.stringify(merged);
    const summ = clean(summary ?? '');
    if (title) {
      await client.query(
        `UPDATE ${S}.threads SET history = $2, summary = $3, title = $4, updated_at = now() WHERE id = $1`,
        [threadId, histJson, summ, clean(title)],
      );
    } else {
      await client.query(
        `UPDATE ${S}.threads SET history = $2, summary = $3, updated_at = now() WHERE id = $1`,
        [threadId, histJson, summ],
      );
    }
    // The card/attachment stays only on the assistant's row (it's what produced it).
    const att = Array.isArray(attachments) && attachments.length ? JSON.stringify(attachments) : null;
    // If the question was already born on arrival (startThreadTurn), here we only complete its
    // final text — the turn rewrites the saved message when there's an attachment
    // (the 📎 marker in place of the whole PDF, for example).
    const extras = (Array.isArray(interjecoes) ? interjecoes : [])
      .map((t) => clean(typeof t === 'string' ? t : (t?.text ?? '')))
      .filter((t) => t && t.trim());
    const gravarExtras = async () => {
      for (const t of extras) {
        await client.query(
          `INSERT INTO ${S}.messages (agent_id, thread_id, role, content, attachments)
             VALUES ($1,$2,'user',$3,NULL)`,
          [agentId, threadId, t],
        );
      }
    };
    if (userMsgId) {
      await client.query(
        `UPDATE ${S}.messages SET content = $2 WHERE id = $1 AND role = 'user' AND thread_id=$3 AND agent_id=$4`,
        [userMsgId, clean(userMsg), threadId, agentId],
      );
      await gravarExtras();
      if (!skipAssistant) await client.query(
        `INSERT INTO ${S}.messages (agent_id, thread_id, role, content, attachments)
           VALUES ($1,$2,'assistant',$3,$4)`,
        [agentId, threadId, clean(assistantMsg), att],
      );
      await client.query('COMMIT');
      return;
    }
    if (!extras.length && skipAssistant) {
      await client.query(
        `INSERT INTO ${S}.messages (agent_id, thread_id, role, content, attachments)
           VALUES ($1,$2,'user',$3,NULL)`,
        [agentId, threadId, clean(userMsg)],
      );
      await client.query('COMMIT');
      return;
    }
    if (!extras.length) {
      await client.query(
        `INSERT INTO ${S}.messages (agent_id, thread_id, role, content, attachments)
           VALUES ($1,$2,'user',$3,NULL),($1,$2,'assistant',$4,$5)`,
        [agentId, threadId, clean(userMsg), clean(assistantMsg), att],
      );
      await client.query('COMMIT');
      return;
    }
    await client.query(
      `INSERT INTO ${S}.messages (agent_id, thread_id, role, content, attachments)
         VALUES ($1,$2,'user',$3,NULL)`,
      [agentId, threadId, clean(userMsg)],
    );
    await gravarExtras();
    if (!skipAssistant) await client.query(
      `INSERT INTO ${S}.messages (agent_id, thread_id, role, content, attachments)
         VALUES ($1,$2,'assistant',$3,$4)`,
      [agentId, threadId, clean(assistantMsg), att],
    );
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { client.release(); }
}

// ── Telegram bots (one per user, own token) ──
// BotFather's token is a long-lived credential: whoever has it speaks for the bot.
// In the database it NEVER appears in plain text: `token_hash` (sha256) is the lookup key
// and `token_enc` holds the value encrypted by the vault. Since the poller needs the
// original token to call the Telegram API, a hash alone wouldn't be enough.
export const tgHash = (t) => createHash('sha256').update(String(t ?? '')).digest('hex');
// Matches both the plain-text token and the hash, and also catches the legacy row that
// never went through the backfill (there token_hash still holds the plain-text token).
export const tgKeys = (t) => [tgHash(t), String(t ?? '')];

// Returns the REAL token in `token`, so everyone calling it keeps working the same way.
export function tgRow(r) {
  if (!r) return r;
  const out = { ...r };
  out.token = out.token_enc ? decMaybe(out.token_enc) : out.token_hash;
  delete out.token_enc;
  return out;
}
// In a list, a row that doesn't decrypt (vault unavailable) can't bring down the
// others: it's left out and the reason goes to the log.
function tgRows(rows) {
  const out = [];
  for (const r of rows) {
    try { out.push(tgRow(r)); }
    catch (e) { console.error('[telegram] unreadable token in db:', r?.token_hash, e?.message ?? e); }
  }
  return out;
}

export async function saveTelegramBot({ userId, agentId, token, botUsername }) {
  const raw = String(token);
  const hash = tgHash(raw);
  const enc = encMaybe(raw);
  // Legacy row (PK is still the plain-text token): upgrades to the hash+encrypted pair BEFORE
  // the upsert, otherwise the ON CONFLICT wouldn't match and would create a second row.
  await pool.query(
    `UPDATE ${S}.telegram_bots SET token_hash = $1, token_enc = $2 WHERE token_hash = $3`,
    [hash, enc, raw],
  );
  const { rows } = await pool.query(
    `INSERT INTO ${S}.telegram_bots (token_hash, token_enc, user_id, agent_id, bot_username, enabled, pair_code)
       VALUES ($1,$2,$3,$4,$5,true, substr(md5(random()::text || $1), 1, 12))
     ON CONFLICT (token_hash) DO UPDATE SET
       token_enc = EXCLUDED.token_enc,
       user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id,
       bot_username = EXCLUDED.bot_username, enabled = true,
       pair_code = coalesce(${S}.telegram_bots.pair_code, EXCLUDED.pair_code)
     RETURNING token_hash, token_enc, user_id, agent_id, bot_username, chat_id, pair_code`,
    [hash, enc, userId, agentId, botUsername || ''],
  );
  return tgRow(rows[0]);
}

// All active bots (to bring up the pollers at boot).
export async function listEnabledTelegramBots() {
  const { rows } = await pool.query(
    `SELECT token_hash, token_enc, user_id, agent_id, bot_username, chat_id, last_update_id FROM ${S}.telegram_bots WHERE enabled = true`,
  );
  return tgRows(rows);
}

export async function getTelegramBot(token) {
  const { rows } = await pool.query(`SELECT * FROM ${S}.telegram_bots WHERE token_hash IN ($1,$2)`, tgKeys(token));
  return rows[0] ? tgRow(rows[0]) : null;
}

// The user's bot (to show status in the UI). Legacy: the user's first (oldest)
// bot. Kept for compatibility; the UI now lists ALL of them via
// listTelegramBotsForUser (one bot per agent).
export async function getTelegramBotForUser(userId) {
  const { rows } = await pool.query(
    `SELECT token_hash, token_enc, agent_id, bot_username, chat_id, enabled, pair_code FROM ${S}.telegram_bots WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [userId],
  );
  return rows[0] ? tgRow(rows[0]) : null;
}

// Bot for proactive DELIVERY (reminder/routine/video): prefers the bot bound to the
// agent that's delivering; if that agent doesn't have its own bot, falls back to the
// user's first bot (compat with whoever has a single bot serving several
// agents). This way, with one bot per agent the message goes out in the right chat, and the
// single-bot case keeps working for all agents.
export async function getTelegramBotForDelivery(userId, agentId) {
  if (agentId) {
    const { rows } = await pool.query(
      `SELECT token_hash, token_enc, agent_id, bot_username, chat_id, enabled FROM ${S}.telegram_bots
         WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at ASC LIMIT 1`,
      [userId, agentId],
    );
    if (rows[0]) return tgRow(rows[0]);
  }
  return getTelegramBotForUser(userId);
}

// ALL of the user's bots (one per agent). One BotFather token = one bot.
export async function listTelegramBotsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT token_hash, token_enc, agent_id, bot_username, chat_id, enabled, pair_code FROM ${S}.telegram_bots WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  return tgRows(rows);
}

// Deletes ONE user's bot by token, with an ownership check (doesn't let you delete
// another owner's bot just by knowing the token). Accepts the plain-text token or the hash (which is
// what the screen sends today). Returns the deleted record or null.
export async function deleteTelegramBotOwned(userId, token) {
  const [hash, raw] = tgKeys(token);
  const { rows } = await pool.query(
    `DELETE FROM ${S}.telegram_bots WHERE user_id = $1 AND token_hash IN ($2,$3) RETURNING token_hash, token_enc`,
    [userId, hash, raw],
  );
  if (!rows[0]) return null;
  try { return tgRow(rows[0]); } catch { return { token_hash: rows[0].token_hash, token: null }; }
}

// Amarra o chat_id no primeiro /start.
export async function bindTelegramChat(token, chatId) {
  const [hash, raw] = tgKeys(token);
  await pool.query(`UPDATE ${S}.telegram_bots SET chat_id = $3 WHERE token_hash IN ($1,$2)`, [hash, raw, String(chatId)]);
}

// Confirms the last handled update_id (the poller resumes from here after a restart).
// greatest() guards against out-of-order writes.
export async function setTelegramOffset(token, updateId) {
  const [hash, raw] = tgKeys(token);
  await pool.query(
    `UPDATE ${S}.telegram_bots SET last_update_id = greatest(last_update_id, $3) WHERE token_hash IN ($1,$2)`,
    [hash, raw, Number(updateId) || 0],
  );
}

export async function deleteTelegramBot(token) {
  const [hash, raw] = tgKeys(token);
  await pool.query(`DELETE FROM ${S}.telegram_bots WHERE token_hash IN ($1,$2)`, [hash, raw]);
}

// ── Connector secrets backfill ──
// Moves what was left in plain text in the DB (Telegram bot token, MCP headers,
// OAuth token) into the vault-encrypted columns. A payment webhook authToken,
// if any, is migrated by the plugin that owns it.
// Idempotent: only touches rows not yet migrated. Runs at boot AFTER
// initVault() (initDb runs before it, so it can't happen in there).
export async function migrateConnectorSecrets() {
  const out = { telegram: 0, mcp: 0, oauth: 0, skipped: false };
  // With no key loaded, encrypting is impossible and saving in plain text is exactly what
  // we're fixing: does nothing and lets the boot alarm speak up.
  if (!vaultEnabled()) { out.skipped = true; return out; }

  const tg = await pool.query(`SELECT token_hash FROM ${S}.telegram_bots WHERE token_enc IS NULL`);
  for (const r of tg.rows) {
    const raw = r.token_hash;
    await pool.query(
      `UPDATE ${S}.telegram_bots SET token_hash = $2, token_enc = $3 WHERE token_hash = $1`,
      [raw, tgHash(raw), encryptSecret(raw)],
    );
    out.telegram++;
  }

  const mcp = await pool.query(
    `SELECT id, headers FROM ${S}.mcp_servers WHERE headers_enc IS NULL AND headers IS NOT NULL AND headers::text NOT IN ('{}','null')`,
  );
  for (const r of mcp.rows) {
    await pool.query(
      `UPDATE ${S}.mcp_servers SET headers_enc = $2, headers = '{}'::jsonb WHERE id = $1`,
      [r.id, encryptSecret(JSON.stringify(r.headers))],
    );
    out.mcp++;
  }

  // OAuth: a plain-text token was left over from before the column entered the vault (found when
  // checking the production database: 2 GitHub access_tokens from July). Reading
  // is already tolerant (decMaybe), so encrypting here is transparent.
  const oa = await pool.query(
    `SELECT user_id, provider, access_token, refresh_token FROM ${S}.oauth_tokens
       WHERE (access_token IS NOT NULL AND access_token <> '' AND access_token NOT LIKE 'v1:%')
          OR (refresh_token IS NOT NULL AND refresh_token <> '' AND refresh_token NOT LIKE 'v1:%')`,
  );
  for (const r of oa.rows) {
    const at = r.access_token && !String(r.access_token).startsWith('v1:') ? encryptSecret(r.access_token) : r.access_token;
    const rt = r.refresh_token && !String(r.refresh_token).startsWith('v1:') ? encryptSecret(r.refresh_token) : r.refresh_token;
    await pool.query(
      `UPDATE ${S}.oauth_tokens SET access_token = $3, refresh_token = $4 WHERE user_id = $1 AND provider = $2`,
      [r.user_id, r.provider, at, rt],
    );
    out.oauth++;
  }

  return out;
}

// ── WhatsApp channel (phone -> user + active agent) ──
// Phone always in digits (E.164 without '+'), same as the `from` Meta sends.
// BR: Meta (Cloud API) sometimes sends 'from' WITHOUT the 9th digit of the cell phone.
// Generates the variants (with/without the 9) to match what the user registered.
function waPhoneVariants(phone) {
  const p = String(phone || '');
  const out = new Set([p]);
  if (p.startsWith('55')) {
    if (p.length === 13) out.add(p.slice(0, 4) + p.slice(5));        // remove o 9
    else if (p.length === 12) out.add(p.slice(0, 4) + '9' + p.slice(4)); // insere o 9
  }
  return [...out];
}

export async function getWhatsAppLink(phone) {
  const cands = waPhoneVariants(phone);
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.whatsapp_links WHERE wa_phone = ANY($1::text[])`,
    [cands],
  );
  if (!rows.length) return null;
  return rows.find((r) => r.wa_phone === phone) || rows[0];
}

// Stamps "the person just talked to me on WhatsApp". Called in the inbound
// webhook, BEFORE any routing, so it also applies to a message that lands
// on the menu or on unsupported media (from Meta's standpoint, any inbound
// reopens the 24h window). Matches with/without the 9th digit.
export async function touchWaInbound(phone) {
  try {
    await pool.query(
      `UPDATE ${S}.whatsapp_links SET last_inbound_at = now() WHERE wa_phone = ANY($1::text[])`,
      [waPhoneVariants(phone)],
    );
  } catch (e) { console.error('[db] touchWaInbound:', e?.message ?? e); }
}

// When that phone's last inbound was (null = never). Used by proactive sending
// to decide session vs. template BEFORE calling Meta. PROPAGATES errors on
// purpose: the caller distinguishes "I know the window closed" (null) from "couldn't
// tell" (exception), and in the second case keeps the old behavior instead of
// flattening everyone's formatting because of a database hiccup.
export async function getWaLastInbound(phone) {
  const { rows } = await pool.query(
    `SELECT max(last_inbound_at) AS at FROM ${S}.whatsapp_links WHERE wa_phone = ANY($1::text[])`,
    [waPhoneVariants(phone)],
  );
  return rows[0]?.at || null;
}

// Aggregated WhatsApp delivery failures (/metrics panel). Joins Meta's
// status with the person who owns the number (matching with/without the 9th digit).
export async function listWaFailures({ days = 7 } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const { rows } = await pool.query(
    `SELECT s.recipient, s.error_code, coalesce(s.error_title,'') AS error_title,
            count(*)::int AS falhas, max(s.updated_at) AS ultima,
            u.id AS user_id, u.name, u.email
       FROM ${S}.wa_message_status s
       LEFT JOIN ${S}.whatsapp_links w ON right(w.wa_phone, 8) = right(s.recipient, 8)
       LEFT JOIN ${S}.users u ON u.id = w.user_id
      WHERE s.status = 'failed' AND s.updated_at > now() - ($1 || ' days')::interval
      GROUP BY s.recipient, s.error_code, s.error_title, u.id, u.name, u.email
      ORDER BY max(s.updated_at) DESC
      LIMIT 200`,
    [String(n)],
  );
  return rows;
}

// User's link (to show status in the UI).
// `last_inbound_at` comes along because whoever delivers a campaign (lifecycle-deliver.mjs)
// needs to know BEFORE sending whether the 24h window is open: inside it the Cloud
// API accepts a session message, which preserves line breaks and lists.
export async function getWhatsAppLinkForUser(userId) {
  const { rows } = await pool.query(
    `SELECT wa_phone, active_agent_id, enabled, last_inbound_at FROM ${S}.whatsapp_links WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

// Binds (or re-binds) a phone to a user, with an optional active agent.
// `verified` = ownership of the number WAS proven just now (inbound from that phone with
// the challenge code). Without this, a phone that already belongs to another account NEVER changes
// owner: before, ON CONFLICT reassigned the user_id on the word of whoever typed it, so
// it was enough to enter someone else's number to start receiving their inbound.
// The check covers both spellings of a BR cell phone (with and without the 9th digit), which is
// how the inbound is resolved (waPhoneVariants).
export async function upsertWhatsAppLink({ phone, userId, activeAgentId, verified = false }) {
  const cands = waPhoneVariants(phone);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: atuais } = await c.query(
      `SELECT wa_phone, user_id FROM ${S}.whatsapp_links WHERE wa_phone = ANY($1::text[]) FOR UPDATE`,
      [cands],
    );
    const deOutro = atuais.filter((r) => String(r.user_id) !== String(userId));
    if (deOutro.length && !verified) {
      await c.query('ROLLBACK');
      throw Object.assign(Error('Esse número já está conectado a outra conta.'), { code: 'WA_PHONE_TAKEN' });
    }
    // Proven ownership: the number now belongs to this account and leaves the others, including
    // the with/without 9th digit variant (otherwise the inbound would be ambiguous).
    if (deOutro.length) {
      await c.query(`DELETE FROM ${S}.whatsapp_links WHERE wa_phone = ANY($1::text[]) AND user_id <> $2`, [cands, userId]);
    }
    const { rows } = await c.query(
      `INSERT INTO ${S}.whatsapp_links (wa_phone, user_id, active_agent_id, enabled)
         VALUES ($1,$2,$3,true)
       ON CONFLICT (wa_phone) DO UPDATE SET
         user_id = EXCLUDED.user_id, active_agent_id = EXCLUDED.active_agent_id, enabled = true
       RETURNING wa_phone, user_id, active_agent_id, enabled`,
      [phone, userId, activeAgentId || null],
    );
    await c.query('COMMIT');
    return rows[0];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// Creates (or renews) the ownership challenge for a number. Binds NOTHING: just
// stores the intent + the code the person will send from their WhatsApp to the
// platform's number. Sends no message to the given number, on purpose: otherwise
// the challenge itself would become a spam tool against someone else's phone.
export async function createWaClaim({ phone, userId, activeAgentId = null, code, ttlMin = 30 }) {
  await pool.query(`DELETE FROM ${S}.wa_claims WHERE expires_at < now()`).catch(() => {});
  const { rows } = await pool.query(
    `INSERT INTO ${S}.wa_claims (wa_phone, user_id, active_agent_id, code, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)
     ON CONFLICT (wa_phone, user_id) DO UPDATE SET
       active_agent_id = EXCLUDED.active_agent_id, code = EXCLUDED.code,
       expires_at = EXCLUDED.expires_at, created_at = now()
     RETURNING wa_phone, code, expires_at`,
    [phone, userId, activeAgentId, code, String(ttlMin)],
  );
  return rows[0];
}

// Closes the challenge: a text arrived FROM THAT phone containing the code. It's the only
// path that binds a number to an account. Returns null when there's no matching
// challenge (then the caller proceeds with the normal inbound response).
export async function consumeWaClaim(phone, text) {
  const digitado = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (digitado.length < 8) return null;
  const cands = waPhoneVariants(phone);
  const { rows } = await pool.query(
    `DELETE FROM ${S}.wa_claims
      WHERE wa_phone = ANY($1::text[]) AND expires_at > now() AND position(code in $2::text) > 0
      RETURNING user_id, active_agent_id`,
    [cands, digitado],
  );
  const claim = rows[0];
  if (!claim) return null;
  // The remaining pending challenges for that number die along with it: the phone just
  // chose its account.
  await pool.query(`DELETE FROM ${S}.wa_claims WHERE wa_phone = ANY($1::text[])`, [cands]).catch(() => {});
  const link = await upsertWhatsAppLink({
    phone, userId: claim.user_id, activeAgentId: claim.active_agent_id, verified: true,
  });
  // A pessoa acabou de escrever: a janela de 24h abre a partir de agora.
  await touchWaInbound(phone);
  return { userId: claim.user_id, link };
}

// Switches the active agent for that phone (sticky across messages).
export async function setWhatsAppActiveAgent(phone, agentId) {
  await pool.query(`UPDATE ${S}.whatsapp_links SET active_agent_id = $2 WHERE wa_phone = $1`, [phone, agentId]);
}

export async function deleteWhatsAppLinkForUser(userId) {
  await pool.query(`DELETE FROM ${S}.whatsapp_links WHERE user_id = $1`, [userId]);
}

// Stores the text of a WhatsApp message by wamid, to later resolve
// quotes (WhatsApp's "reply"). Idempotent by wamid. Truncates the body
// (the goal is to give the model CONTEXT for the quote, not to archive the conversation).
export async function saveWaMsgRef({ wamid, userId = null, agentId = null, direction = 'in', body = '' }) {
  if (!wamid || !body) return;
  try {
    await pool.query(
      `INSERT INTO ${S}.whatsapp_msg_refs (wamid, user_id, agent_id, direction, body)
         VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (wamid) DO NOTHING`,
      [wamid, userId, agentId, direction, String(body).slice(0, 4000)],
    );
  } catch (e) { console.error('[db] saveWaMsgRef:', e?.message ?? e); }
}

// Claims a wamid for processing: returns true if it's the FIRST time we've
// seen this id, false if it's already been processed. It's the dedup for Meta's retries, and
// survives restart/deploy (the in-memory Set didn't survive: the retry arrived
// after the restart and the message got answered twice).
// On a database error, returns true (fail-open): better to risk a rare duplicate
// than to swallow the user's message because Postgres hiccupped.
export async function claimWaMsg(wamid) {
  if (!wamid) return true;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO ${S}.whatsapp_seen (wamid) VALUES ($1) ON CONFLICT (wamid) DO NOTHING`,
      [wamid],
    );
    return rowCount > 0;
  } catch (e) { console.error('[db] claimWaMsg:', e?.message ?? e); return true; }
}

// Pruning of the dedup table. Meta only redelivers for a few hours; we keep 7
// days of slack. Called by the server's periodic cleanup.
export async function pruneWaSeen(dias = 7) {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ${S}.whatsapp_seen WHERE created_at < now() - ($1 || ' days')::interval`,
      [String(dias)],
    );
    return rowCount;
  } catch (e) { console.error('[db] pruneWaSeen:', e?.message ?? e); return 0; }
}

// Resolves the text of a message quoted by wamid. Scoped to the user (the
// quote only makes sense inside their conversation). Returns null if not found
// (e.g.: a message predating this feature's deploy, which wasn't indexed).
export async function getWaMsgRef(wamid, userId = null) {
  if (!wamid) return null;
  const { rows } = await pool.query(
    `SELECT wamid, user_id, direction, body FROM ${S}.whatsapp_msg_refs
       WHERE wamid = $1 ${userId ? 'AND user_id = $2' : ''} LIMIT 1`,
    userId ? [wamid, userId] : [wamid],
  );
  return rows[0] || null;
}

// ── Slack channel (same pattern as WhatsApp, key = team + Slack user) ──
export async function getSlackLink(teamId, slackUserId) {
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.slack_links WHERE slack_team_id = $1 AND slack_user_id = $2`,
    [teamId, slackUserId],
  );
  return rows[0] || null;
}

// Binds (or rebinds) a Slack user to a platform user.
export async function upsertSlackLink({ teamId, slackUserId, userId, activeAgentId }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.slack_links (slack_team_id, slack_user_id, user_id, active_agent_id, enabled)
       VALUES ($1,$2,$3,$4,true)
     ON CONFLICT (slack_team_id, slack_user_id) DO UPDATE SET
       user_id = EXCLUDED.user_id, active_agent_id = EXCLUDED.active_agent_id, enabled = true
     RETURNING *`,
    [teamId, slackUserId, userId, activeAgentId || null],
  );
  return rows[0];
}

// Switches that Slack user's active agent (sticky between messages).
export async function setSlackActiveAgent(teamId, slackUserId, agentId) {
  await pool.query(
    `UPDATE ${S}.slack_links SET active_agent_id = $3 WHERE slack_team_id = $1 AND slack_user_id = $2`,
    [teamId, slackUserId, agentId],
  );
}

// ── Chrome extension: active assistant per USER (persisted) ──
// Which assistant serves the user's extension. null (or no row) => the caller
// falls back to the first assistant, same as the old in-memory default.
export async function getExtLink(userId) {
  const { rows } = await pool.query(
    `SELECT user_id, active_agent_id FROM ${S}.ext_links WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

// Pins (upsert) the assistant that serves that user's extension.
export async function setExtActiveAgent(userId, agentId) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.ext_links (user_id, active_agent_id) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET active_agent_id = EXCLUDED.active_agent_id
     RETURNING user_id, active_agent_id`,
    [userId, agentId || null],
  );
  return rows[0];
}

// ── Slack: link PER CHANNEL + pairing codes (main model) ──
// Which assistant serves a (team, channel). null if the channel hasn't been paired.
export async function getSlackChannelLink(teamId, channelId) {
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.slack_channel_links WHERE slack_team_id = $1 AND slack_channel_id = $2`,
    [teamId, channelId],
  );
  return rows[0] || null;
}

// Binds (or re-binds) a Slack channel to a specific assistant of the owner.
export async function upsertSlackChannelLink({ teamId, channelId, userId, agentId, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.slack_channel_links (slack_team_id, slack_channel_id, user_id, agent_id, created_by)
       VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (slack_team_id, slack_channel_id) DO UPDATE SET
       user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id,
       created_by = EXCLUDED.created_by, created_at = now()
     RETURNING *`,
    [teamId, channelId, userId, agentId, createdBy || null],
  );
  return rows[0];
}

// Undoes the channel's link ("disconnect" command).
export async function deleteSlackChannelLink(teamId, channelId) {
  await pool.query(
    `DELETE FROM ${S}.slack_channel_links WHERE slack_team_id = $1 AND slack_channel_id = $2`,
    [teamId, channelId],
  );
}

// Creates a pairing code (single use, expires in ttlMin minutes). The code itself
// comes ready-made from outside (generated with an unambiguous charset); here we just persist it.
export async function createSlackPairingCode({ userId, agentId, code, ttlMin = 15 }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.slack_pairing_codes (code, user_id, agent_id, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)
     RETURNING code, user_id, agent_id, expires_at`,
    [code, userId, agentId, String(ttlMin)],
  );
  return rows[0];
}

// Consumes the code: marks it used and returns {user_id, agent_id} if valid/not expired.
// Atomic (only the 1st call wins), so it protects against reuse.
export async function consumeSlackPairingCode(code) {
  const { rows } = await pool.query(
    `UPDATE ${S}.slack_pairing_codes SET used_at = now()
       WHERE code = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id, agent_id`,
    [code],
  );
  return rows[0] || null;
}

// ── Memory wiki (markdown pages per user) ──
// Normalizes a slug: lowercase, no accents, kebab-case, short.
// Exported because whoever builds the page (wiki.mjs) has to use EXACTLY the
// same rule as whoever writes it: if the two diverge, reading goes to one slug and
// writing to another, and the existing page gets overwritten from scratch (finding #18).
export function normWikiSlug(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'pagina';
}
const normSlug = normWikiSlug;

export async function listWikiPages(userId) {
  const { rows } = await pool.query(
    `SELECT slug, title, updated_at FROM ${S}.wiki_pages WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  );
  return rows;
}

// All pages with their body (the memory reconciler looks for the subject across all of them).
export async function listWikiPagesFull(userId) {
  const { rows } = await pool.query(
    `SELECT slug, title, body FROM ${S}.wiki_pages WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  );
  return rows;
}

export async function getWikiPage(userId, slug) {
  const { rows } = await pool.query(
    `SELECT slug, title, body, updated_at FROM ${S}.wiki_pages WHERE user_id = $1 AND slug = $2`,
    [userId, normSlug(slug)],
  );
  return rows[0] || null;
}

// Creates or replaces a page. Returns the normalized slug that was actually saved.
export async function upsertWikiPage(userId, { slug, title, body }) {
  const s = normSlug(slug || title);
  await pool.query(
    `INSERT INTO ${S}.wiki_pages (user_id, slug, title, body, updated_at)
       VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (user_id, slug) DO UPDATE SET
       title = EXCLUDED.title, body = EXCLUDED.body, updated_at = now()`,
    [userId, s, title || s, body || ''],
  );
  return s;
}

// Simple search (ilike on title+body) with a context snippet.
export async function searchWikiPages(userId, q) {
  const terms = wikiSearchTerms(q);
  if (!terms.length) return [];
  const predicates = terms.map((_, i) => `(title ILIKE $${i + 2} OR body ILIKE $${i + 2})`).join(' AND ');
  const { rows } = await pool.query(
    `SELECT slug, title, body FROM ${S}.wiki_pages
       WHERE user_id = $1 AND ${predicates}
       ORDER BY updated_at DESC LIMIT 8`,
    [userId, ...terms.map((term) => `%${term}%`)],
  );
  return rows.map((r) => ({ slug: r.slug, title: r.title, snippet: matchingWikiLineSnippet(r.body, q) }));
}

// Deletes a page from the user's memory. Returns true if it removed something.
export async function deleteWikiPage(userId, slug) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.wiki_pages WHERE user_id = $1 AND slug = $2`,
    [userId, normSlug(slug)],
  );
  return rowCount > 0;
}

// All facts, current and closed (memory search: closed ones are the history).
export async function listAllFacts(userId, { limit = 1000 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, pagina, assunto, valor, valido_desde, valido_ate, linha_pagina, criado_em FROM ${S}.memory_facts
       WHERE user_id = $1 ORDER BY criado_em DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function listCurrentFacts(userId, { limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, pagina, assunto, valor, valido_desde, linha_pagina, fonte, criado_em FROM ${S}.memory_facts
       WHERE user_id = $1 AND valido_ate IS NULL ORDER BY criado_em DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

// Saves the CURRENT fact for a subject. If one already exists with a different value, it's
// closed (valido_ate) and points to the new one (substituido_por), in a single transaction.
// Same value = only updates where the row is (page/line), without opening a new version.
export async function setFact(userId, { pagina, assunto, valor, desde = null, linha = '', fonte = {} }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [velho] } = await c.query(
      `SELECT id, valor FROM ${S}.memory_facts WHERE user_id=$1 AND assunto=$2 AND valido_ate IS NULL FOR UPDATE`,
      [userId, assunto]);
    const igual = velho && String(velho.valor).trim().toLowerCase() === String(valor).trim().toLowerCase();
    if (igual) {
      await c.query(`UPDATE ${S}.memory_facts SET pagina=$2, linha_pagina=$3, valido_desde=COALESCE($4::date, valido_desde) WHERE id=$1`,
        [velho.id, pagina, linha, desde]);
      await c.query('COMMIT');
      return { id: velho.id, igual: true };
    }
    if (velho) await c.query(`UPDATE ${S}.memory_facts SET valido_ate=now() WHERE id=$1`, [velho.id]);
    const { rows: [novo] } = await c.query(
      `INSERT INTO ${S}.memory_facts (user_id, pagina, assunto, valor, valido_desde, fonte, linha_pagina)
         VALUES ($1,$2,$3,$4,$5::date,$6::jsonb,$7) RETURNING id`,
      [userId, pagina, assunto, valor, desde, JSON.stringify(fonte || {}), linha]);
    if (velho) await c.query(`UPDATE ${S}.memory_facts SET substituido_por=$2 WHERE id=$1`, [velho.id, novo.id]);
    await c.query('COMMIT');
    return { id: novo.id, substituiu: velho?.id || null };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// The fact's row left the page (the owner asked to delete it): the fact stops being valid.
export async function closeFact(userId, id) {
  await pool.query(`UPDATE ${S}.memory_facts SET valido_ate=now() WHERE user_id=$1 AND id=$2 AND valido_ate IS NULL`, [userId, id]);
}

// A row that left the page (corrected or deleted) without belonging to any fact: becomes
// an ALREADY CLOSED fact, so the old version stays findable (history) instead of
// disappearing. Doesn't open a current fact, so it doesn't touch the context's key list.
export async function addHistorico(userId, { pagina, linha, valor, fonte = {} }) {
  await pool.query(
    `INSERT INTO ${S}.memory_facts (user_id, pagina, assunto, valor, valido_ate, fonte, linha_pagina)
       VALUES ($1,$2,'historico',$3,now(),$4::jsonb,$5)`,
    [userId, pagina, valor, JSON.stringify(fonte || {}), linha]);
}

// The fact's row changed (move/manually correct): tracks page, line and value.
export async function updateFactLine(userId, id, { pagina, linha, valor = null }) {
  await pool.query(`UPDATE ${S}.memory_facts SET pagina=$3, linha_pagina=$4, valor=COALESCE($5, valor) WHERE user_id=$1 AND id=$2`, [userId, id, pagina, linha, valor]);
}

// ── Memory ambiguities (memory_ambiguities) ──
// Opens an ambiguity. Idempotent: if this subject already had an ambiguity (open,
// resolved, or discarded), it does not open again, otherwise rerunning the
// migration would reopen what the owner already answered.
export async function addMemoryAmbiguity(userId, { assunto, motivo = '', opcoes = [], fonte = {} }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.memory_ambiguities (user_id, assunto, motivo, opcoes, fonte)
       SELECT $1,$2,$3,$4::jsonb,$5::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM ${S}.memory_ambiguities WHERE user_id=$1 AND assunto=$2)
     RETURNING id`,
    [userId, assunto, motivo, JSON.stringify(opcoes || []), JSON.stringify(fonte || {})]);
  return rows[0]?.id || null;
}

// userId null = all people (admin view), with name and the subject's current fact.
export async function listMemoryAmbiguities({ userId = null, status = 'aberta', limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.id, a.user_id, a.assunto, a.motivo, a.opcoes, a.status, a.resolucao, a.resolvido_por, a.desfazer,
            a.criado_em, a.resolvido_em, u.name AS nome, u.email,
            (SELECT f.valor FROM ${S}.memory_facts f WHERE f.user_id=a.user_id AND f.assunto=a.assunto AND f.valido_ate IS NULL LIMIT 1) AS fato_atual
       FROM ${S}.memory_ambiguities a JOIN ${S}.users u ON u.id = a.user_id
      WHERE ($1::uuid IS NULL OR a.user_id = $1) AND ($2::text IS NULL OR a.status = $2)
      ORDER BY a.criado_em DESC LIMIT $3`,
    [userId, status, limit]);
  return rows;
}

export async function getMemoryAmbiguity(id) {
  const { rows: [r] } = await pool.query(`SELECT * FROM ${S}.memory_ambiguities WHERE id=$1`, [id]);
  return r || null;
}

// Closes only if still open (two clicks/two ends do not close it twice).
export async function closeMemoryAmbiguity(id, { status, resolucao = null, por = null, desfazer = null }) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.memory_ambiguities SET status=$2, resolucao=$3, resolvido_por=$4, resolvido_em=now(), desfazer=$5::jsonb
      WHERE id=$1 AND status='aberta'`, [id, status, resolucao, por, desfazer ? JSON.stringify(desfazer) : null]);
  return rowCount > 0;
}

// Reopens the ambiguity (undo). Only if it is still closed the way it was read.
export async function reopenMemoryAmbiguity(id, statusAtual) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.memory_ambiguities SET status='aberta', resolucao=NULL, resolvido_por=NULL, resolvido_em=NULL, desfazer=NULL
      WHERE id=$1 AND status=$2`, [id, statusAtual]);
  return rowCount > 0;
}

// Undoes the fact swap of a resolution: ends the fact it opened and, if it
// had ended another one, restores its validity (only if the subject was left without a fact).
export async function revertFactSwap(userId, { novo = null, velho = null }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (novo) await c.query(`UPDATE ${S}.memory_facts SET valido_ate=now() WHERE user_id=$1 AND id=$2 AND valido_ate IS NULL`, [userId, novo]);
    if (velho) {
      await c.query(
        `UPDATE ${S}.memory_facts f SET valido_ate=NULL, substituido_por=NULL
          WHERE f.user_id=$1 AND f.id=$2
            AND NOT EXISTS (SELECT 1 FROM ${S}.memory_facts g WHERE g.user_id=f.user_id AND g.assunto=f.assunto AND g.valido_ate IS NULL)`,
        [userId, velho]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// Page copies are valid for 90 days: gives time to recover from a mistake without
// keeping forever what the person asked to forget.
export async function pruneWikiPageVersions(dias = 90) {
  const { rowCount } = await pool.query(`DELETE FROM ${S}.wiki_page_versions WHERE saved_at < now() - make_interval(days => $1)`, [dias]);
  return rowCount;
}

// ── Google connectors (OAuth tokens per user) ──
// Legacy getGoogleTokens = the user's PRIMARY account (compat with callers
// that still operate on "the user's account"). Routing by AGENT uses
// getGoogleAccount(userId, email) with agents.google_email.
export async function getGoogleTokens(userId) {
  return getPrimaryGoogleAccount(userId);
}

// ── Google multi-account (N accounts per user, link per agent) ──
function decAccountRow(row) {
  if (!row) return null;
  row.access_token = decMaybe(row.access_token);
  row.refresh_token = decMaybe(row.refresh_token);
  return row;
}

// Upsert of a user's Google account (key user_id+google_email). Preserves
// the old refresh_token when Google does not resend it. If it is the user's
// 1st account (or primary=true), marks it as primary and unmarks the others.
export async function saveGoogleAccount(userId, googleEmail, { access_token, refresh_token, scope, expiry }, { primary = false } = {}) {
  const email = String(googleEmail || '').toLowerCase();
  if (!email) throw new Error('google_email vazio');
  const { rows: cnt } = await pool.query(`SELECT count(*)::int AS n FROM ${S}.google_accounts WHERE user_id=$1`, [userId]);
  const makePrimary = primary || cnt[0].n === 0;
  await pool.query(
    `INSERT INTO ${S}.google_accounts (user_id, google_email, access_token, refresh_token, scope, expiry, is_primary, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (user_id, google_email) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, ${S}.google_accounts.refresh_token),
       scope         = EXCLUDED.scope,
       expiry        = EXCLUDED.expiry,
       is_primary    = ${S}.google_accounts.is_primary OR EXCLUDED.is_primary,
       updated_at    = now()`,
    [userId, email, encMaybe(access_token || null), encMaybe(refresh_token || null), scope || '', expiry || null, makePrimary],
  );
  if (makePrimary) await setPrimaryGoogleAccount(userId, email);
  return email;
}

// Refresh of ONE specific account (multi-account). This is the right path when the
// assistant is tied to an account that is not the primary one: without this, the
// renewed token from the work account would be written over the primary account
// (saveGoogleTokens writes where is_primary=true), corrupting both.
export async function saveGoogleAccountTokens(userId, googleEmail, { access_token, refresh_token, scope, expiry }) {
  const email = String(googleEmail || '').toLowerCase();
  if (!email) return 0;
  const r = await pool.query(
    `UPDATE ${S}.google_accounts SET
       access_token = $3,
       refresh_token = COALESCE($4, refresh_token),
       scope = $5, expiry = $6, updated_at = now()
     WHERE user_id = $1 AND google_email = $2`,
    [userId, email, encMaybe(access_token || null), encMaybe(refresh_token || null), scope || '', expiry || null],
  );
  return r.rowCount;
}

// Clears the credentials of ONE account (invalid_grant on that account). Keeps the
// row and the agents' link: reconnecting that email redoes everything, and the
// assistant tied to it keeps asking for reconnection OF IT, without silently
// falling back into another account's inbox.
export async function clearGoogleAccount(userId, googleEmail) {
  const email = String(googleEmail || '').toLowerCase();
  if (!email) return 0;
  const r = await pool.query(
    `UPDATE ${S}.google_accounts SET access_token = NULL, refresh_token = NULL, scope = '', expiry = NULL, updated_at = now()
      WHERE user_id = $1 AND google_email = $2`,
    [userId, email],
  );
  return r.rowCount;
}

// Compat: the refresh path updates the user's PRIMARY account.
export async function saveGoogleTokens(userId, { access_token, refresh_token, scope, expiry }) {
  const r = await pool.query(
    `UPDATE ${S}.google_accounts SET
       access_token = $2,
       refresh_token = COALESCE($3, refresh_token),
       scope = $4, expiry = $5, updated_at = now()
     WHERE user_id = $1 AND is_primary = true`,
    [userId, encMaybe(access_token || null), encMaybe(refresh_token || null), scope || '', expiry || null],
  );
  return r.rowCount;
}

// Clears the credentials of the PRIMARY account when Google returns invalid_grant
// (dead refresh_token). Clears token+scope+expiry so the app treats it as
// disconnected (caps disappear → the assistant stops trying and asks for reconnection).
// Keeps the row/email and the agents' link; reconnecting redoes everything.
export async function clearGooglePrimary(userId) {
  const r = await pool.query(
    `UPDATE ${S}.google_accounts SET access_token = NULL, refresh_token = NULL, scope = '', expiry = NULL, updated_at = now()
      WHERE user_id = $1 AND is_primary = true`,
    [userId],
  );
  return r.rowCount;
}

export async function listGoogleAccounts(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.google_accounts WHERE user_id=$1 ORDER BY is_primary DESC, updated_at DESC`, [userId]);
  return rows.map(decAccountRow);
}

export async function getGoogleAccount(userId, googleEmail) {
  const email = String(googleEmail || '').toLowerCase();
  if (!email) return null;
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.google_accounts WHERE user_id=$1 AND google_email=$2`, [userId, email]);
  return decAccountRow(rows[0] || null);
}

export async function getPrimaryGoogleAccount(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM ${S}.google_accounts WHERE user_id=$1 ORDER BY is_primary DESC, updated_at DESC LIMIT 1`, [userId]);
  return decAccountRow(rows[0] || null);
}

export async function setPrimaryGoogleAccount(userId, googleEmail) {
  const email = String(googleEmail || '').toLowerCase();
  await pool.query(
    `UPDATE ${S}.google_accounts SET is_primary = (google_email = $2), updated_at = CASE WHEN google_email=$2 THEN now() ELSE updated_at END WHERE user_id=$1`,
    [userId, email]);
}

export async function removeGoogleAccount(userId, googleEmail) {
  const email = String(googleEmail || '').toLowerCase();
  const { rows } = await pool.query(
    `DELETE FROM ${S}.google_accounts WHERE user_id=$1 AND google_email=$2 RETURNING is_primary`, [userId, email]);
  // unlinks the agents that pointed to this account (they fall back to the primary one)
  await pool.query(`UPDATE ${S}.agents SET google_email = NULL WHERE user_id=$1 AND google_email=$2`, [userId, email]);
  // se apagou a principal e sobrou conta, promove a mais recente
  if (rows[0]?.is_primary) {
    const { rows: next } = await pool.query(
      `SELECT google_email FROM ${S}.google_accounts WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1`, [userId]);
    if (next[0]) await setPrimaryGoogleAccount(userId, next[0].google_email);
  }
  return rows.length > 0;
}

// ── Users / sessions ──
// A new account is born with only name, email and password. What the installer
// gives a new account (e.g. a free first month) comes via the conta_criada event.
export async function createUser({ name, email, passwordHash }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.users (name, email, password_hash)
     VALUES ($1,$2,$3) RETURNING id, name, email`,
    [name, email, passwordHash],
  );
  return rows[0];
}

export async function getUserByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM ${S}.users WHERE email = $1`, [email]);
  return rows[0] || null;
}

// Apple identity. Looks up by `sub`, not by email, because the relay email
// can change (the person turns off forwarding and Apple issues another one);
// `sub` never changes.
export async function getUserByAppleSub(sub) {
  const { rows } = await pool.query(`SELECT * FROM ${S}.users WHERE apple_sub = $1`, [sub]);
  return rows[0] || null;
}

// Reads the Apple refresh token. Exists separately on purpose: getUserById
// is the credit query, used throughout the turn, and third-party credentials
// should not travel along with it. The only caller is account deletion.
export async function getAppleRefreshToken(userId) {
  const { rows } = await pool.query(
    `SELECT apple_refresh_token FROM ${S}.users WHERE id = $1`, [userId],
  );
  return rows[0]?.apple_refresh_token || null;
}

// Links the Apple ID to an existing account. Only fills in what came through: Apple
// sends the refresh token only once, and a later login without it must not
// erase what we already stored (otherwise revocation on deletion stops working).
export async function linkAppleAccount(userId, { sub, refreshToken = null, privateEmail = false }) {
  await pool.query(
    `UPDATE ${S}.users
        SET apple_sub = $2,
            apple_refresh_token = COALESCE($3, apple_refresh_token),
            apple_private_email = $4
      WHERE id = $1`,
    [userId, sub, refreshToken, !!privateEmail],
  );
}

// Unlinks the Apple ID. Clears the refresh token along with it: it only serves to
// revoke access, and keeping the credential of a link that no longer exists is
// risky clutter. Whoever unlinks goes back to signing in with email/password or Google.
export async function unlinkAppleAccount(userId) {
  await pool.query(
    `UPDATE ${S}.users
        SET apple_sub = NULL,
            apple_refresh_token = NULL,
            apple_private_email = false
      WHERE id = $1`,
    [userId],
  );
}

// Session: 30-day absolute expiration + 14-day idle timeout (sliding).
// getUserBySession renews last_seen on every valid request.
const SESSION_MAX_DAYS = 30;
const SESSION_IDLE_DAYS = 14;

export async function createSession(token, userId) {
  await pool.query(
    `INSERT INTO ${S}.sessions (token, user_id, expires_at, last_seen_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, now())`,
    [token, userId, String(SESSION_MAX_DAYS)],
  );
}

// ── Password reset ──
// Creates a reset token that expires in `ttlMin` minutes (default 60).
export async function createPasswordReset(token, userId, ttlMin = 60) {
  await pool.query(
    `INSERT INTO ${S}.password_resets (token, user_id, expires_at)
     VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`,
    [token, userId, String(ttlMin)],
  );
}

// Returns {token,user_id} if the token exists, was NOT used and has NOT expired; otherwise null.
export async function getValidPasswordReset(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT token, user_id FROM ${S}.password_resets
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()`,
    [token],
  );
  return rows[0] || null;
}

// Marks the token as used (single use).
export async function markPasswordResetUsed(token) {
  await pool.query(`UPDATE ${S}.password_resets SET used_at = now() WHERE token = $1`, [token]);
}

// Changes the user's password and invalidates ANY pending reset of theirs.
export async function updateUserPassword(userId, passwordHash) {
  await pool.query(`UPDATE ${S}.users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
  await pool.query(
    `UPDATE ${S}.password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  // Rotation: invalidates all of the user's open sessions after a password change.
  await pool.query(`DELETE FROM ${S}.sessions WHERE user_id = $1`, [userId]);
}

export async function deleteSession(token) {
  await pool.query(`DELETE FROM ${S}.sessions WHERE token = $1`, [token]);
}

// ── Account deletion requested by the owner ──
// 30-day model: CLOSE now, DESTROY later. closeUserAccount closes; the
// purge (called by the daily job) destroys. The two halves are separated on
// purpose: closing has to be instantaneous and complete from an access
// standpoint, destroying has to be reversible for 30 days.
//
// What closeUserAccount does, all in the same transaction:
//   • deleted_at = now(): no new session resolves (see getUserBySession) and
//     login (password and Google) is refused from then on.
//   • deletes EVERY open session: logs out web and app, on any device.
//   • deletes the CHANNEL LINKS (WhatsApp, Telegram, Slack, external, push,
//     device, agent webhook): a message arriving through these channels no
//     longer finds an owner, so the assistant stops responding right away. Without
//     this, `deleted_at` would close nothing beyond login: channels do not use sessions.
//   • deletes THIRD-PARTY CREDENTIALS (Google, OAuth, API key, MCP): data
//     processing on the external service ceases immediately, which is the
//     whole point under LGPD. No live token of ours is left waiting for the purge.
//   • turns off routines and cancels pending reminders: nothing fires on its own.
//   • cuts off email (transactional and marketing): nothing goes out to this person.
//
// What it does NOT do: delete content (conversations, memory, files,
// assistants, feed). That is exactly what the 30-day window preserves.
// It also does not talk to Stripe: a network call does not belong inside a
// database transaction, so the caller cancels the subscription beforehand (see /api/account/delete).
//
// Accepted consequence: recovering within the 30 days restores the CONTENT, but the
// person has to reconnect channels and integrations by hand. We prefer this over leaving a
// live Gmail refresh_token on an account that asked to be deleted.
export async function closeUserAccount(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE ${S}.users SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, email, deleted_at`,
      [userId],
    );
    // Was already closed (double click, app retry): redoes nothing and does not
    // touch deleted_at, otherwise the 30-day window would restart on every touch.
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    for (const sql of [
      `DELETE FROM ${S}.checkout_pix_records WHERE user_id = $1`,
      `DELETE FROM ${S}.sessions            WHERE user_id = $1`,
      `DELETE FROM ${S}.whatsapp_links      WHERE user_id = $1`,
      `DELETE FROM ${S}.slack_links         WHERE user_id = $1`,
      `DELETE FROM ${S}.slack_channel_links WHERE user_id = $1`,
      `DELETE FROM ${S}.slack_pairing_codes WHERE user_id = $1`,
      `DELETE FROM ${S}.telegram_bots       WHERE user_id = $1`,
      `DELETE FROM ${S}.ext_links           WHERE user_id = $1`,
      `DELETE FROM ${S}.agent_webhooks      WHERE user_id = $1`,
      `DELETE FROM ${S}.device_tokens       WHERE user_id = $1`,
      `DELETE FROM ${S}.push_tokens         WHERE user_id = $1`,
      `DELETE FROM ${S}.google_tokens       WHERE user_id = $1`,
      `DELETE FROM ${S}.google_accounts     WHERE user_id = $1`,
      `DELETE FROM ${S}.oauth_tokens        WHERE user_id = $1`,
      `DELETE FROM ${S}.connections         WHERE user_id = $1`,
      `DELETE FROM ${S}.mcp_servers         WHERE user_id = $1`,
      `UPDATE ${S}.routines SET enabled = false WHERE user_id = $1`,
      `UPDATE ${S}.reminders SET status = 'canceled'
        WHERE user_id = $1 AND status = 'pending'`,
      // Access the person GAVE and access the person HAD both end here. Without
      // this, the assistant on the other side would keep sending requests to a
      // closed account, and a collaborator would keep entering the instance (same data)
      // of someone who asked to leave. No content is deleted: the connection just changes
      // state, and the roster is a link, not data. Going back within the 30 days,
      // the connection and invite are redone by hand, just like channel and integration.
      `UPDATE ${S}.agent_connections SET status = 'declined', updated_at = now()
        WHERE (user_a = $1 OR user_b = $1) AND status <> 'declined'`,
      `DELETE FROM ${S}.app_collab WHERE collab_user_id = $1`,
      `DELETE FROM ${S}.app_collab WHERE owner_user_id = $1`,
      `DELETE FROM ${S}.space_members WHERE user_id = $1`,
      `DELETE FROM ${S}.space_members m
        USING ${S}.spaces s WHERE s.id = m.space_id AND s.owner_user_id = $1`,
      `UPDATE ${S}.users
          SET email_send_enabled = false, email_optout = true,
              email_optout_at = COALESCE(email_optout_at, now()),
              -- mesma regra do refresh_token do Gmail: credencial de terceiro
              -- não fica viva em conta fechada. Quem chama já usou este token
              -- pra revogar na Apple antes de chegar aqui.
              apple_refresh_token = NULL
        WHERE id = $1`,
    ]) await client.query(sql, [userId]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Accounts closed for more than `days` days, ready for destruction. Whatever the
// deployment needs to end beforehand (in the cloud, the Stripe billing) it does
// via the exclusao_final event, with the account id.
export async function listUsersPurgeDue(days = 30, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, email, deleted_at
       FROM ${S}.users
      WHERE deleted_at IS NOT NULL
        AND deleted_at < now() - ($1 || ' days')::interval
      ORDER BY deleted_at
      LIMIT $2`,
    [String(days), limit],
  );
  return rows;
}

// Every S3 key that belongs to this user. Exists because Postgres's ON DELETE
// CASCADE deletes the ROW, not the object in the bucket: without this collection the
// file (including face and voice) would be left orphaned in S3 after the purge.
// Source of the keys: media library, likeness (anchor/document/voice/speech/
// extra faces), and generated videos.
export async function collectUserAssetKeys(userId) {
  const keys = [];
  const push = (v) => { if (v && typeof v === 'string') keys.push(v); };
  const media = await pool.query(
    `SELECT s3_key FROM ${S}.media_assets WHERE user_id = $1`, [userId]);
  for (const r of media.rows) push(r.s3_key);
  const lk = await pool.query(
    `SELECT anchor_key, document_key, voice_key, speech_key, face2_key, face3_key
       FROM ${S}.user_likeness WHERE user_id = $1`, [userId]);
  for (const r of lk.rows) for (const v of Object.values(r)) push(v);
  const vj = await pool.query(
    `SELECT video_key FROM ${S}.video_jobs WHERE user_id = $1`, [userId]);
  for (const r of vj.rows) push(r.video_key);
  return [...new Set(keys)];
}

// Final destruction. A single DELETE: the ~60 tables linked to users.id have
// ON DELETE CASCADE, so conversations, memory, assistants, routines, feed, and
// tokens go away with it. The few with ON DELETE SET NULL (usage/credit,
// error telemetry, feedback, processed email) are left WITHOUT an owner, i.e.
// anonymized: that is what sustains the billing history and metrics without
// keeping personal data. Only call AFTER deleting the S3 keys.
export async function hardDeleteUser(userId) {
  const { rowCount } = await pool.query(`DELETE FROM ${S}.users WHERE id = $1`, [userId]);
  return rowCount > 0;
}

// ── Inbound webhook per agent ──
// The token is the external system's secret; we only store the hash (sha256) and a
// short prefix to display. Generating/regenerating overwrites the token (upsert per agent).
const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

// Creates/regenerates the agent's webhook token. Receives the token ALREADY generated (raw) and
// returns the record (without the raw value). The caller shows the raw value once and does not store it.
export async function setAgentWebhookToken(agentId, userId, token) {
  const th = hashToken(token);
  const hint = String(token).slice(0, 8);
  const { rows } = await pool.query(
    `INSERT INTO ${S}.agent_webhooks (agent_id, user_id, token_hash, token_hint, enabled)
     VALUES ($1,$2,$3,$4,true)
     ON CONFLICT (agent_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, token_hint = EXCLUDED.token_hint,
           enabled = true, user_id = EXCLUDED.user_id
     RETURNING agent_id, user_id, token_hint, enabled, call_count, created_at, last_used_at`,
    [agentId, userId, th, hint],
  );
  return rows[0];
}

// Agent webhook state (without the token). null if never created.
export async function getAgentWebhook(agentId, userId) {
  const { rows } = await pool.query(
    `SELECT agent_id, user_id, token_hint, enabled, call_count, created_at, last_used_at
       FROM ${S}.agent_webhooks WHERE agent_id = $1 AND user_id = $2`,
    [agentId, userId],
  );
  return rows[0] || null;
}

export async function setAgentWebhookEnabled(agentId, userId, enabled) {
  await pool.query(
    `UPDATE ${S}.agent_webhooks SET enabled = $3 WHERE agent_id = $1 AND user_id = $2`,
    [agentId, userId, !!enabled],
  );
}

// Resolves a raw token -> {agent_id, user_id} if it exists and is active; otherwise null.
// Idempotent bump of call_count/last_used_at in the same statement.
export async function resolveWebhookToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `UPDATE ${S}.agent_webhooks
        SET call_count = call_count + 1, last_used_at = now()
      WHERE token_hash = $1 AND enabled = true
      RETURNING agent_id, user_id`,
    [hashToken(token)],
  );
  return rows[0] || null;
}

// ── Device tokens (OS/desktop client channel) ──
// Same model as the agent webhook: the token is the secret, we keep only the hash.
// Difference: keyed per DEVICE (own id), tied to the user, N per user.

// Creates a device token. Receives the token ALREADY generated (raw) and returns the record
// (without the raw value). The caller shows the raw value a single time and does not store it.
export async function createDeviceToken(userId, label, token) {
  const th = hashToken(token);
  const hint = String(token).slice(0, 8);
  const { rows } = await pool.query(
    `INSERT INTO ${S}.device_tokens (user_id, token_hash, token_hint, label, enabled)
     VALUES ($1,$2,$3,$4,true)
     RETURNING id, user_id, token_hint, label, active_agent_id, enabled, call_count, created_at, last_used_at`,
    [userId, th, hint, String(label || '').slice(0, 80)],
  );
  return rows[0];
}

// Lists the user's devices (without the token). Ordered from newest.
export async function listDeviceTokens(userId) {
  const { rows } = await pool.query(
    `SELECT id, token_hint, label, active_agent_id, enabled, call_count, created_at, last_used_at
       FROM ${S}.device_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

// Enables/disables a device without deleting the token. Validates the owner.
export async function setDeviceTokenEnabled(id, userId, enabled) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.device_tokens SET enabled = $3 WHERE id = $1 AND user_id = $2`,
    [id, userId, !!enabled],
  );
  return rowCount > 0;
}

// Ties the active agent of a device (the OS can pin which assistant it talks to).
export async function setDeviceActiveAgent(id, userId, agentId) {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.device_tokens SET active_agent_id = $3 WHERE id = $1 AND user_id = $2`,
    [id, userId, agentId || null],
  );
  return rowCount > 0;
}

// Revokes (deletes) a device. Irreversible: the raw token is gone for good. Validates the owner.
export async function deleteDeviceToken(id, userId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${S}.device_tokens WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rowCount > 0;
}

// Resolves a raw token -> {id, user_id, active_agent_id} if it exists and is active;
// otherwise null. Idempotent bump of call_count/last_used_at in the same statement.
export async function resolveDeviceToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `UPDATE ${S}.device_tokens
        SET call_count = call_count + 1, last_used_at = now()
      WHERE token_hash = $1 AND enabled = true
      RETURNING id, user_id, active_agent_id`,
    [hashToken(token)],
  );
  return rows[0] || null;
}

// Resolves the session -> user. null if invalid, expired, or too idle.
// Renews last_seen (idle sliding) in the same statement when the session is valid.
// The `deleted_at IS NULL` check is defense in depth: closeUserAccount already deletes
// ALL of the owner's sessions, so this only catches a session created midway
// through. A closed account never resolves to a user, on any route.
export async function getUserBySession(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `WITH bumped AS (
       UPDATE ${S}.sessions SET last_seen_at = now()
       WHERE token = $1
         AND expires_at > now()
         AND last_seen_at > now() - ($2 || ' days')::interval
       RETURNING user_id
     )
     SELECT u.id, u.name, u.email, u.apple_sub, u.apple_private_email
     FROM bumped b JOIN ${S}.users u ON u.id = b.user_id
     WHERE u.deleted_at IS NULL`,
    [token, String(SESSION_IDLE_DAYS)],
  );
  return rows[0] || null;
}

// App owners (the users row + the label), to reconcile the host's disk quota.
// The XFS quota applies at the LABEL level (per user, not per app), which is why the list
// is by label. Only those who have an app are included: applying the quota creates the user's
// folder on the host, and it makes no sense to create a folder for someone who never published anything.
export async function listAppOwnersForQuota() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (a.label) u.*, a.label
       FROM ${S}.apps a JOIN ${S}.users u ON u.id = a.user_id
      WHERE a.label IS NOT NULL AND a.label <> ''
      ORDER BY a.label`,
  );
  return rows;
}

// The account by id. The core only knows name, email and dates; the distribution
// adds its own columns (e.g. a plugin's plan and billing columns) with
// registrarColunasDaConta, and they come in the same row. A closed list of
// names, never `*`: the row must not carry password_hash.
const COLUNAS_DA_CONTA = ['id', 'name', 'email', 'created_at', 'deleted_at'];
export function registrarColunasDaConta(colunas) {
  for (const c of colunas) {
    if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`coluna da conta inválida: ${c}`);
    if (!COLUNAS_DA_CONTA.includes(c)) COLUNAS_DA_CONTA.push(c);
  }
}
export async function getUserById(userId) {
  const { rows } = await pool.query(
    `SELECT ${COLUNAS_DA_CONTA.join(', ')} FROM ${S}.users WHERE id = $1`,
    [userId],
  );
  return rows[0] || null;
}

// ── AI training opt-out (only makes sense for paying users) ──
// Turns on the opt-out: opens a period. If already on, it is a no-op (ensured by a partial index).
export async function openOptOutPeriod(userId, source = 'user') {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.training_optout_periods (user_id, source)
     VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id, started_at`,
    [userId, source],
  );
  return rows[0] || null;
}

// Turns off: stamps the end of the current period. The span already covered remains
// covered forever. With no open period, it is a no-op.
export async function closeOptOutPeriod(userId, at = null) {
  const { rows } = await pool.query(
    `UPDATE ${S}.training_optout_periods SET ended_at = COALESCE($2, now())
      WHERE user_id = $1 AND ended_at IS NULL
      RETURNING id, started_at, ended_at`,
    [userId, at],
  );
  return rows[0] || null;
}

export async function isOptedOutNow(userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM ${S}.training_optout_periods
      WHERE user_id = $1 AND ended_at IS NULL LIMIT 1`,
    [userId],
  );
  return rows.length > 0;
}

export async function listOptOutPeriods(userId) {
  const { rows } = await pool.query(
    `SELECT id, started_at, ended_at, source
       FROM ${S}.training_optout_periods
      WHERE user_id = $1 ORDER BY started_at`,
    [userId],
  );
  return rows;
}

// ── Media preferences (per user) ──
// jsonb { image, stt, tts }: missing key = ON (default on). We only store
// what the user explicitly turned off (false).
export async function getUserMediaPrefs(userId) {
  const { rows } = await pool.query(`SELECT media_prefs FROM ${S}.users WHERE id = $1`, [userId]);
  const p = rows[0]?.media_prefs || {};
  return { image: p.image !== false, vision: p.vision !== false, stt: p.stt !== false, tts: p.tts !== false };
}

export async function setUserMediaPrefs(userId, prefs) {
  // Merges with what already exists; only accepts the known boolean keys.
  // image=generate image, vision=read/understand image, stt=transcribe audio, tts=reply in voice.
  const clean = {};
  for (const k of ['image', 'vision', 'stt', 'tts']) if (k in (prefs || {})) clean[k] = !!prefs[k];
  const { rows } = await pool.query(
    `UPDATE ${S}.users SET media_prefs = media_prefs || $2::jsonb WHERE id = $1 RETURNING media_prefs`,
    [userId, JSON.stringify(clean)],
  );
  const p = rows[0]?.media_prefs || {};
  return { image: p.image !== false, vision: p.vision !== false, stt: p.stt !== false, tts: p.tts !== false };
}

// ── User's timezone (IANA, e.g. "America/Sao_Paulo", "Europe/Zurich") ──
// null = not set; the backend falls back to the São Paulo default. Used to interpret
// "today/tomorrow" and to schedule events at the user's local wall-clock time.
export async function getUserTimezone(userId) {
  const { rows } = await pool.query(`SELECT timezone FROM ${S}.users WHERE id = $1`, [userId]);
  return rows[0]?.timezone || null;
}

export async function setUserTimezone(userId, tz) {
  // Validates it is a recognized IANA timezone before saving (avoids garbage from the model).
  if (!tz || typeof tz !== 'string') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch { return null; }
  const { rows } = await pool.query(
    `UPDATE ${S}.users SET timezone = $2 WHERE id = $1 RETURNING timezone`,
    [userId, tz],
  );
  return rows[0]?.timezone || null;
}

// ── User's language and country ──────────────────────────────────────────────────
// Pure logic (normalization, language list) lives in locale.mjs and is tested there.
// Only persistence lives here.

// Always returns a usable pair: language falls back to the default, country can be null
// (null = we don't know, and whoever decides country-based rules has to handle this, not
// silently assume Brazil).
export async function getUserLocale(userId) {
  const { rows } = await pool.query(`SELECT language, country FROM ${S}.users WHERE id = $1`, [userId]);
  return {
    language: normalizaIdioma(rows[0]?.language) || IDIOMA_PADRAO,
    country: normalizaPais(rows[0]?.country),
    // `definido` separates "chose/was stamped" from "is at the default because we
    // don't know". Without this the frontend would have no way to know whether it needs
    // to stamp it, since `language` never comes back empty.
    definido: !!normalizaIdioma(rows[0]?.language),
  };
}

export async function setUserLanguage(userId, lang) {
  const v = normalizaIdioma(lang);
  if (!v || !IDIOMAS_OK.includes(v)) return null;
  const { rows } = await pool.query(
    `UPDATE ${S}.users SET language = $2 WHERE id = $1 RETURNING language`,
    [userId, v],
  );
  return rows[0]?.language || null;
}

export async function setUserCountry(userId, country) {
  const v = normalizaPais(country);
  if (!v) return null;
  const { rows } = await pool.query(
    `UPDATE ${S}.users SET country = $2 WHERE id = $1 RETURNING country`,
    [userId, v],
  );
  return rows[0]?.country || null;
}

// Automatic stamp (browser or header), used at signup and first access.
// Only writes what is STILL empty: a machine guess never overwrites a
// person's choice. Same principle as attribution's first-touch.
export async function setUserLocaleIfEmpty(userId, { language, country } = {}) {
  const lang = normalizaIdioma(language);
  const pais = normalizaPais(country);
  const ok = lang && IDIOMAS_OK.includes(lang) ? lang : null;
  if (!ok && !pais) return { language: null, country: null };
  const { rows } = await pool.query(
    `UPDATE ${S}.users
        SET language = COALESCE(language, $2),
            country  = COALESCE(country,  $3)
      WHERE id = $1
      RETURNING language, country`,
    [userId, ok, pais],
  );
  return { language: rows[0]?.language || null, country: rows[0]?.country || null };
}

// ── Signup origin (campaign attribution) ──
// Records where the person came from. Two guards in the SQL itself, and they are the point:
//  1. `attribution IS NULL` = the first stamp wins (does not overwrite the
//     true origin when the person comes back through another ad later);
//  2. `created_at > now() - interval '2 hours'` = only stamps a FRESHLY-created account.
//     The parameter stays stored in the browser, which could belong to a veteran user;
//     without this guard a click on today's ad would become the "origin" of an
//     old account and the campaign report would start lying.
// Returns true only when it actually wrote something (the frontend does not need to know why).
export async function setUserAttribution(userId, attr) {
  if (!userId || !attr || !Object.keys(attr).length) return false;
  const { rowCount } = await pool.query(
    `UPDATE ${S}.users SET attribution = $2::jsonb
       WHERE id = $1 AND attribution IS NULL AND created_at > now() - interval '2 hours'`,
    [userId, JSON.stringify(attr)],
  );
  return rowCount > 0;
}

// Lists the signups that came from a campaign (to check click -> account).
export async function listAttributedUsers({ days = 30 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, name, email, created_at, attribution FROM ${S}.users
       WHERE attribution IS NOT NULL AND created_at > now() - ($1 || ' days')::interval
       ORDER BY created_at DESC`,
    [String(days)],
  );
  return rows;
}

// User's model preference (which "quality" they chose). Default 'g3'.
export async function getUserModelPref(userId) {
  const { rows } = await pool.query(`SELECT model_pref FROM ${S}.users WHERE id = $1`, [userId]);
  return rows[0]?.model_pref || 'flash';
}
export async function setUserModelPref(userId, model) {
  const { rows } = await pool.query(
    `UPDATE ${S}.users SET model_pref = $2 WHERE id = $1 RETURNING model_pref`,
    [userId, model],
  );
  return rows[0]?.model_pref || 'flash';
}

// "Automatic" flag: when on, the backend picks the model per question
// (pickAutoModel) instead of using the fixed model_pref. Default off.
export async function getUserModelAuto(userId) {
  const { rows } = await pool.query(`SELECT model_auto FROM ${S}.users WHERE id = $1`, [userId]);
  return !!rows[0]?.model_auto;
}
export async function setUserModelAuto(userId, enabled) {
  const { rows } = await pool.query(
    `UPDATE ${S}.users SET model_auto = $2 WHERE id = $1 RETURNING model_auto`,
    [userId, !!enabled],
  );
  return !!rows[0]?.model_auto;
}

// Explicit permission for the assistant to SEND email (default false). Without it the
// agent only creates a draft.
export async function getEmailSendEnabled(userId) {
  const { rows } = await pool.query(`SELECT email_send_enabled FROM ${S}.users WHERE id = $1`, [userId]);
  return !!rows[0]?.email_send_enabled;
}
export async function setEmailSendEnabled(userId, enabled) {
  const { rows } = await pool.query(
    `UPDATE ${S}.users SET email_send_enabled = $2 WHERE id = $1 RETURNING email_send_enabled`,
    [userId, !!enabled],
  );
  return !!rows[0]?.email_send_enabled;
}

// ── Unsubscribe from institutional communication/news ──
// Targets of an institutional send: users with email who have NOT opted out.
// Ensures one unsub_token per target (generated lazily on the 1st time). randomToken
// is injected by the caller (crypto) so as not to couple db.mjs to the random module.
// `exclude` removes addresses from the base in the SQL itself (internal test accounts,
// store review, etc.). An empty list is a no-op: `<> ALL('{}')` is true for
// every row in Postgres, so the normal path does not change.
export async function listInstitutionalTargets(makeToken, exclude = [], { ensureTokens = true } = {}) {
  const fora = (Array.isArray(exclude) ? exclude : [])
    .map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
  const { rows } = await pool.query(
    `SELECT id, name, email${ensureTokens ? ', unsub_token' : ''}
       FROM ${S}.users
      WHERE email IS NOT NULL AND char_length(trim(email)) > 0
        AND email_optout = false
        AND lower(trim(email)) <> ALL ($1::text[])
      ORDER BY created_at ASC`,
    [fora],
  );
  for (const r of rows) {
    if (ensureTokens && !r.unsub_token) {
      const saved = await pool.query(`UPDATE ${S}.users SET unsub_token = COALESCE(NULLIF(unsub_token, ''), $2) WHERE id = $1 RETURNING unsub_token`, [r.id, makeToken()]);
      r.unsub_token = saved.rows[0]?.unsub_token;
    }
  }
  return rows;
}

// Checks the unsubscribe link token and returns the user (or null).

export async function getUserByUnsub(userId, token) {
  if (!userId || !token) return null;
  const { rows } = await pool.query(
    `SELECT id, name, email, email_optout FROM ${S}.users WHERE id = $1 AND unsub_token = $2`,
    [userId, token],
  );
  return rows[0] || null;
}

// Marks opt-out (idempotent). Only writes the timestamp the 1st time.
export async function setEmailOptout(userId) {
  const { rows } = await pool.query(
    `UPDATE ${S}.users
        SET email_optout = true,
            email_optout_at = COALESCE(email_optout_at, now())
      WHERE id = $1
      RETURNING id, email, email_optout`,
    [userId],
  );
  return rows[0] || null;
}

// Total cost (US$) spent by a user since `fromISO`. Basis for calculating
// credits consumed in the period.
export async function sumUserCost(userId, fromISO) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(cost_usd), 0) AS cost FROM ${S}.usage_events WHERE user_id = $1 AND ts >= $2`,
    [userId, fromISO],
  );
  return Number(rows[0]?.cost) || 0;
}

// REAL model cost (US$) since `fromISO`; excludes credit grants/purchases
// (model 'admin-grant'/'purchase'), which are extra balance, not consumption.
// This is what counts against the plan's monthly allowance.
export async function sumUserModelCost(userId, fromISO) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(cost_usd), 0) AS cost FROM ${S}.usage_events
      WHERE user_id = $1 AND ts >= $2 AND model NOT IN ('admin-grant','purchase','referral')`,
    [userId, fromISO],
  );
  return Number(rows[0]?.cost) || 0;
}

// Users with real model consumption since `fromISO` (basis for the proactive
// low-credit notice: only checks who actually used the product in the period).
export async function listUsersWithUsageSince(fromISO) {
  const { rows } = await pool.query(
    `SELECT DISTINCT user_id FROM ${S}.usage_events
      WHERE ts >= $1 AND model NOT IN ('admin-grant','purchase','referral')`,
    [fromISO],
  );
  return rows.map((r) => r.user_id).filter(Boolean);
}

// Total (US$, negative) granted/purchased by a user (all-time). Each
// extra credit is recorded as a NEGATIVE cost. Persistent: does not filter by period.
export async function sumUserGrantsUsd(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(cost_usd), 0) AS cost FROM ${S}.usage_events
      WHERE user_id = $1 AND model IN ('admin-grant','purchase','referral') AND ${SEM_PACOTE_LEVADO}`,
    [userId],
  );
  return Number(rows[0]?.cost) || 0;
}

// Company admins (id, name), from oldest to newest. Basis for the company's
// credit messages: a member without credit is told to talk to them, and the
// company's low-credit notice goes only to them.
export async function listOrgAdmins(orgId) {
  if (!orgId) return [];
  const { rows } = await pool.query(
    `SELECT u.id, u.name FROM ${S}.org_members m JOIN ${S}.users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.role = 'admin' ORDER BY m.joined_at, u.id`,
    [orgId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name || null }));
}

// Real model cost grouped by calendar month (BR timezone), in the window
// [fromISO, toISO). Basis for reconciliation: for each closed month, the amount
// above the allowance debits the extras balance.
export async function modelCostByMonth(userId, fromISO, toISO) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', ts AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mon,
            COALESCE(sum(cost_usd), 0) AS cost
       FROM ${S}.usage_events
      WHERE user_id = $1 AND model NOT IN ('admin-grant','purchase','referral')
        AND ts >= $2 AND ts < $3
      GROUP BY 1 ORDER BY 1`,
    [userId, fromISO, toISO],
  );
  return rows.map((r) => ({ mon: r.mon, usd: Number(r.cost) || 0 }));
}

// BILLED CREDITS grouped by calendar month (BR timezone), in the window [from, to).
// Counterpart to modelCostByMonth, but in billing credit (bill_credits). Basis for
// reconciliation of closed months: the amount above the allowance debits the extras.
export async function billByMonth(userId, fromISO, toISO) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', ts AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mon,
            COALESCE(sum(bill_credits), 0) AS c
       FROM ${S}.usage_events
      WHERE user_id = $1 AND model NOT IN ('admin-grant','purchase','referral')
        AND ts >= $2 AND ts < $3
      GROUP BY 1 ORDER BY 1`,
    [userId, fromISO, toISO],
  );
  return rows.map((r) => ({ mon: r.mon, credits: Number(r.c) || 0 }));
}

// ── Agentes ──
export async function createAgent({ userId, owner, name, goal, instructions }) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.agents (user_id, owner, name, goal, instructions) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, owner, name, goal, instructions, style, profile, summary, history`,
    [userId, owner, name, goal || '', instructions || ''],
  );
  return rows[0];
}

export async function listAgents(userId) {
  const { rows } = await pool.query(
    `SELECT id, name, goal, google_email FROM ${S}.agents WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

// Archives an agent (soft-delete): validates the owner, marks archived_at, and returns
// how many active agents are left. Does NOT delete threads/messages; the history
// stays stored on the account. Idempotent (already archived does not count as success).
export async function archiveAgent(id, userId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(
      `UPDATE ${S}.agents SET archived_at = now()
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
        RETURNING id, name`,
      [id, userId],
    );
    if (!rows[0]) { await c.query('ROLLBACK'); return { archived: null, remaining: null }; }
    // Marking archived_at alone was not enough: whatever POINTED to the assistant stayed
    // alive. The routine kept running in the scheduler, the channel kept routing to it, and the
    // connection with another person kept delivering requests to the deleted assistant.
    // Ending this here is the counterpart to the soft-delete; none of this deletes history.
    for (const sql of [
      `UPDATE ${S}.routines       SET enabled = false WHERE agent_id = $1`,
      `UPDATE ${S}.reminders      SET status = 'canceled' WHERE agent_id = $1 AND status = 'pending'`,
      `UPDATE ${S}.agent_webhooks SET enabled = false WHERE agent_id = $1`,
      `UPDATE ${S}.whatsapp_links SET active_agent_id = NULL WHERE active_agent_id = $1`,
      `UPDATE ${S}.slack_links    SET active_agent_id = NULL WHERE active_agent_id = $1`,
      `UPDATE ${S}.ext_links      SET active_agent_id = NULL WHERE active_agent_id = $1`,
      `UPDATE ${S}.device_tokens  SET active_agent_id = NULL WHERE active_agent_id = $1`,
      // Agent-to-agent inbound goes back to NULL instead of dropping the connection: the
      // resolveContactTarget redoes the backfill to the primary assistant that
      // is left, so the contact on the other side keeps working.
      `UPDATE ${S}.agent_connections SET inbound_agent_a = NULL WHERE inbound_agent_a = $1`,
      `UPDATE ${S}.agent_connections SET inbound_agent_b = NULL WHERE inbound_agent_b = $1`,
    ]) await c.query(sql, [id]);
    const { rows: cnt } = await c.query(
      `SELECT count(*)::int AS n FROM ${S}.agents WHERE user_id = $1 AND archived_at IS NULL`,
      [userId],
    );
    await c.query('COMMIT');
    return { archived: rows[0], remaining: cnt[0].n };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// Counts the owner's active (non-archived) agents.
export async function countActiveAgents(userId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ${S}.agents WHERE user_id = $1 AND archived_at IS NULL`,
    [userId],
  );
  return rows[0].n;
}

// Fetches the agent while already validating the owner; only returns it if it belongs to userId.
// Loads an owner's assistant. By default REFUSES an already-deleted assistant
// (archived_at): deletion has to hold on every path that EXECUTES (WhatsApp,
// routine, webhook, cockpit, agent-to-agent), and before this only the listing
// filtered it out, so the assistant disappeared from the screen but kept running (burning
// the owner's credit). Only the HISTORY screens pass incluirArquivado.
export async function getAgentOwned(id, userId, { incluirArquivado = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, user_id, owner, name, goal, instructions, style, profile, summary, history, perm_mode, cmd_allowlist, model, former_names, active_project_id, category, tool_config, google_email, archived_at FROM ${S}.agents WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const agent = rows[0] || null;
  if (!agent) return null;
  if (agent.archived_at && !incluirArquivado) return null;
  return agent;
}

// Persiste uma troca completa: history + profile + resumo no agente, e o log bruto.
export async function saveTurn(id, { history, profile, summary, userMsg, assistantMsg }) {
  await pool.query(
    `UPDATE ${S}.agents SET history = $2, profile = $3, summary = $4 WHERE id = $1`,
    [id, JSON.stringify(history), profile, summary ?? ''],
  );
  await pool.query(
    `INSERT INTO ${S}.messages (agent_id, role, content) VALUES ($1,'user',$2),($1,'assistant',$3)`,
    [id, userMsg, assistantMsg],
  );
}

// ── Agent category (security profile) ──
// 'pessoal' = owner's 1:1, full arsenal with confirmation (default).
// 'grupo'   = multi-person channel, toolset restricted to an allow-list; personal
//             account tools and self-reconfiguration are ALWAYS blocked.
// 'super'   = free mode (live terminal), 1:1 only and with a connected server.
export const AGENT_CATEGORIES = ['pessoal', 'grupo', 'super'];
// Tool groups that can be enabled on a 'grupo' agent (allow-list in tool_config.groups).
// 'shell' = shell/code on the dedicated box; 'produtos' = scrape + RAG/catalog;
// 'projeto' = create/manage project; 'web' = search/open link; 'apps' = mini-PaaS.
export const AGENT_TOOL_GROUPS = ['shell', 'produtos', 'projeto', 'web', 'apps'];

export async function setAgentCategory(agentId, userId, category, toolConfig) {
  if (!AGENT_CATEGORIES.includes(category)) return { ok: false, error: 'categoria inválida' };
  const cfg = normalizeToolConfig(toolConfig);
  const { rowCount } = await pool.query(
    `UPDATE ${S}.agents SET category = $3, tool_config = $4 WHERE id = $1 AND user_id = $2`,
    [agentId, userId, category, JSON.stringify(cfg)],
  );
  return { ok: rowCount > 0, category, toolConfig: cfg };
}

// Sanitizes the tool_config coming from the UI: only known groups, short host string.
export function normalizeToolConfig(tc) {
  const o = (tc && typeof tc === 'object') ? tc : {};
  const groups = Array.isArray(o.groups)
    ? o.groups.filter((g) => AGENT_TOOL_GROUPS.includes(g))
    : [];
  const host = typeof o.host === 'string' ? o.host.trim().slice(0, 200) : '';
  return { groups: [...new Set(groups)], host };
}

// ── Phase 2 coding: permission mode + command allowlist (per agent) ──
const PERM_MODES = ['padrao', 'aceitar_edicoes', 'plano', 'livre'];

export async function setAgentPermMode(agentId, userId, mode) {
  if (!PERM_MODES.includes(mode)) return { ok: false, error: 'modo inválido' };
  const { rowCount } = await pool.query(
    `UPDATE ${S}.agents SET perm_mode = $3 WHERE id = $1 AND user_id = $2`,
    [agentId, userId, mode],
  );
  return { ok: rowCount > 0, mode };
}

// ── Style/tone per agent (the assistant's "CLAUDE.local.md") ──
// Belongs only to the agent and is only editable by the owner. Injected into its system prompt every turn.
export async function setAgentStyle(agentId, userId, style) {
  const s = String(style ?? '').trim().slice(0, 4000);
  const { rowCount } = await pool.query(
    `UPDATE ${S}.agents SET style = $3 WHERE id = $1 AND user_id = $2`,
    [agentId, userId, s],
  );
  return { ok: rowCount > 0, style: s };
}

// Editing the agent's fields (assistant screen): owner only, optional fields.
export async function updateAgentFields(agentId, userId, fields = {}) {
  const sets = [];
  const vals = [agentId, userId];
  for (const [col, max] of [['name', 40], ['goal', 200], ['instructions', 8000], ['style', 4000]]) {
    if (fields[col] === undefined) continue;
    vals.push(String(fields[col] ?? '').trim().slice(0, max));
    sets.push(`${col} = $${vals.length}`);
  }
  // Fixed model per agent (outside routing). Server-side whitelist: only a known
  // id is accepted; anything else (including 'auto'/'') resets to NULL =
  // default routing. Protects even if the UI is bypassed.
  if (fields.model !== undefined) {
    const m = String(fields.model || '').trim().toLowerCase();
    // 'deepseek4' left the list on 2026-08-31 (it became the product's default model), so
    // saving this id now resets to NULL = default routing, which IS V4 Pro.
    const val = ['kimi3', 'deepseek41flash', 'gemini37flash'].includes(m) ? m : null;
    vals.push(val);
    sets.push(`model = $${vals.length}`);
  }
  // Agent category (server-side whitelist): any value outside the set
  // becomes 'pessoal' (the most restricted in shell power). Protects even if the UI is bypassed.
  if (fields.category !== undefined) {
    const c = String(fields.category || '').trim().toLowerCase();
    vals.push(AGENT_CATEGORIES.includes(c) ? c : 'pessoal');
    sets.push(`category = $${vals.length}`);
  }
  // Google account THIS assistant uses (multi-account). Server-side whitelist:
  // only an email the owner actually connected is accepted; anything else
  // (including '' and 'auto') resets to NULL = uses the user's primary account.
  // Protects even if the UI is bypassed: no one ties an agent to an email
  // that is not in THEIR google_accounts.
  if (fields.google_email !== undefined) {
    const em = String(fields.google_email || '').trim().toLowerCase();
    let val = null;
    if (em) {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM ${S}.google_accounts WHERE user_id = $1 AND google_email = $2`, [userId, em]);
      if (!rowCount) return { ok: false, error: 'Essa conta Google não está conectada nesta conta.' };
      val = em;
    }
    vals.push(val);
    sets.push(`google_email = $${vals.length}`);
  }
  // Sanitized tool_config (only known groups + short host).
  if (fields.tool_config !== undefined) {
    vals.push(JSON.stringify(normalizeToolConfig(fields.tool_config)));
    sets.push(`tool_config = $${vals.length}`);
  }
  if (!sets.length) return { ok: false, error: 'nada pra atualizar' };
  const { rowCount } = await pool.query(
    `UPDATE ${S}.agents SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`,
    vals,
  );
  return { ok: rowCount > 0 };
}

// ── Assistant rename: changes the name and keeps the old ones in former_names ──
export async function renameAgent(agentId, userId, newName) {
  const name = String(newName || '').trim();
  if (!name) return { ok: false, error: 'nome vazio' };
  if (name.length > 40) return { ok: false, error: 'nome muito longo (máx 40)' };
  const { rows } = await pool.query(
    `SELECT name, former_names FROM ${S}.agents WHERE id = $1 AND user_id = $2`,
    [agentId, userId],
  );
  if (!rows[0]) return { ok: false, error: 'agente não encontrado' };
  const old = (rows[0].name || '').trim();
  if (old.toLowerCase() === name.toLowerCase()) return { ok: true, name, old, unchanged: true };
  let former = Array.isArray(rows[0].former_names) ? rows[0].former_names.map((x) => String(x)) : [];
  if (old && !former.some((n) => n.toLowerCase() === old.toLowerCase())) former.push(old);
  former = former.filter((n) => n.toLowerCase() !== name.toLowerCase());
  if (former.length > 8) former = former.slice(former.length - 8);
  const { rowCount } = await pool.query(
    `UPDATE ${S}.agents SET name = $3, former_names = $4::jsonb WHERE id = $1 AND user_id = $2`,
    [agentId, userId, name, JSON.stringify(former)],
  );
  return { ok: rowCount > 0, name, old, former };
}

export async function getAgentAllowlist(agentId, userId) {
  const { rows } = await pool.query(
    `SELECT cmd_allowlist FROM ${S}.agents WHERE id = $1 AND user_id = $2`,
    [agentId, userId],
  );
  const a = rows[0]?.cmd_allowlist;
  return Array.isArray(a) ? a : [];
}

export async function addAgentAllowlist(agentId, userId, prefix) {
  const p = String(prefix || '').trim();
  if (!p) return { ok: false, error: 'prefixo vazio' };
  const cur = await getAgentAllowlist(agentId, userId);
  if (!cur.includes(p)) cur.push(p);
  await pool.query(
    `UPDATE ${S}.agents SET cmd_allowlist = $3::jsonb WHERE id = $1 AND user_id = $2`,
    [agentId, userId, JSON.stringify(cur)],
  );
  return { ok: true, allowlist: cur };
}

export async function removeAgentAllowlist(agentId, userId, prefix) {
  const p = String(prefix || '').trim();
  const cur = (await getAgentAllowlist(agentId, userId)).filter((x) => x !== p);
  await pool.query(
    `UPDATE ${S}.agents SET cmd_allowlist = $3::jsonb WHERE id = $1 AND user_id = $2`,
    [agentId, userId, JSON.stringify(cur)],
  );
  return { ok: true, allowlist: cur };
}

// ══════════════ Agente ↔ Agente ══════════════

// ── Contacts / handshake (connection between two OWNERS) ──
// We always normalize the pair: user_a = whoever invited, user_b = invitee. The
// UNIQUE(user_a,user_b) + the check in both directions prevent a duplicate connection.

// Invites a person (by email). Creates the pending connection; user_a = inviter.
// Returns { ok, connection } or { error }.
export async function inviteContact(fromUserId, toEmail) {
  const email = String(toEmail || '').trim().toLowerCase();
  if (!email) return { error: 'email_vazio' };
  const other = await getUserByEmail(email);
  // A deleted account responds the same as a nonexistent one: it is not possible to open a
  // connection with someone who asked to leave, and the error message cannot reveal that the
  // email is still in the database because of the 30-day window.
  if (!other || other.deleted_at) return { error: 'usuario_nao_encontrado' };
  if (other.id === fromUserId) return { error: 'voce_mesmo' };
  // Does a connection already exist in either direction?
  const existing = await getConnectionBetween(fromUserId, other.id);
  if (existing) return { error: 'ja_existe', connection: existing };
  // Already designates the inviter's primary assistant as inbound on their side
  // (Phase 0 v2), so the reverse direction does not get stuck on NULL.
  const myAgents = await listAgents(fromUserId);
  const myInbound = myAgents[0]?.id || null;
  const { rows } = await pool.query(
    `INSERT INTO ${S}.agent_connections (user_a, user_b, status, inbound_agent_a)
     VALUES ($1, $2, 'pending', $3)
     RETURNING id, user_a, user_b, status, inbound_agent_a, inbound_agent_b, created_at`,
    [fromUserId, other.id, myInbound],
  );
  return { ok: true, connection: rows[0] };
}

// Same as inviteContact, but receives the userId directly (the feed exposes the
// post author's userId, not the email). Creates the pending connection; user_a = inviter.
export async function inviteContactByUserId(fromUserId, toUserId) {
  if (!toUserId) return { error: 'usuario_nao_encontrado' };
  if (toUserId === fromUserId) return { error: 'voce_mesmo' };
  const other = await getUserById(toUserId);
  // Same rule as inviteContact by email: a closed account responds the same as a
  // nonexistent one. This was missing here, and since the feed sends the userId directly, it
  // was possible to open a connection with someone who had already asked to leave.
  if (!other || other.deleted_at) return { error: 'usuario_nao_encontrado' };
  const existing = await getConnectionBetween(fromUserId, toUserId);
  if (existing) return { error: 'ja_existe', connection: existing };
  const myAgents = await listAgents(fromUserId);
  const myInbound = myAgents[0]?.id || null;
  const { rows } = await pool.query(
    `INSERT INTO ${S}.agent_connections (user_a, user_b, status, inbound_agent_a)
     VALUES ($1, $2, 'pending', $3)
     RETURNING id, user_a, user_b, status, inbound_agent_a, inbound_agent_b, created_at`,
    [fromUserId, toUserId, myInbound],
  );
  return { ok: true, connection: rows[0] };
}

// Returns the connection between two users (either direction), or null.
export async function getConnectionBetween(u1, u2) {
  const { rows } = await pool.query(
    `SELECT id, user_a, user_b, status, inbound_agent_a, inbound_agent_b, created_at
     FROM ${S}.agent_connections
     WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
     LIMIT 1`,
    [u1, u2],
  );
  return rows[0] || null;
}

export async function getConnectionById(id) {
  const { rows } = await pool.query(
    `SELECT id, user_a, user_b, status, inbound_agent_a, inbound_agent_b, created_at
     FROM ${S}.agent_connections WHERE id = $1`, [id],
  );
  return rows[0] || null;
}

// Accepts the connection (only the invitee, user_b, can) and designates the inbound assistant.
export async function acceptContact(connId, userId, inboundAgentId) {
  const conn = await getConnectionById(connId);
  if (!conn) return { error: 'nao_encontrada' };
  if (conn.user_b !== userId) return { error: 'sem_permissao' };
  if (conn.status === 'declined') return { error: 'ja_recusada' };
  // If the invitee did not choose an assistant, it falls back to the primary one (Phase 0 v2) so
  // the connection is already usable in both directions from the start.
  let inbound = inboundAgentId || null;
  if (!inbound) {
    const agents = await listAgents(userId);
    inbound = agents[0]?.id || null;
  }
  await pool.query(
    `UPDATE ${S}.agent_connections
     SET status = 'accepted', inbound_agent_b = $2, updated_at = now()
     WHERE id = $1`,
    [connId, inbound],
  );
  return { ok: true };
}

export async function declineContact(connId, userId) {
  const conn = await getConnectionById(connId);
  if (!conn) return { error: 'nao_encontrada' };
  if (conn.user_a !== userId && conn.user_b !== userId) return { error: 'sem_permissao' };
  await pool.query(
    `UPDATE ${S}.agent_connections SET status = 'declined', updated_at = now() WHERE id = $1`,
    [connId],
  );
  return { ok: true };
}

// Each owner can (re)assign the inbound assistant on THEIR side.
export async function setInboundAgent(connId, userId, agentId) {
  const conn = await getConnectionById(connId);
  if (!conn) return { error: 'nao_encontrada' };
  const col = conn.user_a === userId ? 'inbound_agent_a'
    : conn.user_b === userId ? 'inbound_agent_b' : null;
  if (!col) return { error: 'sem_permissao' };
  await pool.query(
    `UPDATE ${S}.agent_connections SET ${col} = $2, updated_at = now() WHERE id = $1`,
    [connId, agentId || null],
  );
  return { ok: true };
}

// Phase 0 (agent↔agent v2): ensures the user's side has a designated inbound
// agent. If NULL, sets the main assistant (listAgents[0]) idempotently.
// Fixes old connections with a NULL inbound (e.g. early test accounts).
// Returns the agentId in use, or null if the user has no assistant.
export async function ensureInboundAgent(connId, userId) {
  const conn = await getConnectionById(connId);
  if (!conn) return null;
  const col = conn.user_a === userId ? 'inbound_agent_a'
    : conn.user_b === userId ? 'inbound_agent_b' : null;
  if (!col) return null;
  if (conn[col]) return conn[col];
  const agents = await listAgents(userId);
  const principal = agents[0]?.id;
  if (!principal) return null;
  await pool.query(
    `UPDATE ${S}.agent_connections SET ${col} = $2, updated_at = now()
     WHERE id = $1 AND ${col} IS NULL`,
    [connId, principal],
  );
  return principal;
}

// Lists a user's contacts (connections in any direction/state), already
// resolving the OTHER person (name/email) and which assistant is my inbound.
export async function listContacts(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.status, c.created_at,
            c.user_a, c.user_b, c.inbound_agent_a, c.inbound_agent_b,
            ua.name AS name_a, ua.email AS email_a,
            ub.name AS name_b, ub.email AS email_b
     FROM ${S}.agent_connections c
     JOIN ${S}.users ua ON ua.id = c.user_a AND ua.deleted_at IS NULL
     JOIN ${S}.users ub ON ub.id = c.user_b AND ub.deleted_at IS NULL
     WHERE c.user_a = $1 OR c.user_b = $1
     ORDER BY c.created_at DESC`,
    [userId],
  );
  return rows.map((r) => {
    const iAmA = r.user_a === userId;
    return {
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      // am I the one who invited?
      invitedByMe: iAmA,
      // A OUTRA pessoa:
      personUserId: iAmA ? r.user_b : r.user_a,
      personName: iAmA ? r.name_b : r.name_a,
      personEmail: iAmA ? r.email_b : r.email_a,
      // my inbound assistant on this connection:
      myInboundAgent: iAmA ? r.inbound_agent_a : r.inbound_agent_b,
      // the other person's inbound assistant:
      theirInboundAgent: iAmA ? r.inbound_agent_b : r.inbound_agent_a,
    };
  });
}

// Lists PENDING friend requests that reached me (I am the invitee,
// user_b, status pending), already resolving who invited me (name/email). Used
// to surface the request in the between-assistants inbox (so my assistant knows
// there is an invite and can accept/decline it through conversation).
export async function listPendingContactRequests(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.created_at, ua.name AS from_name, ua.email AS from_email
     FROM ${S}.agent_connections c
     JOIN ${S}.users ua ON ua.id = c.user_a AND ua.deleted_at IS NULL
     WHERE c.user_b = $1 AND c.status = 'pending'
     ORDER BY c.created_at ASC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    fromName: r.from_name,
    fromEmail: r.from_email,
    created_at: r.created_at,
  }));
}

// Resolves a pending request by the inviter's name/email and accepts or
// declines it (only the invitee can). Returns { ok, from_name } or { error }.
// error: nenhum_pendente | ambiguo | nao_encontrado + passes through the accept/decline error.
export async function resolveContactRequest(userId, { de, aceitar }) {
  const pend = await listPendingContactRequests(userId);
  if (!pend.length) return { error: 'nenhum_pendente' };
  const q = String(de || '').trim().toLowerCase();
  let hit;
  if (!q) {
    if (pend.length > 1) return { error: 'ambiguo' };
    hit = pend[0];
  } else {
    hit = pend.find((p) => (p.fromEmail || '').toLowerCase() === q)
      || pend.find((p) => (p.fromName || '').toLowerCase() === q)
      || pend.find((p) => (p.fromName || '').toLowerCase().includes(q));
    if (!hit) return { error: 'nao_encontrado' };
  }
  const r = aceitar
    ? await acceptContact(hit.id, userId)
    : await declineContact(hit.id, userId);
  if (r.error) return { error: r.error };
  return { ok: true, from_name: hit.fromName };
}

// Resolves, starting from ME and a contact's email/name, the target of an
// agent-to-agent conversation: only returns if the connection is ACCEPTED and the other side
// has designated an inbound agent. Returns { toUser, toAgent } or { error }.
export async function resolveContactTarget(fromUserId, contactQuery) {
  const q = String(contactQuery || '').trim().toLowerCase();
  if (!q) return { error: 'contato_vazio' };
  const contacts = await listContacts(fromUserId);
  const accepted = contacts.filter((c) => c.status === 'accepted');
  // matches by exact email, otherwise by name (case-insensitive, contains).
  // At each step, if more than one contact matches, it does NOT pick the first one: returns
  // ambiguous so the caller can ask who is meant. Picking silently was how
  // "send to Ana" ended up at the wrong Ana's assistant.
  const byEmail = accepted.filter((c) => (c.personEmail || '').toLowerCase() === q);
  const byName = accepted.filter((c) => (c.personName || '').toLowerCase() === q);
  const byPart = accepted.filter((c) => (c.personName || '').toLowerCase().includes(q));
  const matches = byEmail.length ? byEmail : (byName.length ? byName : byPart);
  if (!matches.length) return { error: 'contato_nao_encontrado' };
  if (matches.length > 1) {
    return {
      error: 'contato_ambiguo',
      opcoes: matches.map((c) => ({ nome: c.personName, email: c.personEmail })),
    };
  }
  const hit = matches[0];
  // If the other side never designated an inbound (e.g. old connections with NULL),
  // does a lazy backfill to their primary assistant (Phase 0 v2). Only
  // returns sem_inbound if they really have no assistant at all.
  let target = hit.theirInboundAgent;
  if (!target) target = await ensureInboundAgent(hit.id, hit.personUserId);
  if (!target) return { error: 'sem_inbound', person: hit.personName };
  return {
    ok: true,
    toUser: hit.personUserId,
    toAgent: target,
    personName: hit.personName,
  };
}

// ── Negotiation conversations ──
export async function createAgentConvo({ fromUser, fromAgent, toUser, toAgent, objetivo, originChannel } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ${S}.agent_convos (from_user, from_agent, to_user, to_agent, objetivo, origin_channel)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, from_user, from_agent, to_user, to_agent, objetivo, status, rounds, origin_channel, created_at`,
    [fromUser, fromAgent || null, toUser, toAgent || null, clean(objetivo || ''), originChannel || null],
  );
  return rows[0];
}

export async function addConvoMsg({ convoId, senderAgent, side, intent, payload }) {
  await pool.query(
    `INSERT INTO ${S}.agent_convo_msgs (convo_id, sender_agent, side, intent, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [convoId, senderAgent || null, side, intent, clean(payload || '')],
  );
}

export async function getConvoMsgs(convoId) {
  const { rows } = await pool.query(
    `SELECT side, intent, payload, ts FROM ${S}.agent_convo_msgs
     WHERE convo_id = $1 ORDER BY ts, id`,
    [convoId],
  );
  return rows;
}

export async function updateAgentConvo(convoId, { status, rounds, resultado } = {}) {
  await pool.query(
    `UPDATE ${S}.agent_convos SET
       status    = COALESCE($2, status),
       rounds    = COALESCE($3, rounds),
       resultado = COALESCE($4, resultado),
       updated_at = now()
     WHERE id = $1`,
    [convoId, status ?? null, rounds ?? null, resultado ?? null],
  );
}

// ── Asynchronous delivery to owner B (closing the agent<->agent cycle) ──
//
// Cycle: A confirms (confirmar_com_agente) → convo status='accepted'. Owner B's
// assistant surfaces this decision to owner B (listInboundDecisions);
// owner B confirms/declines (respondToInboundDecision → 'confirmed_b'/'declined_b');
// B's response goes back to owner A (listDecisionResponsesForA) and disappears when A
// sees it (markDecisionsSeenByA → 'closed'). status is free text, no migration.

// Decisions from other owners awaiting confirmation from THIS user (B).
export async function listInboundDecisions(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.objetivo, c.resultado, c.to_agent, c.from_user, c.origin_channel, c.created_at,
            u.name AS from_name, u.email AS from_email, a.name AS from_agent_name
       FROM ${S}.agent_convos c
       JOIN ${S}.users u ON u.id = c.from_user
       LEFT JOIN ${S}.agents a ON a.id = c.from_agent
      WHERE c.to_user = $1 AND c.status = 'accepted'
      ORDER BY c.created_at DESC`,
    [userId],
  );
  return rows;
}

// Owner B responds to a pending decision (accepts or declines). Resolves the target
// by id, otherwise by the `de` contact (exact email / name contains; ambiguous → error),
// otherwise the single pending one. Does NOT overwrite the result (A's decision stays); B's
// response lives in a msg side 'b'.
export const respondToInboundDecision = createInboundDecisionResponder(pool);

// Owner B's responses that came back to owner A (awaiting A's acknowledgment).
export async function listDecisionResponsesForA(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.objetivo, c.resultado, c.status, c.updated_at,
            u.name AS to_name,
            (SELECT payload FROM ${S}.agent_convo_msgs m
               WHERE m.convo_id = c.id AND m.side = 'b'
               ORDER BY m.ts DESC, m.id DESC LIMIT 1) AS resposta
       FROM ${S}.agent_convos c
       JOIN ${S}.users u ON u.id = c.to_user
      WHERE c.from_user = $1 AND c.status IN ('confirmed_b', 'declined_b')
      ORDER BY c.updated_at DESC`,
    [userId],
  );
  return rows;
}

// Marks responses already surfaced to owner A as closed (closes the cycle).
export async function markDecisionsSeenByA(userId, ids) {
  if (!ids || !ids.length) return;
  await pool.query(
    `UPDATE ${S}.agent_convos SET status = 'closed', updated_at = now()
      WHERE from_user = $1 AND id = ANY($2::uuid[])
        AND status IN ('confirmed_b', 'declined_b')`,
    [userId, ids],
  );
}

// ── Ask-human loop (Phase 2 v2): a question agent B escalates to its OWN owner ──
//
// Cycle: in synchronous negotiation, when agent B detects an INFO question
// outside owner B's knowledge (but that the owner would know), instead of closing with
// "I don't know" it records a convo status='awaiting_owner_b' (msg side 'a' intent
// 'question'). Owner B sees the pending question (listPendingQuestions) and answers
// (answerExternalQuestion → 'answered_b', msg side 'b' intent 'answer'). The
// answer goes back to owner A (listQuestionAnswersForA) and disappears when A sees it
// (markQuestionsSeenByA → 'closed'). status is free text, no migration.

// Questions from other owners awaiting an answer from THIS user (B).
export async function listPendingQuestions(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.objetivo, c.to_agent, c.from_user, c.origin_channel, c.created_at,
            u.name AS from_name, u.email AS from_email, a.name AS from_agent_name,
            (SELECT payload FROM ${S}.agent_convo_msgs m
               WHERE m.convo_id = c.id AND m.side = 'a'
               ORDER BY m.ts DESC, m.id DESC LIMIT 1) AS pergunta
       FROM ${S}.agent_convos c
       JOIN ${S}.users u ON u.id = c.from_user
       LEFT JOIN ${S}.agents a ON a.id = c.from_agent
      WHERE c.to_user = $1 AND c.status = 'awaiting_owner_b'
      ORDER BY c.created_at DESC`,
    [userId],
  );
  return rows;
}

// Owner B answers a pending question. Resolves the target by id, otherwise by the
// `para` contact (exact email / exact name / name contains; ambiguous → error),
// otherwise the single pending one. Stores the answer in a msg side 'b'.
export async function answerExternalQuestion(userId, { id, para, resposta } = {}) {
  const pend = await listPendingQuestions(userId);
  if (!pend.length) return { error: 'nenhuma_pendente' };
  let hit = null;
  if (id) {
    const key = String(id).trim().toLowerCase();
    // Accepts the full uuid or the short prefix that the between-assistants inbox
    // shows (>= 6 chars). An id that was given but not found is an ERROR: falling back to "para"
    // or to the single pending one would silently answer a different question.
    let byId = pend.filter((p) => String(p.id).toLowerCase() === key);
    if (!byId.length && key.length >= 6) byId = pend.filter((p) => String(p.id).toLowerCase().startsWith(key));
    if (byId.length > 1) return { error: 'ambigua' };
    if (!byId.length) return { error: 'nao_encontrada' };
    hit = byId[0];
  }
  if (!hit && para) {
    const q = String(para).trim().toLowerCase();
    let matches = pend.filter((p) => (p.from_email || '').toLowerCase() === q);
    if (!matches.length) matches = pend.filter((p) => (p.from_name || '').toLowerCase() === q);
    if (!matches.length) matches = pend.filter((p) => (p.from_name || '').toLowerCase().includes(q));
    if (matches.length > 1) return { error: 'ambigua' };
    if (matches.length === 1) hit = matches[0];
    else return { error: 'nao_encontrada' };
  }
  if (!hit) {
    if (pend.length === 1) hit = pend[0];
    else return { error: 'ambigua' };
  }
  const txt = String(resposta || '').trim();
  if (!txt) return { error: 'resposta_vazia' };
  await addConvoMsg({
    convoId: hit.id, senderAgent: hit.to_agent, side: 'b',
    intent: 'answer', payload: txt,
  });
  await updateAgentConvo(hit.id, { status: 'answered_b' });
  return {
    ok: true, from_name: hit.from_name, pergunta: hit.pergunta, resposta: txt,
    to_user: hit.from_user, origin_channel: hit.origin_channel || null,
  };
}

// Answers to owner A's questions that came back (awaiting A's acknowledgment).
export async function listQuestionAnswersForA(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.objetivo, c.updated_at,
            u.name AS to_name,
            (SELECT payload FROM ${S}.agent_convo_msgs m
               WHERE m.convo_id = c.id AND m.side = 'a'
               ORDER BY m.ts, m.id LIMIT 1) AS pergunta,
            (SELECT payload FROM ${S}.agent_convo_msgs m
               WHERE m.convo_id = c.id AND m.side = 'b'
               ORDER BY m.ts DESC, m.id DESC LIMIT 1) AS resposta
       FROM ${S}.agent_convos c
       JOIN ${S}.users u ON u.id = c.to_user
      WHERE c.from_user = $1 AND c.status = 'answered_b'
      ORDER BY c.updated_at DESC`,
    [userId],
  );
  return rows;
}

// Marks question answers already surfaced to owner A as closed.
export async function markQuestionsSeenByA(userId, ids) {
  if (!ids || !ids.length) return;
  await pool.query(
    `UPDATE ${S}.agent_convos SET status = 'closed', updated_at = now()
      WHERE from_user = $1 AND id = ANY($2::uuid[])
        AND status = 'answered_b'`,
    [userId, ids],
  );
}

// ── Flights: search cache + price history ────────────────────
// See the flight_searches/flight_prices migration in initDb and web/voos.mjs.

// Cached response of a search, if still within the window (minutes). Returns
// { payload, fetchedAt, ageMin } or null. Also increments the hit counter
// (visibility into how many requests the cache is saving).
export async function getFlightCache(cacheKey, maxAgeMin) {
  const { rows } = await pool.query(
    `SELECT payload, fetched_at,
            floor(extract(epoch FROM (now() - fetched_at)) / 60)::int AS age_min
       FROM ${S}.flight_searches WHERE cache_key = $1`,
    [cacheKey],
  );
  const r = rows[0];
  if (!r) return null;
  const ageMin = Number(r.age_min) || 0;
  if (maxAgeMin != null && ageMin > Number(maxAgeMin)) {
    // Outside the window: returns it as STALE, the caller decides whether to use it (we only use it
    // when the API fails, and in that case the age is stated in the response).
    return { payload: r.payload, fetchedAt: r.fetched_at, ageMin, stale: true };
  }
  await pool.query(
    `UPDATE ${S}.flight_searches SET hits = hits + 1 WHERE cache_key = $1`, [cacheKey],
  ).catch(() => {});
  return { payload: r.payload, fetchedAt: r.fetched_at, ageMin, stale: false };
}

// Writes/updates the cache for a search.
export async function putFlightCache(cacheKey, { origin, destination, departDate, returnDate, params, payload }) {
  await pool.query(
    `INSERT INTO ${S}.flight_searches
       (cache_key, origin, destination, depart_date, return_date, params, payload, hits, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,now())
     ON CONFLICT (cache_key) DO UPDATE
        SET payload = EXCLUDED.payload, params = EXCLUDED.params, hits = 0, fetched_at = now()`,
    [cacheKey, origin || '', destination || '', departDate || null, returnDate || null,
     JSON.stringify(params || {}), JSON.stringify(payload || {})],
  );
}

// Records the price observed in a query (append-only). Only called when the
// search was REAL (a cache hit does not generate a new measurement, otherwise the history inflates).
export async function recordFlightPrice(p) {
  await pool.query(
    `INSERT INTO ${S}.flight_prices
       (origin, destination, depart_date, return_date, trip, cabin, stops,
        price, currency, airline, price_level, typical_low, typical_high)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [p.origin, p.destination, p.departDate, p.returnDate || null,
     p.trip || 'round', p.cabin || 'economy', p.stops || 'any',
     p.price, p.currency || 'BRL', p.airline || '', p.priceLevel || '',
     p.typicalLow == null ? null : p.typicalLow,
     p.typicalHigh == null ? null : p.typicalHigh],
  );
}

// What WE have already measured on this route (any departure date), in the last `days`.
// Basis for the "is it a good price" verdict that does not depend on a third party. Returns null
// when there is not yet enough sample (2+ measurements).
export async function flightPriceStats(origin, destination, { days = 90, cabin = null } = {}) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n, min(price)::float AS min, max(price)::float AS max,
            round(avg(price))::float AS avg,
            percentile_cont(0.25) WITHIN GROUP (ORDER BY price)::float AS p25
       FROM ${S}.flight_prices
      WHERE origin = $1 AND destination = $2
        AND captured_at >= now() - ($3 || ' days')::interval
        AND ($4::text IS NULL OR cabin = $4)`,
    [origin, destination, String(days), cabin],
  );
  const r = rows[0];
  if (!r || Number(r.n) < 2) return null;
  return { n: Number(r.n), min: r.min, max: r.max, avg: r.avg, p25: r.p25, days };
}

// Typed monitoring, enabled only after migration/approval of the configuration.
// Does not call initDb nor reconcile data during queries.
export async function previousFlightObservation({userId,routineId,key,day,tz}) {
  const {rows}=await pool.query(`SELECT query_key,price::float,currency,
      observation_day::text,observed_at FROM ${S}.flight_monitor_observations
    WHERE user_id=$1 AND routine_id=$2 AND query_key=$3 AND observation_day=$4::date AND timezone=$5
    ORDER BY observed_at DESC,id DESC LIMIT 1`,[userId,routineId,key,day,tz]);
  return rows[0]||null;
}
export async function recordFlightObservation({userId,routineId,key,day,query,quote,tz}) {
  await pool.query(`INSERT INTO ${S}.flight_monitor_observations
    (user_id,routine_id,query_key,query,observation_day,timezone,observed_at,price,currency,source,from_cache)
    SELECT $1,$2,$3,$4::jsonb,$5::date,$6,$7,$8,$9,'google_flights_serpapi',$10
    WHERE EXISTS(SELECT 1 FROM ${S}.routines WHERE id=$2 AND user_id=$1)
    ON CONFLICT (user_id,routine_id,query_key,observed_at) DO NOTHING`,
    [userId,routineId,key,JSON.stringify(query),day,tz,quote.observedAt,quote.price,quote.currency,!!quote.fromCache]);
}
