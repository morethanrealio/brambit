// Escopos OAuth da Microsoft por serviço (agenda, e-mail) e quais tools do
// conector cada consentimento parcial libera. Nenhum escopo arbitrário vem do
// navegador: o pedido é montado aqui a partir da lista fechada de serviços.
export function microsoftOnboardingScope(services) {
    const selected = services.split(',').map(s => s.trim());
    if (!selected.includes('calendar') || selected.some(s => !['calendar', 'gmail'].includes(s)))
        throw new Error('Serviços inválidos para conectar a agenda.');
    return 'openid offline_access User.Read Calendars.ReadWrite' + (selected.includes('gmail') ? ' Mail.Read Mail.Send' : '');
}
function scopeSet(scope) { return new Set(scope.split(/\s+/).map(s => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase())); }
export function microsoftContextServices(scope) {
    if (scope === null)
        return ['calendar', 'gmail']; // Legacy tokens without metadata retain existing behavior.
    const set = scopeSet(scope), out = [];
    if (set.has('calendars.read') || set.has('calendars.readwrite'))
        out.push('calendar');
    if (set.has('mail.read') || set.has('mail.readwrite'))
        out.push('gmail');
    return out;
}
export function microsoftToolAllowed(name, scope) {
    if (scope === null)
        return true;
    const set = scopeSet(scope);
    if (name.startsWith('hotmail_'))
        return name === 'hotmail_send' ? set.has('mail.send') : set.has('mail.read') || set.has('mail.readwrite');
    if (name.startsWith('outlook_calendar_'))
        return set.has('calendars.readwrite') || (name === 'outlook_calendar_list' && set.has('calendars.read'));
    // Existing OneDrive tools have their own explicit reconnection response.
    return true;
}
