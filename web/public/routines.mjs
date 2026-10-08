function fill(text, vars = {}) { return text.replace(/\{(\w+)\}/g, (m, name) => name in vars ? String(vars[name]) : m); }
function translator(texts) { return (key, vars) => fill(texts[key] ?? key, vars); }
export async function loadTexts(locale) { const response = await fetch('/api/texts/routines?lang=' + encodeURIComponent(locale), { credentials: 'same-origin' }); if (!response.ok)
    throw new Error('Routine texts unavailable: ' + response.status); return response.json(); }
function dateLabel(value, locale, tz = 'UTC') { try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: tz }).format(new Date(value));
}
catch {
    return value;
} }
export function cadence(r, locale, texts) {
    const t = translator(texts);
    let text = t('unknown');
    if (r.repeat_every_min && r.repeat_every_min > 0)
        text = `${t('every')} ${r.repeat_every_min} ${t('minutes')}`;
    else {
        const names = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + i))));
        let d = r.days;
        try {
            if (/^[\[{]/.test(r.days))
                d = JSON.parse(r.days);
        }
        catch { /* show unknown, never invent daily */ }
        if (d === 'daily')
            text = t('daily');
        else if (d === 'weekdays')
            text = t('weekdays');
        else if (d === 'weekends')
            text = t('weekends');
        else if (Array.isArray(d) && d.length && d.every(n => Number.isInteger(n) && n >= 0 && n <= 6))
            text = d.map(n => names[n]).join(', ');
        else if (d && typeof d === 'object') {
            const obj = d;
            if (Array.isArray(obj.mes) && obj.mes.length && obj.mes.every(n => Number.isInteger(n) && (n === -1 || n >= 1 && n <= 31)))
                text = `${t('month')}: ${obj.mes.map(n => n === -1 ? t('lastday') : n).join(', ')}`;
            else if ((obj.nth === -1 || Number.isInteger(obj.nth) && Number(obj.nth) >= 1 && Number(obj.nth) <= 5) && Array.isArray(obj.dow) && obj.dow.length && obj.dow.every(n => Number.isInteger(n) && n >= 0 && n <= 6))
                text = `${t('nth')}: ${obj.nth === -1 ? t('lastday') : obj.nth} — ${obj.dow.map(n => names[n]).join(', ')}`;
        }
        if (Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23)
            text += ` · ${String(r.hour).padStart(2, '0')}:${String(r.minute || 0).padStart(2, '0')}`;
    }
    if (r.tz)
        text += ` (${r.tz})`;
    if (r.repeat_until)
        text += ` · ${t('until')} ${dateLabel(r.repeat_until, locale, r.tz || 'UTC')}`;
    return text;
}
function el(tag, text, className) { const e = document.createElement(tag); if (text !== undefined)
    e.textContent = text; if (className)
    e.className = className; return e; }
