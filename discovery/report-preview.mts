// Explicit, private owner preview: reads a consistent DB snapshot, closes it,
// then drafts with no tools, customer billing, report mutation or channel send.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createClosingStore, type Closing } from './closing.mjs';
import { parseReport, renderReport, reportPrompt, reportFailure } from './report.mjs';
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i + 1]; };
const repo = arg('--repo'), user = arg('--owner'), output = arg('--output');
if (!process.argv.includes('--live') || !path.isAbsolute(repo || '') || !path.isAbsolute(output || '') || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(user || '')) throw Error('Use --live --repo /absolute/repo --owner UUID --output /private/new-file.json');
for (const key of ['PGHOST','PGDATABASE','PGUSER']) if (!process.env[key]) throw Error(`Missing explicit ${key}`);
const { default: pg } = await import(pathToFileURL(path.join(repo, 'node_modules/pg/lib/index.js')).href);
const db = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432), database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 10000 });
await db.connect();
let context;
try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row = (await db.query(`SELECT p.* FROM mtr_harness.discovery_participants p JOIN mtr_harness.users u ON u.id=p.user_id AND u.deleted_at IS NULL JOIN mtr_harness.agents a ON a.id=p.agent_id AND a.user_id=p.user_id AND a.archived_at IS NULL WHERE p.user_id=$1`, [user])).rows[0];
    if (!row?.ends_at || row.status !== 'completed') throw Error('Preview requires an existing completed journey');
    const closing = createClosingStore(db, async () => { throw Error('Preview cannot mutate the DB'); }, async () => false);
    context = await closing.context(row as Closing);
} finally { await db.query('ROLLBACK'); await db.end(); }
const { makeTogether, TOGETHER_FLASH_MODEL } = await import(pathToFileURL(path.join(repo, 'core-proto/providers/together.mjs')).href);
const provider = makeTogether({ model: TOGETHER_FLASH_MODEL, maxTokens: 16000 });
// Journey brief through the briefDaJornada port of the repo's plugins; with no plugin, the core default.
const { carregarPlugins, juntarPortas } = await import(pathToFileURL(path.join(repo, 'web/plugins.mjs')).href);
const brief: string | undefined = juntarPortas(await carregarPlugins(), { publicBase: '', notifyOwner: async () => {} }).briefDaJornada?.();
const { marca } = await import(pathToFileURL(path.join(repo, 'web/marca.mjs')).href);
let reason: string | null = null;
for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await provider.complete({ system: `Você é o assistente pessoal ${marca().nome}. Responda em português do Brasil. Modo rascunho privado: não execute ações, não grave memória e não envie mensagens.`, messages: [{ role: 'user', content: reportPrompt(context, reason, brief) }], tools: [] });
    try {
        if (response.stop !== 'end' || response.toolCalls?.length) throw Error('invalid_model_result');
        const report = parseReport(response.text, context), text = renderReport(report, context);
        await writeFile(output, JSON.stringify({ preview: true, generatedAt: new Date().toISOString(), model: TOGETHER_FLASH_MODEL, attempt, coverage: context.coverage, usageProfile: context.usage, period: { from: context.from, through: context.through, journeyStartedAt: context.journeyStartedAt }, resources: { connections: context.account?.connections.length, apps: context.account?.apps.length, trackers: context.account?.trackers.length, routines: context.routines.length }, modelUsage: response.usage, report, text }, null, 2), { mode: 0o600, flag: 'wx' });
        console.log(JSON.stringify({ previewSaved: true, attempt, coverage: context.coverage, characters: text.length }));
        break;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code) throw Error('Could not save private preview');
        reason = reportFailure(error);
        if (attempt === 2) throw Error(`Preview validation failed: ${reason}`);
        console.log(JSON.stringify({ attempt, valid: false, reason }));
    }
}
