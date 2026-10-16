// Onboarding calendar-first. No arbitrary OAuth scope comes from the browser.
// Microsoft scope belongs to the connector, not onboarding: it lives in web/microsoft-scopes.mjs.
// @ts-expect-error runtime ESM legacy without declarations
export { microsoftOnboardingScope, microsoftContextServices, microsoftToolAllowed } from '../web/microsoft-scopes.mjs';
export function onboardingSources(google, microsoft) {
    const describe = (services) => services.filter(s => ['calendar', 'gmail', 'docs', 'drive'].includes(s)).join(', ') || 'none';
    return `AUTHORIZED SOURCES: Google: ${describe(google)}. Microsoft: ${describe(microsoft)}. calendar means the calendar; gmail means e-mail. Consult ONLY the sources listed. Prioritize the upcoming calendar events; e-mail is optional, do not try to read it without permission. Do not create, edit, send or delete events, messages or files in this analysis. If the calendar is empty, say so and offer help planning the day, without inventing events.`;
}
