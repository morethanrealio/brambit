// Consultas têm conta própria. Não alteram agents.google_email nem o token das
// ferramentas de escrita. As contas disponíveis vêm somente do dono autenticado.
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

export async function runGoogleReadAccounts({ accounts, currentAccount, requested, objetivo, formato, createReadTools, runWorker, onAccountCoverage }) {
  const selected = selectGoogleReadAccounts({ accounts, currentAccount, requested });
  const results = [];
  for (const account of selected) {
    let calls = 0, succeeded = 0;
    try {
      const readTools = (await createReadTools(account)).map(tool => ({ ...tool, async run(args) {
        calls++;
        const raw = await tool.run(args);
        // Erros em JSON/texto não contam como leitura bem-sucedida.
        let parsed; try { parsed = JSON.parse(raw); } catch { /* ferramentas de texto */ }
        if (!parsed?.error && !parsed?.erro && !/^\s*(?:ERRO|ERROR)\b/i.test(String(raw))) succeeded++;
        return raw;
      } }));
      if (!readTools.length) throw new Error('Esta conta não disponibiliza ferramentas de leitura com as permissões atuais.');
      const text = await runWorker({
        objetivo, formato, readTools, account,
        accountContext: `CONTA DESTA CONSULTA: ${account}. Todas as ferramentas abaixo estão vinculadas exclusivamente a ela. O orquestrador consulta as demais contas solicitadas separadamente. Não use from:/to: para trocar de caixa, não conclua nada sobre outras contas e não peça autorização para consultá-las.`,
      });
      const status = succeeded ? 'consulted' : calls ? 'failed' : 'not_consulted';
      onAccountCoverage?.({ account, status });
      results.push(`CONTA: ${account}\nESTADO: ${status}\n${status === 'consulted' ? text : 'Não foi possível obter dados desta conta. Não significa ausência de resultados.'}`);
    } catch (e) {
      onAccountCoverage?.({ account, status:'failed' });
      // Sem erro cru do provedor (pode conter dados privados). Uma falha não
      // impede a consulta às outras contas explicitamente solicitadas.
      results.push(`CONTA: ${account}\nESTADO: failed\nNão consegui concluir esta consulta. Não significa ausência de resultados.`);
    }
  }
  return results.join('\n\n') + '\n\nRelate somente o que foi observado em cada conta. consulted confirma acesso, não busca exaustiva; respeite a cobertura das consultas. Não atribua uma fonte a outra conta. A conta padrão do assistente não foi alterada.';
}