function button(text, action) { const b = el('button', text, 'routine-button'); b.type = 'button'; b.addEventListener('click', action); return b; }
function expected(r) { return { title: r.title, prompt: r.prompt, channel: r.channel, hour: r.hour, minute: r.minute, days: r.days, tz: r.tz, enabled: r.enabled, config: r.config || {}, repeat_every_min: r.repeat_every_min ?? null, repeat_until: r.repeat_until ?? null }; }
export async function mountRoutines(root, deps) {
    const locale = deps.locale || 'en', texts = await loadTexts(locale), t = translator(texts);
    let busy = false, generation = 0, chosen = '';
    root.classList.add('routine-manager');
    root.replaceChildren();
    const header = el('div', undefined, 'routine-heading'), heading = el('h2', t('title'));
    heading.id = 'routine-title';
    root.setAttribute('aria-labelledby', heading.id);
    const refresh = button(t('refresh'), () => { void load(); });
    header.append(heading, refresh);
    root.append(header, el('p', t('intro'), 'routine-intro'));
    const controls = el('div', undefined, 'routine-create'), label = el('label', t('agent')), select = el('select');
    select.id = 'routine-agent';
    label.htmlFor = select.id;
    const create = button(t('new'), () => { void draft(); });
    create.classList.add('routine-main');
    controls.append(label, select, create);
    root.append(controls, el('p', t('prepare'), 'routine-note'));
    const status = el('p', '', 'routine-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const list = el('div', undefined, 'routine-list');
    root.append(status, list);
    function state(on) { busy = on; root.setAttribute('aria-busy', String(on)); root.querySelectorAll('button').forEach(b => b.disabled = on || b.dataset.locked === 'true'); select.disabled = on; }
    function message(text, error = false) { status.textContent = text; status.classList.toggle('routine-error', error); status.setAttribute('role', error ? 'alert' : 'status'); }
    function populateAgents() { const agents = deps.agents(); chosen = select.value || chosen || deps.activeAgent() || agents[0]?.id || ''; select.replaceChildren(); for (const a of agents) {
        const o = el('option', a.name);
        o.value = a.id;
        select.append(o);
    } select.value = agents.some(a => a.id === chosen) ? chosen : agents[0]?.id || ''; create.dataset.locked = String(!agents.length); if (!agents.length)
        message(t('none')); }
    async function draft(r, review = false) {
        if (busy)
            return;
        const id = r?.agent_id || select.value;
        if (!deps.agents().some(a => a.id === id)) {
            message(t('missing'), true);
            return;
        }
        const text = review && r ? t('review_draft', { title: r.title }) : r ? t('edit_draft', { title: r.title, cadence: cadence(r, locale, texts) }) : t('create_draft');
        state(true);
        try {
            if (await deps.openDraft(id, text))
                message(t('unsent'));
        }
        catch {
            message(t('error'), true);
        }
        finally {
            state(false);
        }
    }
    async function confirm(r, action) {
        const caption = action === 'delete' ? t('remove') : action === 'pause' ? t('pause') : t('resume');
        const dialog = el('dialog', undefined, 'routine-dialog');
        dialog.setAttribute('aria-labelledby', 'routine-confirm-title');
        dialog.setAttribute('aria-describedby', 'routine-confirm-body');
        const title = el('h3', `${caption}: ${r.title}`);
        title.id = 'routine-confirm-title';
        const body = el('p', action === 'delete' ? t('delete_warn') : action === 'pause' ? t('pause_warn') : t('resume_warn'));
        body.id = 'routine-confirm-body';
        const buttons = el('div', undefined, 'routine-actions');
        const cancel = button(t('cancel'), () => dialog.close('cancel')), accept = button(caption, () => dialog.close('ok'));
        if (action === 'delete')
            accept.classList.add('routine-danger');
        buttons.append(cancel, accept);
        dialog.append(title, body, buttons);
        document.body.append(dialog);
        const focus = document.activeElement;
        return new Promise(resolve => { dialog.addEventListener('close', () => { const approved = dialog.returnValue === 'ok'; dialog.remove(); if (focus instanceof HTMLElement && focus.isConnected)
            focus.focus(); resolve(approved); }, { once: true }); dialog.showModal(); cancel.focus(); });
    }
    async function change(r, action) {
        if (busy)
            return;
        state(true);
        try {
            if (!await confirm(r, action))
                return;
            message(t('save'));
            const response = await deps.api(action === 'delete' ? 'api/routine/delete' : 'api/routine/update', { id: r.id, expected: expected(r), ...(action === 'delete' ? {} : { enabled: action === 'resume' }) });
            if (response.error || response.netFail) {
                list.querySelectorAll('button').forEach(b => b.dataset.locked = 'true');
                message(`${response.error || t('error')} ${t('stale')}`, true);
                return;
            }
            await load(action === 'delete' ? t('deleted') : t('saved'));
        }
        catch {
            message(t('error'), true);
        }
        finally {
            state(false);
        }
    }
    function render(routines) {
        list.replaceChildren();
        if (!routines.length) {
            list.append(el('p', t('empty'), 'routine-empty'));
            return;
        }
        for (const r of routines) {
            const expired = !!r.repeat_until && Number.isFinite(Date.parse(r.repeat_until)) && Date.parse(r.repeat_until) <= Date.now();
            const card = el('article', undefined, 'routine-card');
            const top = el('div', undefined, 'routine-card-heading');
            const title = el('h3', r.title);
            const badge = el('span', expired ? t('expired') : r.enabled ? t('active') : t('paused'), `routine-badge ${r.enabled && !expired ? 'is-active' : 'is-paused'}`);
            top.append(title, badge);
            const meta = el('dl', undefined, 'routine-meta');
            const pair = (name, value) => { meta.append(el('dt', name), el('dd', value)); };
            pair(t('owner'), r.agent_name || '—');
            pair(t('cadence'), cadence(r, locale, texts));
            pair(t('channel'), { none: t('app'), app: t('app'), email: t('channel_email', { brand: deps.marca }), whatsapp: 'WhatsApp', telegram: 'Telegram' }[r.channel] || r.channel || t('app'));
            if (r.last_run_day)
                pair(t('last'), dateLabel(r.last_run_day, locale));
            const health = routineHealth(r, texts);
            if (health)
                pair(t('last_attempt'), health.label);
            const details = el('details');
            details.append(el('summary', t('details')), el('p', r.prompt, 'routine-prompt'));
            // Typed "busca_email" routine: shows the query the platform runs
            // (server data, plain text). Kept in the TS source so the build doesn't erase
            // the detail that already exists in the published bundle.
            const es = r.config?.email_search;
            if (es && typeof es === 'object') {
                const label = t('email_search.label');
                const parts = [es.provider === 'outlook' ? 'Outlook' : 'Gmail' + (es.account ? ` (${es.account})` : '')];
                if (Array.isArray(es.terms) && es.terms.length)
                    parts.push(es.terms.join(' | '));
                if (Array.isArray(es.senders) && es.senders.length)
                    parts.push(t('email_search.from', { senders: es.senders.join(' | ') }));
                parts.push(plural(texts, locale, 'email_search.days', Number(es.days)));
                if (es.unreadOnly)
                    parts.push(t('email_search.unread_only'));
                if (es.withAttachment)
                    parts.push(t('email_search.with_attachment'));
                details.append(el('p', `${label}: ${parts.join(' · ')}`, 'routine-prompt'));
            }
            const actions = el('div', undefined, 'routine-actions');
            const toggle = button(r.enabled ? t('pause') : t('resume'), () => { void change(r, r.enabled ? 'pause' : 'resume'); });
            if (expired && !r.enabled) {
                toggle.dataset.locked = 'true';
                toggle.title = t('expired');
                toggle.disabled = true;
            }
            const edit = button(t('edit'), () => { void draft(r); });
            const remove = button(t('remove'), () => { void change(r, 'delete'); });
            remove.classList.add('routine-danger');
            for (const b of [toggle, edit, remove])
                b.setAttribute('aria-label', `${b.textContent}: ${r.title}`);
            actions.append(toggle, edit, remove);
            if (health?.needsReview) {
                const review = button(t('review_failure'), () => { void draft(r, true); });
                actions.append(review);
            }
            card.append(top, meta, details, actions);
            list.append(card);
        }
    }
    async function load(notice = '') {
        const seq = ++generation;
        state(true);
        list.replaceChildren();
        populateAgents();
        message(t('loading'));
        try {
            const response = await deps.api('api/routines');
            if (seq !== generation)
                return;
            if (response.error || !Array.isArray(response.routines))
                throw Error(t('failed'));
            if (response.routines.some(r => !r || typeof r.id !== 'string' || typeof r.title !== 'string' || typeof r.agent_id !== 'string' || typeof r.enabled !== 'boolean'))
                throw Error(t('failed'));
            render(response.routines);
            message(notice || (!deps.agents().length ? t('none') : ''));
        }
        catch {
            if (seq === generation)
                message(t('failed'), true);
        }
        finally {
            if (seq === generation)
                state(false);
        }
    }
    return { load };
}
export function routineHealth(r, texts) {
    const t = translator(texts);
    const e = r.config?.execution;
    if (!e?.status)
        return null;
    let status = e.status;
    if (status === 'running' && e.leaseUntil && Date.parse(e.leaseUntil) < Date.now())
        status = 'interrupted';
    const known = (group, value, fallback) => t(`${group}.${`${group}.${value}` in texts ? value : fallback}`);
    if (e.content?.status || e.delivery?.status) {
        const c = e.content?.status || 'unknown', d = e.delivery?.status || 'unknown';
        const notification = e.delivery?.notification;
        const notice = notification && ['email', 'telegram', 'whatsapp'].includes(notification.channel || '') && ['failed', 'uncertain'].includes(notification.status || '') ? notification : null;
        const noticeLabel = notice ? t(notice.status === 'failed' ? 'health.notice_failed' : 'health.notice_unconfirmed', { channel: notice.channel || '' }) : '';
        const channel = e.delivery?.channel && ['email', 'telegram', 'whatsapp', 'app'].includes(e.delivery.channel) ? ` (${e.delivery.channel})` : '';
        return { label: `${t('health.content', { status: known('content_status', c, 'unknown') })} · ${t('health.delivery', { status: known('delivery_status', d, 'unknown') })}${channel}${noticeLabel ? ' · ' + noticeLabel : ''}`, needsReview: !!notice || ['partial', 'failed', 'unknown'].includes(c) || ['failed', 'uncertain', 'unknown'].includes(d) };
    }
    return { label: known('run_status', status, 'unconfirmed'), needsReview: ['partial', 'failed', 'uncertain', 'interrupted'].includes(status) };
}
function plural(texts, locale, key, count) { const form = `${key}_${new Intl.PluralRules(locale).select(count)}`; return fill(texts[form] ?? texts[`${key}_other`] ?? key, { count }); }
