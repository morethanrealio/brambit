// Plugin "instalacao": a parte do Brambit no próprio computador que só faz
// sentido quando quem liga é o instalador/brambit.mjs (o lançador). Põe nas
// Configurações do app, só pro dono, a seção "Este computador": o que está
// ligado (versão, endereço, pasta dos dados, IA) e os botões "Trocar a IA" e
// "Desligar o Brambit". Quem executa os dois é o lançador, que segura o banco e
// o servidor: o servidor só pede, pelo canal de mensagens (IPC) que o lançador
// abriu ao ligá-lo. Sem esse canal (servidor ligado de outro jeito) as rotas
// nem existem.
//
// Pra todo o resto (outra pessoa logada, ninguém logado), as rotas também não
// existem: SEGUE deixa o servidor responder 404 como pra qualquer caminho
// desconhecido. Os POST passam pela conferência de Origin do servidor (CSRF).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGUE } from '../../web/rotas.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));

// info = o que o lançador conta (BRAMBIT_INSTALACAO); mandar = canal com ele.
export function criarPluginInstalacao({ info = lerInfo(), mandar = process.send?.bind(process) } = {}) {
  return {
    nome: 'instalacao',
    app: [path.join(aqui, 'app')],
    siteTextos: [path.join(aqui, 'site-textos')],
    ligar({ rotas, send }) {
      if (!mandar || !info) return;
      const semCache = { 'cache-control': 'no-store' };
      const doDono = async (ctx) => {
        const admin = String(process.env.ADMIN_EMAIL || '').toLowerCase();
        const u = admin ? await ctx.currentUser() : null;
        return Boolean(u && String(u.email || '').toLowerCase() === admin);
      };
      // Responde primeiro e só então avisa o lançador, que vai parar este servidor.
      const depois = (res, msg) => res.once('finish', () => mandar(msg));

      rotas.registrar('GET', '/api/instalacao', async (req, res, url, ctx) => {
        if (!(await doDono(ctx))) return SEGUE;
        send(res, 200, info, semCache);
      });
      rotas.registrar('POST', '/api/instalacao/desligar', async (req, res, url, ctx) => {
        if (!(await doDono(ctx))) return SEGUE;
        depois(res, { acao: 'desligar' });
        send(res, 200, { ok: true }, semCache);
      });
      // Abre a página de configuração da IA no lugar do app, com um código de uso
      // único que só esta resposta leva (o navegador põe depois do #).
      rotas.registrar('POST', '/api/instalacao/trocar-ia', async (req, res, url, ctx) => {
        if (!(await doDono(ctx))) return SEGUE;
        const codigo = randomBytes(18).toString('base64url');
        depois(res, { acao: 'trocar-ia', codigo });
        send(res, 200, { codigo }, semCache);
      });
    },
  };
}

function lerInfo() {
  try { return JSON.parse(process.env.BRAMBIT_INSTALACAO || 'null'); } catch { return null; }
}
