// Libera issue reservada cujo prazo venceu (CONTRIBUTING.md, "Fluxo", passo 2).
// Prazo = rótulo `prazo: N dia(s)` da issue; sem rótulo, PRAZO_PADRAO dias. Conta a
// partir da atribuição ou do último comentário de quem reservou, o que for mais novo.
// Não vence: quem tem PR aberto ligado à issue, nem quem é do time (escrita no repo).
// Rodado pelo workflow reservas.yml; RESERVAS_SIMULAR=1 só lista, não muda nada.
const PRAZO_PADRAO = 7;
const DIA = 86_400_000;
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const simular = process.env.RESERVAS_SIMULAR === '1';
if (!repo || !token) throw new Error('Faltam GITHUB_REPOSITORY e GH_TOKEN.');

async function gh(caminho, { method = 'GET', body } = {}) {
  const r = await fetch(caminho.startsWith('https://') ? caminho : `https://api.github.com${caminho}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${caminho}: HTTP ${r.status}`);
  return { dados: r.status === 204 ? null : await r.json(), proxima: /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '')?.[1] };
}
async function todas(caminho) {
  const itens = [];
  for (let url = caminho; url;) { const { dados, proxima } = await gh(url); itens.push(...dados); url = proxima; }
  return itens;
}

export function prazoDias(rotulos) {
  for (const { name } of rotulos) {
    const m = /^prazo:\s*(\d+)\s*dias?$/i.exec(name);
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  return PRAZO_PADRAO;
}
// Último sinal de vida de `login` na issue, ou null se tem PR aberto dele ligado a ela.
export function ultimaNovidade(linhaDoTempo, login) {
  let ultima = 0;
  for (const e of linhaDoTempo) {
    const pr = e.event === 'cross-referenced' && e.source?.issue;
    if (pr?.pull_request && pr.state === 'open' && pr.user?.login === login) return null;
    const meu = (e.event === 'assigned' && e.assignee?.login === login) || (e.event === 'commented' && e.user?.login === login);
    if (meu) ultima = Math.max(ultima, Date.parse(e.created_at));
  }
  return ultima;
}

async function main() {
  const permissao = new Map();
  const doTime = async (login) => {
    if (!permissao.has(login)) {
      const { dados } = await gh(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
      permissao.set(login, ['admin', 'maintain', 'write'].includes(dados.role_name ?? dados.permission));
    }
    return permissao.get(login);
  };
  let erros = 0;
  const issues = (await todas(`/repos/${repo}/issues?state=open&assignee=*&per_page=100`)).filter((i) => !i.pull_request);
  for (const issue of issues) {
    try {
      const dias = prazoDias(issue.labels);
      const linha = await todas(`/repos/${repo}/issues/${issue.number}/timeline?per_page=100`);
      for (const { login } of issue.assignees) {
        if (await doTime(login)) continue;
        const ultima = ultimaNovidade(linha, login);
        if (ultima === null || Date.now() - ultima < dias * DIA) continue;
        console.log(`#${issue.number}: reserva de @${login} venceu (${dias} dia(s) sem novidade)${simular ? ' [simulação]' : ''}`);
        if (simular) continue;
        await gh(`/repos/${repo}/issues/${issue.number}/assignees`, { method: 'DELETE', body: { assignees: [login] } });
        await gh(`/repos/${repo}/issues/${issue.number}/comments`, { method: 'POST', body: {
          body: `@${login}, o prazo da reserva (${dias} dia(s) sem novidade) venceu e a issue ficou livre de novo. Se ainda estiver trabalhando nela, comente aqui.`,
        } });
      }
    } catch (e) {
      erros++;
      console.error(`::error::#${issue.number}: ${e.message}`);
    }
  }
  console.log(`${issues.length} issue(s) reservada(s) conferida(s).`);
  if (erros) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
