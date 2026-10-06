// Company account invite e-mail (29/09): sent once per newly invited address.
// Re-inviting the same e-mail with a pending invite doesn't resend. A send
// failure never undoes the invite: it stays valid in the app (it shows up
// when the person signs in with that e-mail).
//
// Sender: MAIL_INVITE_FROM, or the institutional one (MAIL_INSTITUTIONAL_FROM),
// never assistente@ (the inbox where users talk to the assistant).
// The address must be the SMTP-authenticated one or have "Send as" on it.
// Replies go to the inviter (Reply-To). Name and site come from the brand
// (marca.mjs); the rule is the operator's sentence about how the company
// account works (linhaDoConvite hook in empresa.mjs), or nothing.
import { marca, siteDaMarca } from './marca.mjs';

const limpa = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();

export function textoConviteEmpresa({ quem, empresa, email, base, regra }) {
  const nome = marca().nome;
  const r = limpa(regra);
  const q = limpa(quem) || 'Alguém da sua empresa';
  const e = limpa(empresa) || 'sua empresa';
  const link = `${String(base || siteDaMarca()).replace(/\/+$/, '')}/config`;
  const subject = `${q} convidou você para a ${e} no ${nome}`;
  const text = [
    'Oi!',
    '',
    `${q} convidou você para entrar na conta da empresa ${e} no ${nome}.${r ? ` ${r}` : ''} Suas conversas e seus assistentes continuam seus.`,
    '',
    `Para aceitar, entre no ${nome} com este e-mail (${limpa(email)}). O convite aparece logo no topo da tela:`,
    '',
    link,
    '',
    'Se ainda não tem conta, é só se cadastrar com este mesmo e-mail. Se não reconhece este convite, pode ignorar.',
    '',
    `Equipe ${nome}`,
  ].join('\n');
  return { subject, text };
}

export function remetenteConvite(env = process.env) {
  return {
    fromName: marca().nome,
    fromAddr: env.MAIL_INVITE_FROM || env.MAIL_INSTITUTIONAL_FROM || env.MAIL_FROM,
  };
}

// Manda o e-mail de um convite. Devolve true se saiu, false se não (sem
// credencial de e-mail, erro do SMTP). Nunca lança.
export async function enviarConviteEmpresa({ sendEmail, email, quem, quemEmail, empresa, base, regra, env = process.env, log = console }) {
  try {
    const { subject, text } = textoConviteEmpresa({ quem, empresa, email, base, regra });
    const replyTo = limpa(quemEmail);
    const r = await sendEmail({
      to: email, subject, text, ...remetenteConvite(env),
      ...(replyTo ? { headers: { 'Reply-To': replyTo } } : {}),
    });
    const ok = !!r?.ok;
    log.log(`[empresa] e-mail de convite ${ok ? 'enviado' : 'NÃO enviado (sem credencial de e-mail)'} para=${email}`);
    return ok;
  } catch (e) {
    log.error(`[empresa] e-mail de convite falhou para=${email}: ${e?.message || e}`);
    return false;
  }
}
