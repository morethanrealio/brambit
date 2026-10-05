// Onboarding calendar-first. No arbitrary OAuth scope comes from the browser.
// Escopo Microsoft é do conector, não do onboarding: mora em web/microsoft-scopes.mjs.
// @ts-expect-error runtime ESM legacy without declarations
export {microsoftOnboardingScope,microsoftContextServices,microsoftToolAllowed} from '../web/microsoft-scopes.mjs';
export function onboardingSources(google:string[],microsoft:string[]):string {
 const describe=(services:string[])=>services.filter(s=>['calendar','gmail','docs','drive'].includes(s)).join(', ')||'nenhuma';
 return `FONTES AUTORIZADAS: Google: ${describe(google)}. Microsoft: ${describe(microsoft)}. calendar = agenda; gmail = e-mail. Consulte SOMENTE as fontes listadas. Priorize os próximos compromissos da agenda; e-mail é opcional, não tente lê-lo sem permissão. Não crie, edite, envie nem exclua eventos, mensagens ou arquivos nesta análise. Se a agenda estiver vazia, diga isso e ofereça ajuda para planejar o dia, sem inventar compromissos.`;
}
