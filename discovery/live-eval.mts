// Opt-in quality probe. Synthetic evidence only; no DB, customer ledger or sends.
// Build first, then: node .discovery-build/live-eval.mjs --live --repo /path/to/repo
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { reportContext, reportPrompt, parseReport, renderReport, reportFailure } from './report.mjs';
if (!process.argv.includes('--live')) throw Error('Live provider access requires --live; this script only uses synthetic evidence.');
const repo = process.argv[process.argv.indexOf('--repo') + 1];
if (!repo || !path.isAbsolute(repo)) throw Error('Pass an absolute --repo path.');
const { makeTogether, TOGETHER_FLASH_MODEL } = await import(pathToFileURL(path.join(repo, 'core-proto/providers/together.mjs')).href);
const provider = makeTogether({ model: TOGETHER_FLASH_MODEL, maxTokens: 12000 });
// Journey brief through the briefDaJornada port of the repo's plugins; with no plugin, the core default.
const { carregarPlugins, juntarPortas } = await import(pathToFileURL(path.join(repo, 'web/plugins.mjs')).href);
const brief: string | undefined = juntarPortas(await carregarPlugins(), { publicBase: '', notifyOwner: async () => {} }).briefDaJornada?.();
const { marca } = await import(pathToFileURL(path.join(repo, 'web/marca.mjs')).href);
const cases = [
    { name: 'compras e decisões da semana', notes: [
        'Faço compras no sábado e esqueço itens, então acabo voltando ao mercado na semana.',
        'Quero refeições simples para duas pessoas, mas decidir o cardápio todo dia me cansa.',
        'Não quero notificações diárias; prefiro resolver isso na sexta à tarde.',
        'Posso informar o que tenho na geladeira. O assistente não tem acesso automático à minha despensa.',
    ], past: 'Há três semanas pedi uma lista de compras por setor para levar ao mercado.', recent: 'Ajude a montar três jantares simples com os ingredientes que vou te passar.' },
    { name: 'freelancer e acompanhamento de clientes', notes: [
        'Atendo três clientes e esqueço de acompanhar propostas que enviei.',
        'Copio os combinados das reuniões aqui para organizar meus próximos passos.',
        `Não conectei e-mail nem agenda ao ${marca().nome}. Posso trazer os resumos manualmente.`,
        'Quero revisar pendências duas vezes na semana; não envie mensagens a clientes sem eu aprovar.',
    ], past: 'Perdi uma oportunidade porque esqueci de responder à proposta na data combinada.', recent: 'Organize os próximos passos deste resumo de reunião que vou colar.' },
    { name: 'estudo com pouco tempo e plano existente', notes: [
        'Tenho vinte minutos disponíveis depois do almoço para estudar inglês.',
        'Estudo listas de palavras mas travo ao escrever mensagens profissionais.',
        'Já recebo uma rotina de vocabulário toda segunda, que quero manter.',
        'Prefiro praticar escrevendo e receber correção curta. Não quero outra rotina de vocabulário.',
    ], past: 'Pode revisar esta mensagem em inglês e explicar duas correções?', recent: 'Me ajude a praticar uma resposta curta em inglês para uma reunião.' },
    { name: 'casa, escola e projeto pessoal', notes: [
        'Toda semana recebo avisos da escola em mensagens diferentes e perco tempo reunindo datas e materiais.',
        'Divido as tarefas de casa com minha parceira e não quero enviar nada para ela automaticamente.',
        'Quero planejar as refeições de domingo a quinta usando o que temos em casa. Compras extras na semana atrapalham.',
        'Estou reformando um quarto; os orçamentos estão em três conversas e preciso comparar itens e prazos.',
        'Já uso uma planilha de gastos e quero mantê-la; não quero outro dashboard financeiro.',
        'Prefiro uma revisão no domingo a notificações todos os dias. Posso trazer as mensagens manualmente.',
    ], past: 'Organize os avisos da escola que vou colar em uma lista de datas e materiais.', recent: 'Preciso comparar estes orçamentos de reforma e entender o que cada um deixa de fora.' },
    { name: 'interesse casual sem dor demonstrada', sparse: true, notes: [], past: 'Achei bonita uma foto de Lisboa que vi hoje.', recent: 'Só estava comentando a foto; não tenho viagem planejada nem quero alertas sobre isso.' },
];
for (const scenario of cases) {
    // No repeated copies to inflate apparent recurrence. Two dated human turns
    // plus a handful of distinct notes; sparse evidence must stay sparse.
    const notes = scenario.notes.map((text, i) => ({ kind: 'context', basis: 'user_report', text, created_at: new Date(Date.UTC(2026, 8, 15 + i, 12)) }));
    const messages = [scenario.past, scenario.recent].map((content, i) => ({ id: i + 1, ts: new Date(i ? '2026-09-20T12:00:00Z' : '2026-08-29T12:00:00Z'), day: i ? '2026-09-20' : '2026-08-29', content }));
    const context = reportContext({ from: new Date('2026-08-26T00:00:00Z'), journeyStartedAt: new Date('2026-09-15T00:00:00Z'), through: new Date('2026-09-21T23:00:00Z'), notes, messages, totalNotes: notes.length, totalMessages: messages.length, activeDays: 2,
        routines: scenario.name.startsWith('estudo') ? [{ title: 'Vocabulário de segunda', prompt: 'Enviar vocabulário toda segunda' }] : [],
        account: { capturedAt: '2026-09-21T23:00:00Z', connections: [], apps: [], trackers: [], hosting: 'configured', partial: false } });
    let reason: string | null = null, valid = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await provider.complete({ system: `Você é um assistente pessoal ${marca().nome}. Responda em português do Brasil. Não execute ações.`, messages: [{ role: 'user', content: reportPrompt(context, reason, brief) }], tools: [] });
        try {
            if (response.stop !== 'end' || response.toolCalls?.length) throw Error('invalid_model_result');
            const report = parseReport(response.text, context), text = renderReport(report, context);
            if (scenario.sparse ? report.suggestions.length > 0 || report.app !== null : !report.suggestions.length) throw Error('quality_probe_solution_mismatch');
            console.log(JSON.stringify({ case: scenario.name, attempt, valid: true, model: TOGETHER_FLASH_MODEL, suggestions: report.suggestions.length, frictions: report.frictions.length, experiments: report.experiments.length, app: !!report.app, usage: response.usage, text }));
            valid = true; break;
        } catch (error) {
            reason = reportFailure(error);
            console.log(JSON.stringify({ case: scenario.name, attempt, valid: false, reason }));
        }
    }
    if (!valid) process.exitCode = 1;
}
