import { redact, type ReportContext } from './report.mjs';

type Reference = { id: string; quote: string };
type Insight = { text: string; basis: 'observed' | 'hypothesis'; evidence: Reference[] };
export interface JourneyReport {
    version: 2;
    understanding: Insight[];
    frictions: (Insight & { title: string })[];
    suggestions: { id: string; kind: string; title: string; why: string; deliverable: string; cadence: string; user_role: string; impact: string; first_step: string; evidence: Reference[] }[];
    experiments: { title: string; why: string; trial: string; evidence: Reference[] }[];
    app: { suggestion_id: string; shows: string; stores: string; usage: string } | null;
    questions: string[];
    start: { suggestion_id: string | null; action: string; why: string };
}
const FIELDS = new Set(['text', 'title', 'why', 'deliverable', 'cadence', 'user_role', 'impact', 'first_step', 'trial', 'shows', 'stores', 'usage', 'action', 'question']);
export function reportFailure(error: unknown): string {
    const code = error instanceof SyntaxError ? 'invalid_report_json' : error instanceof Error ? error.message : '';
    if (code.startsWith('report_field_too_long:') && FIELDS.has(code.slice('report_field_too_long:'.length))) return code;
    return ['invalid_report_json', 'invalid_report_text', 'missing_report_evidence', 'invalid_report_evidence', 'invalid_report_shape', 'invalid_report_kind', 'invalid_report_basis', 'invalid_report_selection', 'report_too_long'].includes(code) ? code : 'generation_failed';
}
export function emptyReport(): JourneyReport {
    return { version: 2, understanding: [], frictions: [], suggestions: [], experiments: [], app: null,
        questions: ['Qual tarefa do seu dia tem ocupado mais tempo ou atenção e você gostaria de tornar mais fácil?'],
        start: { suggestion_id: null, action: 'Conte um exemplo recente dessa tarefa e como você lida com ela hoje.', why: 'Ainda tenho pouco contexto para propor uma ajuda específica sem presumir como é sua vida.' } };
}
export function parseReport(raw: string, context: ReportContext): JourneyReport {
    const v = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!v || typeof v !== 'object' || v.version !== 2) throw Error('invalid_report_shape');
    const sources = new Map(context.evidence.map(e => [e.id, e]));
    const obj = (x: any) => { if (!x || typeof x !== 'object' || Array.isArray(x)) throw Error('invalid_report_shape'); return x; };
    const list = (x: unknown, max: number): any[] => { if (!Array.isArray(x) || x.length > max) throw Error('invalid_report_shape'); return x; };
    const str = (x: unknown, field: string, max = 1000): string => {
        if (typeof x !== 'string' || !x.trim() || redact(x) !== x || /https?:\/\//i.test(x)) throw Error('invalid_report_text');
        if (x.length > max) throw Error(`report_field_too_long:${field}`);
        return x.trim();
    };
    const refs = (x: any, hypothesis = false): Reference[] => {
        if (!Array.isArray(x) || !x.length || x.length > 3) throw Error('missing_report_evidence');
        return x.map(r => {
            const source = sources.get(r?.id);
            if (!source || (!hypothesis && source.kind.includes('hypothesis')) || typeof r.quote !== 'string' || r.quote.trim().length < 6 || !source.text.includes(r.quote)) throw Error('invalid_report_evidence');
            let quote = '';
            for (const char of r.quote.trim()) { if (quote.length + char.length > 240) break; quote += char; }
            return { id: r.id, quote };
        });
    };
    const insight = (x: any): Insight => {
        obj(x);
        if (!['observed', 'hypothesis'].includes(x.basis)) throw Error('invalid_report_basis');
        return { text: str(x.text, 'text'), basis: x.basis, evidence: refs(x.evidence, x.basis === 'hypothesis') };
    };
    const suggestions = list(v.suggestions, 5).map(x => {
        obj(x);
        if (!['routine', 'reminder', 'monitor', 'one_off', 'workflow', 'app'].includes(x.kind)) throw Error('invalid_report_kind');
        if (typeof x.id !== 'string' || !/^S[1-5]$/.test(x.id)) throw Error('invalid_report_selection');
        return { id: x.id, kind: x.kind, title: str(x.title, 'title', 180), why: str(x.why, 'why'),
            deliverable: str(x.deliverable, 'deliverable'), cadence: str(x.cadence, 'cadence'), user_role: str(x.user_role, 'user_role'),
            impact: str(x.impact, 'impact'), first_step: str(x.first_step, 'first_step'), evidence: refs(x.evidence) };
    });
    if (new Set(suggestions.map(s => s.id)).size !== suggestions.length) throw Error('invalid_report_selection');
    const start = obj(v.start);
    if (suggestions.length ? !suggestions.some(s => s.id === start.suggestion_id) : start.suggestion_id !== null) throw Error('invalid_report_selection');
    let app: JourneyReport['app'] = null;
    if (v.app !== null) {
        const x = obj(v.app);
        if (!suggestions.some(s => s.id === x.suggestion_id && ['app', 'workflow'].includes(s.kind))) throw Error('invalid_report_selection');
        app = { suggestion_id: x.suggestion_id, shows: str(x.shows, 'shows'), stores: str(x.stores, 'stores'), usage: str(x.usage, 'usage') };
    }
    return { version: 2,
        understanding: list(v.understanding, 4).map(insight),
        frictions: list(v.frictions, 6).map(x => ({ ...insight(x), title: str(x.title, 'title', 180) })),
        suggestions,
        experiments: list(v.experiments, 2).map(x => { obj(x); return { title: str(x.title, 'title', 180), why: str(x.why, 'why'), trial: str(x.trial, 'trial'), evidence: refs(x.evidence, true) }; }),
        app, questions: list(v.questions, 5).map(x => str(x, 'question', 480)),
        start: { suggestion_id: start.suggestion_id, action: str(start.action, 'action'), why: str(start.why, 'why') },
    };
}
export function renderReport(report: JourneyReport, context: ReportContext): string {
    const parts = ['Sua jornada de autodescoberta'];
    const date = (value: string) => value.slice(0, 10).split('-').reverse().join('/');
    parts.push(`Considerei ${context.coverage.partial ? 'uma seleção das anotações e conversas disponíveis' : 'as anotações e conversas disponíveis'} de toda a jornada e dos 20 dias anteriores ao início. Você pode corrigir o que não representar mais seu momento.`);
    parts.push(`Período analisado: ${date(context.from)} a ${date(context.through)}. Histórico disponível: ${context.coverage.activeDays} dias com conversas.`);
    const observation = (x: Insight) => `${x.basis === 'hypothesis' ? 'Uma hipótese a confirmar: ' : ''}${x.text}`;
    if (report.understanding.length) parts.push('O que eu entendi sobre sua vida\n\n' + report.understanding.map(observation).join('\n\n'));
    if (report.frictions.length) parts.push('Onde parece estar sua maior carga mental\n\n' + report.frictions.map(x => `${x.title}\n${observation(x)}`).join('\n\n'));
    if (report.suggestions.length) parts.push('As coisas que eu gostaria de assumir para você\n\n' + report.suggestions.map((s, i) =>
        `${i + 1}. ${s.title}\n\nO que percebi\n${s.why}\n\nO que eu poderia fazer por você\n${s.deliverable}\n\nComo funcionaria\n${s.cadence}\n\nO que continuaria dependendo de você\n${s.user_role}\n\nImpacto esperado\n${s.impact}\n\nPara começar\n${s.first_step}`).join('\n\n'));
    if (report.experiments.length) parts.push('O que valeria experimentar\n\n' + report.experiments.map(x => `${x.title}\nHipótese a testar: ${x.why}\nComo testar: ${x.trial}`).join('\n\n'));
    if (report.app) {
        const a = report.app, solution = report.suggestions.find(s => s.id === a.suggestion_id)!;
        parts.push(`Algo que eu poderia construir para você\n\nPara apoiar “${solution.title}”:\nO que mostraria: ${a.shows}\nQuais dados guardaria: ${a.stores}\nComo você usaria: ${a.usage}`);
    }
    if (report.questions.length) parts.push('O que eu ainda gostaria de aprender sobre você\n\n' + report.questions.map(q => `• ${q}`).join('\n'));
    parts.push(`Minha sugestão para começar\n\n${report.start.action}\n${report.start.why}`);
    parts.push('Estas são propostas para combinarmos. Nenhuma rotina foi ativada e nenhuma ação foi executada por este relatório.');
    const text = parts.join('\n\n');
    if (text.length > 18000) throw Error('report_too_long');
    return text;
}
// Same report in markdown, to become the PDF attached to the delivery. The
// running text from renderReport() stays what's recorded in the conversation;
// here the hierarchy becomes headings and lists that the document generator understands.
export function renderReportMarkdown(report: JourneyReport, context: ReportContext): string {
    const date = (value: string) => value.slice(0, 10).split('-').reverse().join('/');
    const parts = ['# Sua jornada de autodescoberta'];
    parts.push(`Considerei ${context.coverage.partial ? 'uma seleção das anotações e conversas disponíveis' : 'as anotações e conversas disponíveis'} de toda a jornada e dos 20 dias anteriores ao início. Você pode corrigir o que não representar mais seu momento.`);
    parts.push(`Período analisado: ${date(context.from)} a ${date(context.through)}. Histórico disponível: ${context.coverage.activeDays} dias com conversas.`);
    const observation = (x: Insight) => `${x.basis === 'hypothesis' ? 'Uma hipótese a confirmar: ' : ''}${x.text}`;
    if (report.understanding.length) parts.push('## O que eu entendi sobre sua vida', ...report.understanding.map(observation));
    if (report.frictions.length) parts.push('## Onde parece estar sua maior carga mental', ...report.frictions.flatMap(x => [`### ${x.title}`, observation(x)]));
    if (report.suggestions.length) parts.push('## As coisas que eu gostaria de assumir para você', ...report.suggestions.flatMap((s, i) => [
        `### ${i + 1}. ${s.title}`,
        '**O que percebi**', s.why,
        '**O que eu poderia fazer por você**', s.deliverable,
        '**Como funcionaria**', s.cadence,
        '**O que continuaria dependendo de você**', s.user_role,
        '**Impacto esperado**', s.impact,
        '**Para começar**', s.first_step]));
    if (report.experiments.length) parts.push('## O que valeria experimentar', ...report.experiments.flatMap(x => [
        `### ${x.title}`, `**Hipótese a testar:** ${x.why}`, `**Como testar:** ${x.trial}`]));
    if (report.app) {
        const a = report.app, solution = report.suggestions.find(s => s.id === a.suggestion_id)!;
        parts.push('## Algo que eu poderia construir para você', `Para apoiar “${solution.title}”:`,
            `**O que mostraria:** ${a.shows}`, `**Quais dados guardaria:** ${a.stores}`, `**Como você usaria:** ${a.usage}`);
    }
    if (report.questions.length) parts.push('## O que eu ainda gostaria de aprender sobre você', ...report.questions.map(q => `- ${q}`));
    parts.push('## Minha sugestão para começar', report.start.action, report.start.why);
    parts.push('Estas são propostas para combinarmos. Nenhuma rotina foi ativada e nenhuma ação foi executada por este relatório.');
    return parts.join('\n\n');
}
