import { t } from './ui-texts.mjs';
export function hasContext(me) { return !!me.connected?.length || !!(me.providers?.includes('microsoft') && (me.microsoftServices === undefined || me.microsoftServices.length)); }
export function mountWizard(options) {
    const el = (id) => { const e = document.getElementById(id); if (!e)
        throw new Error(`Elemento ausente: ${id}`); return e; };
    const input = (id) => el(id), btn = (id) => el(id);
    const show = (id, on = true) => el(id).classList.toggle('hidden', !on);
    const text = (id, s) => { el(id).textContent = s; };
    let saved = { type: options.generic.id, agentId: null, agentName: '', step: 'type', waLinked: false, connected: false };
    let me = { name: '', agents: [] };
    let state = null;
    let pendingTask = null;
    let busy = false;
    let generation = 0;
    let startPromise = null;
    let recoverBoot = null;
    const steps = ['type', 'connect', 'wow', 'whatsapp', 'done'];
    const waOn = () => me.whatsapp !== null && me.whatsapp !== undefined;
    function save() { try {
        localStorage.setItem('mtr_wiz', JSON.stringify(saved));
    }
    catch { } }
    function load() { try {
        const v = JSON.parse(localStorage.getItem('mtr_wiz') || 'null');
        return v && typeof v.agentName === 'string' ? v : null;
    }
    catch {
        return null;
    } }
    function clear() { try {
        localStorage.removeItem('mtr_wiz');
    }
    catch { } }
    async function request(path, body) {
        const c = new AbortController(), timer = setTimeout(() => c.abort(), 15000);
        try {
            const r = await fetch('/' + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Idioma': document.documentElement.lang || 'pt-BR' }, body: body ? JSON.stringify(body) : undefined, signal: c.signal });
            const d = await r.json();
            if (!r.ok)
                throw new Error(d.error || t('step_save_failed'));
            return d;
        }
        catch (e) {
            if (e instanceof Error && e.name !== 'AbortError' && e.name !== 'TypeError')
                throw e;
            throw new Error(t('connection_dropped'));
        }
        finally {
            clearTimeout(timer);
        }
    }
    const status = () => request('api/onboard/status' + (saved.agentId ? '?agentId=' + encodeURIComponent(saved.agentId) : ''));
    async function progress(event, selection) { if (!saved.agentId)
        throw new Error(t('create_assistant_first')); state = await request('api/onboard/progress', { agentId: saved.agentId, event, attemptId: state?.attemptId, ...(selection === undefined ? {} : { selection }) }); return state; }
    async function touch(event, provider = 'none') {
        const c = new AbortController(), timer = setTimeout(() => c.abort(), 1500);
        try {
            const r = await fetch('/api/onboard/touch', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, provider }), signal: c.signal });
            if (!r.ok)
                throw new Error('telemetry');
        }
        catch {
            console.warn('[onboarding] metric not confirmed:', event);
        }
        finally {
            clearTimeout(timer);
        }
    }
    const seen = new Set(), observed = new Set();
    function exposure(event, id) {
        if (seen.has(event) || observed.has(event))
            return;
        observed.add(event);
        const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting) && document.visibilityState === 'visible') {
            seen.add(event);
            observer.disconnect();
            void touch(event);
        } }, { threshold: 0.5 });
        observer.observe(el(id));
    }
    el('wizTrustDetails').ontoggle = () => { if (el('wizTrustDetails').open)
        void touch('security_details_opened'); };
    function error(id, e) { text(id, e instanceof Error ? e.message : t('generic_failed')); show(id); }
    async function guarded(fn, errorId = 'wowError') { if (busy)
        return; busy = true; const controls = ['wizTypeNext', 'wizConnBack', 'wizConnBtn', 'wizConnGoogle', 'wizConnEmail', 'wizConnSkip', 'wizConnMsRow', 'wizWaBtn', 'wizWaContinue', 'wowRetry', 'wowStarterBtn', 'wizDoneBtn']; controls.forEach(x => btn(x).disabled = true); try {
        await fn();
    }
    catch (e) {
        error(errorId, e);
        if (errorId === 'wowError') {
            show('wowRecoveryTitle');
            show('wowLoading', false);
            show('wowRetry');
            show('wowSkip');
            show('wowLater');
        }
    }
    finally {
        busy = false;
        controls.forEach(x => btn(x).disabled = false);
    } }
    function goto(step) {
        if (step === 'whatsapp' && !waOn())
            step = 'wow';
        saved.step = step;
        save();
        steps.forEach(s => show('wizStep-' + s, s === step));
        const anchor = step;
        const visible = steps.filter(s => s !== 'whatsapp' || waOn());
        el('wizSteps').replaceChildren(...visible.map((s, i) => { const dot = document.createElement('span'); dot.className = 's' + (i <= visible.indexOf(anchor) ? ' on' : ''); return dot; }));
        el('wiz').scrollTop = 0;
        const heading = el('wizStep-' + step).querySelector('h2');
        if (heading) {
            heading.tabIndex = -1;
            heading.focus();
        }
        if (step === 'connect')
            exposure('security_viewed', 'wizTrust');
        if (step === 'done')
            renderDone();
    }
    function display() { el('wiz').classList.add('show'); options.showApp(false); el('auth').classList.add('hidden'); setupConnect(); }
    function setupConnect() { show('wizConnMsWrap', !!options.config().microsoft); show('wizConnProviders', false); btn('wizConnBtn').setAttribute('aria-expanded', 'false'); input('wizConnEmail').checked = false; }
    function renderDone() {
        text('wizDoneTitle', state?.viewed ? t('done_title_result') : t('done_title_created'));
        text('wizDoneLead', state?.viewed ? t('done_lead_result') : t('done_lead_skipped'));
        el('wizDoneList').replaceChildren();
        if (pendingTask) {
            const li = document.createElement('li');
            li.textContent = t('task_in_draft');
            el('wizDoneList').append(li);
        }
    }
    // No Google or Microsoft sign-in to connect: naming the assistant leads straight to a chat it opens itself.
    const signIn = () => { const c = options.config(); return !!(c.google || c.microsoft); };
    async function toChat() { await ensureAgent(); await progress('connections_skipped'); await touch('connection_skipped'); const r = await request('api/onboard/intro', { agentId: saved.agentId }); await progress('wow_skipped'); await exit(true, r.threadId); }
    async function ensureAgent() { if (!saved.agentId) {
        const r = await request('api/agent', { name: saved.agentName, instructions: options.generic.instructions, goal: options.generic.goal });
        saved.agentId = r.id;
        save();
    } await progress('started'); }
    async function enqueue(retry = false, starter) {
        if (startPromise)
            return startPromise;
        startPromise = request('api/onboard', { agentId: saved.agentId, retry, mode: starter ? 'starter' : 'connected', ...starter });
        try {
            state = await startPromise;
            return state;
        }
        finally {
            startPromise = null;
        }
    }
    function resetWow() { ['wowRecoveryTitle', 'wowError', 'wowRetry', 'wowResult', 'wowStarter', 'wowFeedback', 'wowBtn', 'wowSkip', 'wowLater'].forEach(x => show(x, false)); }
    function recovery(message) { show('wowRecoveryTitle'); show('wowLoading', false); text('wowError', message); show('wowError'); show('wowRetry'); show('wowSkip'); show('wowLater'); }
    function starter() { void touch('starter_offered'); resetWow(); show('wowLoading', false); show('wowStarter'); show('wowSkip'); text('wowTitle', t('starter_title')); }
    async function present(s) {
        state = s;
        if (!s.result?.welcome)
            throw new Error(t('analysis_incomplete'));
        resetWow();
        show('wowLoading', false);
        text('wowTitle', s.mode === 'starter' ? t('starter_ready') : t('analysis_title'));
        text('wowWelcome', s.result.welcome);
        show('wowResult');
        const list = el('wowSugs');
        list.replaceChildren();
        for (const [index, suggestion] of (s.result.suggestions || []).entries()) {
            const b = document.createElement('button');
            b.type = 'button';
            b.disabled = true;
            b.className = 'ci';
            b.textContent = suggestion;
            b.onclick = () => void guarded(async () => { await progress('suggestion_selected', index); restoreSelection(); afterResult(); });
            list.append(b);
        }
        // Only logs the exposure after inserting the result into the DOM and with the tab visible.
        if (document.visibilityState !== 'visible') {
            await new Promise(resolve => { const on = () => { if (document.visibilityState === 'visible') {
                document.removeEventListener('visibilitychange', on);
                resolve();
            } }; document.addEventListener('visibilitychange', on); });
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (document.visibilityState !== 'visible' || saved.step !== 'wow' || !el('wiz').classList.contains('show'))
            return;
        await progress(s.mode === 'starter' ? 'starter_viewed' : 'wow_viewed');
        list.querySelectorAll('button').forEach(b => b.disabled = false);
        renderFeedback();
        show('wowFeedback');
        show('wowBtn');
    }
    function restoreSelection() {
        const i = state?.selectedSuggestion;
        pendingTask = state?.refinementSelected && state.result
            ? t('refine_draft') + '\n\n' + state.result.welcome.slice(0, 6000)
            : typeof i === 'number' ? state?.result?.suggestions[i] || null : null;
    }
    function afterResult() { if (waOn() && !saved.waLinked) {
        setupWhatsapp();
        goto('whatsapp');
    }
    else
        goto('done'); }
    function renderFeedback() {
        btn('wowUseful').setAttribute('aria-pressed', String(state?.feedback === 'useful'));
        btn('wowNeedsWork').setAttribute('aria-pressed', String(state?.feedback === 'needs_work'));
        text('wowFeedbackStatus', state?.feedback === 'useful' ? t('feedback_saved') : state?.feedback === 'needs_work' ? t('feedback_saved_refine') : t('feedback_optional'));
    }
    async function feedback(choice) {
        const attempt = state?.attemptId;
        btn('wowUseful').disabled = true;
        btn('wowNeedsWork').disabled = true;
        try {
            const response = await request('api/onboard/feedback', { agentId: saved.agentId, attemptId: attempt, choice });
            if (state?.attemptId === attempt) {
                state = response;
                renderFeedback();
            }
        }
        catch {
            text('wowFeedbackStatus', t('feedback_save_failed'));
        }
        finally {
            btn('wowUseful').disabled = false;
            btn('wowNeedsWork').disabled = false;
        }
    }
    btn('wowUseful').onclick = () => void feedback('useful');
    btn('wowNeedsWork').onclick = () => void feedback('needs_work');
    btn('wowRefine').onclick = () => void guarded(async () => { await progress('refinement_selected'); restoreSelection(); afterResult(); });
    function starterHint() {
        const task = el('wowTask').value;
        const hints = { plan: t('hint_plan'), decision: t('hint_decision'), draft: t('hint_draft') };
        text('wowContextHint', hints[task] || hints.plan);
    }
    el('wowTask').onchange = starterHint;
    starterHint();
    async function poll() {
        const token = ++generation;
        resetWow();
        show('wowLoading');
        show('wowLater');
        show('wowSkip');
        text('wowLoadingMsg', t('analysis_loading'));
        const deadline = Date.now() + 150000;
        let failures = 0;
        while (token === generation && Date.now() < deadline) {
            try {
                const s = await status();
                if (token !== generation)
                    return;
                state = s;
                failures = 0;
                if (s.status === 'done') {
                    await present(s);
                    return;
                }
                if (s.status === 'error') {
                    recovery(t('analysis_failed'));
                    return;
                }
                // idle is also transient; it's neither success nor authorization to stop.
            }
            catch {
                if (++failures >= 3) {
                    recovery(t('analysis_check_failed'));
                    return;
                }
            }
            await new Promise(r => setTimeout(r, 2500));
        }
        if (token === generation)
            recovery(t('analysis_pending'));
    }
    async function runWow(retry = false) {
        goto('wow');
        resetWow();
        show('wowLoading');
        const s = await status();
        state = s;
        if (s.completed) {
            goto('done');
            return;
        }
        if (s.status === 'done') {
            await present(s);
            return;
        }
        if (s.status === 'running') {
            await poll();
            return;
        }
        if (!hasContext(me)) {
            starter();
            return;
        }
        if (s.status === 'error' && !retry) {
            recovery(t('analysis_interrupted'));
            return;
        }
        await enqueue(retry);
        await poll();
    }
    async function afterConnections() {
        saved.connected = hasContext(me);
        save();
        if (saved.connected) {
            try {
                await touch('connection_connected', me.providers?.includes('microsoft') && !me.connected?.length ? 'microsoft' : 'google');
                await progress('connections_connected');
                await enqueue();
            }
            catch (e) {
                error('wizConnErr', e);
                goto('wow');
                recovery(t('analysis_start_failed'));
                return;
            }
        }
        await runWow();
    }
    function setupWhatsapp() { const linked = !!me.whatsapp?.linked || saved.waLinked; saved.waLinked = linked; show('wizWaForm', !linked); show('wizWaSuccess', linked); show('wizWaBtn', !linked); show('wizWaSkip', !linked); show('wizWaContinue', linked); if (linked) {
        text('wizWaLead', saved.waCode ? t('whatsapp_send_code') : t('whatsapp_connected'));
        setWaLink(me.whatsapp?.number);
    } }
    // With a pending code, the message is the ownership CHALLENGE (only it binds the number
    // to the account; typing the phone in the app binds nothing). With no code it's just the "hi".
    function setWaLink(number) { const a = el('wizWaOpen'); if (number) {
        const msg = saved.waCode ? 'conectar ' + saved.waCode : 'Oi ' + saved.agentName + '!';
        a.href = 'https://wa.me/' + number.replace(/\D/g, '') + '?text=' + encodeURIComponent(msg);
        text('wizWaOpen', saved.waCode ? t('whatsapp_confirm_button') : t('whatsapp_first_message_button'));
        show('wizWaOpen');
    }
    else {
        a.removeAttribute('href');
        show('wizWaOpen', false);
    } }
    async function exit(complete, threadId) { ++generation; me = await request('api/me'); if (complete)
        await progress('completed'); el('wiz').classList.remove('show'); if (complete)
        clear(); options.enterHome(me, pendingTask, threadId); }
    btn('wizTypeNext').onclick = () => { const name = input('wizAgentName').value.trim(); if (!name) {
        error('wizErr1', new Error(t('name_required')));
        input('wizAgentName').focus();
        return;
    } saved.agentName = name; save(); if (!signIn()) {
        void guarded(toChat, 'wizErr1');
        return;
    } setupConnect(); goto('connect'); };
    input('wizAgentName').onkeydown = e => { if (e.key === 'Enter') {
        e.preventDefault();
        btn('wizTypeNext').click();
    } };
    btn('wizConnBack').onclick = () => goto('type');
    btn('wizConnBtn').onclick = () => { const expanded = btn('wizConnBtn').getAttribute('aria-expanded') !== 'true'; show('wizConnProviders', expanded); btn('wizConnBtn').setAttribute('aria-expanded', String(expanded)); if (expanded)
        btn('wizConnGoogle').focus(); };
    async function connect(provider) { await ensureAgent(); await touch('connection_started', provider); const services = input('wizConnEmail').checked ? 'calendar,gmail' : 'calendar'; location.href = 'api/connect/' + provider + '/start?services=' + encodeURIComponent(services); }
    btn('wizConnGoogle').onclick = () => void guarded(() => connect('google'), 'wizConnErr');
    btn('wizConnMsRow').onclick = () => void guarded(() => connect('microsoft'), 'wizConnErr');
    btn('wizConnSkip').onclick = () => void guarded(async () => { await ensureAgent(); await progress('connections_skipped'); await touch('connection_skipped'); if (hasContext(me))
        await afterConnections();
    else
        await runWow(); }, 'wizConnErr');
    btn('wizWaSkip').onclick = () => void guarded(async () => { await progress('whatsapp_skipped'); if (state?.viewed)
        goto('done');
    else
        await runWow(); });
    btn('wizWaContinue').onclick = () => void guarded(async () => { await progress('whatsapp_connected'); if (state?.viewed)
        goto('done');
    else
        await runWow(); });
    btn('wizWaBtn').onclick = () => void guarded(async () => { const phone = input('wizWaPhone').value.trim(); if (!input('wizWaOptin').checked)
        throw new Error(t('whatsapp_consent_required')); if (phone.replace(/\D/g, '').length < 10)
        throw new Error(t('whatsapp_number_required')); const r = await request('api/connect/whatsapp', { phone, agentId: saved.agentId }); saved.waCode = r.pending ? r.code : undefined; saved.waLinked = true; me.whatsapp = { linked: !r.pending, number: r.number }; save(); await progress('whatsapp_connected'); setupWhatsapp(); }, 'wizWaErr');
    btn('wowRetry').onclick = () => void guarded(() => recoverBoot ? recoverBoot() : runWow(true));
    btn('wowBtn').onclick = () => afterResult();
    btn('wowSkip').onclick = () => { ++generation; void progress('wow_skipped').then(() => goto('done')).catch(e => error('wowError', e)); };
    // Can interrupt the wait even while an operation is in flight.
    btn('wowLater').onclick = () => { void exit(false).catch(e => error('wowError', e)); };
    btn('wizDoneBtn').onclick = () => void guarded(() => exit(true), 'wizDoneErr');
    btn('wowStarterBtn').onclick = () => void guarded(async () => { const context = el('wowContext').value.trim(); if (context.length < 10)
        throw new Error(t('context_too_short')); const task = el('wowTask').value; await enqueue(true, { task, context }); await poll(); });
    const controller = {
        clear,
        async open(firstName) { state = null; pendingTask = null; me = await request('api/me'); saved = { type: options.generic.id, agentId: null, agentName: '', step: 'type', waLinked: !!me.whatsapp?.linked, connected: hasContext(me) }; text('wizHi', firstName ? t('welcome_name', { name: firstName }) : t('hi_no_name')); display(); goto('type'); },
        async boot(current, justConnected, oauth) {
            me = current;
            const local = load();
            const localAgent = current.agents.find(a => a.id === local?.agentId);
            let remote;
            try {
                remote = await request('api/onboard/status' + (localAgent ? '?agentId=' + encodeURIComponent(localAgent.id) : ''));
            }
            catch (e) {
                recoverBoot = async () => { await controller.boot(current, justConnected, oauth); };
                saved = localAgent ? { ...local, agentId: localAgent.id, agentName: localAgent.name } : saved;
                display();
                goto('wow');
                recovery(t('recover_failed'));
                show('wowSkip', false);
                return true;
            }
            recoverBoot = null;
            if (remote.completed) {
                clear();
                return false;
            }
            const agent = localAgent || current.agents.find(a => a.id === remote.agentId);
            if (!agent) {
                if (!current.agents.length) {
                    await this.open((current.name || '').split(' ')[0]);
                    return true;
                }
                clear();
                return false;
            }
            if (!localAgent && !remote.registered)
                return false;
            saved = { type: options.generic.id, agentId: agent.id, agentName: agent.name, step: remote.step || local?.step || 'connect', connected: hasContext(current), waLinked: !!current.whatsapp?.linked };
            state = remote;
            restoreSelection();
            save();
            display();
            try {
                if (!remote.registered)
                    await progress('started');
                if (!signIn()) {
                    recoverBoot = toChat;
                    await toChat();
                    return true;
                }
                if (remote.skipped || remote.step === 'done' && remote.viewed) {
                    goto('done');
                    return true;
                }
                if (oauth?.provider && ['google', 'microsoft'].includes(oauth.provider)) {
                    const cancelled = oauth.outcome === 'cancelled';
                    await touch(cancelled ? 'connection_cancelled' : 'connection_failed', oauth.provider);
                    goto('connect');
                    error('wizConnErr', new Error(cancelled ? t('oauth_cancelled') : t('oauth_incomplete')));
                    return true;
                }
                if (justConnected) {
                    if (!hasContext(me)) {
                        await touch('connection_returned_unconnected');
                        goto('connect');
                        error('wizConnErr', new Error(t('oauth_no_source')));
                        return true;
                    }
                    await afterConnections();
                    return true;
                }
                if (saved.step === 'connect') {
                    if (!saved.connected)
                        goto('connect');
                    else
                        await afterConnections();
                    return true;
                }
                if (saved.step === 'whatsapp' && remote.viewed && !saved.waLinked && waOn()) {
                    setupWhatsapp();
                    goto('whatsapp');
                    return true;
                }
                await runWow();
                return true;
            }
            catch (e) {
                goto('wow');
                recovery(e instanceof Error ? e.message : t('resume_failed'));
                return true;
            }
        },
    };
    return controller;
}
