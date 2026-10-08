// Queries have their own account. They don't change agents.google_email or
// the write tools' token. The available accounts come only from the
// authenticated owner.
export function selectGoogleReadAccounts({ accounts, currentAccount, requested }) {
  const available = new Set(accounts.map(a => a.google_email));
  const values = requested === undefined ? [currentAccount] : requested;
  if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v.trim())) {
    throw new Error('Informe pelo menos uma conta Google para consultar.');
  }
  const selected = [...new Set(values.map(v => v.trim().toLowerCase()))];
  if (selected.some(v => !available.has(v))) throw new Error('Uma das contas solicitadas não está conectada a este usuário. Nenhuma outra conta foi usada no lugar dela.');
  return selected;
}

// A dead connection (revoked/expired grant) isn't a Google failure: the
// person needs to reconnect, and the assistant has to tell them so. The
// token error carries this code; an account with no token at all already
// arrives dead.
export const GOOGLE_RECONNECT = 'google_reconnect';
export const googleReconnectError = message => Object.assign(new Error(message), { code: GOOGLE_RECONNECT });
// Only counts as dead when the tokens came back and were cleared
// (clearGoogleAccount).
const apagado = v => v === null || v === '';
const grantMorto = row => !!row && apagado(row.access_token) && apagado(row.refresh_token);
const reconnectPadrao = account => `A conexão com o Google da conta ${account} expirou ou foi revogada e precisa ser refeita em Conexões › Google.`;
const reconectar = (account, reconnectMessage) => `CONTA: ${account}\nESTADO: needs_reconnect\n${reconnectMessage(account)}\nDiga isso à pessoa e peça que reconecte. Não diga que o Google não respondeu nem que não há resultados.`;

export async function runGoogleReadAccounts({ accounts, currentAccount, requested, objetivo, formato, createReadTools, runWorker, onAccountCoverage, reconnectMessage = reconnectPadrao }) {
  const selected = selectGoogleReadAccounts({ accounts, currentAccount, requested });
  const results = [];
  for (const account of selected) {
    const precisaReconectar = () => {
      onAccountCoverage?.({ account, status:'needs_reconnect' });
      results.push(reconectar(account, reconnectMessage));
    };
    if (grantMorto(accounts.find(a => a.google_email === account))) { precisaReconectar(); continue; }
    let calls = 0, succeeded = 0, reconnect = false;
    // Marks the account when the token dies mid-query, even if the tool
    // swallows the error and returns text.
    const wrapToken = token => async () => {
      try { return await token(); } catch (e) { if (e?.code === GOOGLE_RECONNECT) reconnect = true; throw e; }
    };
    try {
      const readTools = (await createReadTools(account, wrapToken)).map(tool => ({ ...tool, async run(args) {
        calls++;
        const raw = await tool.run(args);
        // Errors in JSON/text don't count as a successful read.
        let parsed; try { parsed = JSON.parse(raw); } catch { /* text tools */ }
        if (!parsed?.error && !parsed?.erro && !/^\s*(?:ERRO|ERROR)\b/i.test(String(raw))) succeeded++;
        return raw;
      } }));
      if (!readTools.length) throw new Error('Esta conta não disponibiliza ferramentas de leitura com as permissões atuais.');
      const text = await runWorker({
        objetivo, formato, readTools, account,
        accountContext: `CONTA DESTA CONSULTA: ${account}. Todas as ferramentas abaixo estão vinculadas exclusivamente a ela. O orquestrador consulta as demais contas solicitadas separadamente. Não use from:/to: para trocar de caixa, não conclua nada sobre outras contas e não peça autorização para consultá-las.`,
      });
      if (!succeeded && reconnect) { precisaReconectar(); continue; }
      const status = succeeded ? 'consulted' : calls ? 'failed' : 'not_consulted';
      onAccountCoverage?.({ account, status });
      results.push(`CONTA: ${account}\nESTADO: ${status}\n${status === 'consulted' ? text : 'Não foi possível obter dados desta conta. Não significa ausência de resultados.'}`);
    } catch (e) {
      if (reconnect || e?.code === GOOGLE_RECONNECT) { precisaReconectar(); continue; }
      onAccountCoverage?.({ account, status:'failed' });
      // No raw provider error (it may contain private data). One failure
      // doesn't block the query to the other explicitly requested accounts.
      results.push(`CONTA: ${account}\nESTADO: failed\nNão consegui concluir esta consulta. Não significa ausência de resultados.`);
    }
  }
  return results.join('\n\n') + '\n\nRelate somente o que foi observado em cada conta. consulted confirma acesso, não busca exaustiva; respeite a cobertura das consultas. Não atribua uma fonte a outra conta. A conta padrão do assistente não foi alterada.';
}
