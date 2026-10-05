-- Conta empresarial F1 (crédito compartilhado da empresa).
-- RODAR ANTES DO DEPLOY do código da F1: o código novo lê e grava
-- execution_credit_calls.org_id em toda reserva de crédito, e o boot do servidor
-- NUNCA cria nem altera esta tabela (ela só nasce por migração explícita).
-- Execução em produção exige OK separado do Marcos.
--
-- Aditiva: não reprecifica, não apaga e não reescreve nada. Reserva antiga fica
-- com org_id NULL, que é exatamente "paga pela pessoa" (o comportamento de hoje).
--
-- Sem FK pra mtr_harness.orgs de propósito: esta migração roda antes do deploy,
-- quando a tabela orgs pode ainda não existir (quem cria é o boot, empresa.mjs).
-- E o registro de cobrança de uma chamada não deve sumir nem mudar de dono junto
-- com a empresa.
BEGIN;
ALTER TABLE mtr_harness.execution_credit_calls ADD COLUMN IF NOT EXISTS org_id uuid;
-- Reservas em aberto da empresa: somadas em toda admissão de qualquer membro.
CREATE INDEX IF NOT EXISTS execution_credit_org_holds_idx ON mtr_harness.execution_credit_calls(org_id)
  WHERE org_id IS NOT NULL AND state IN ('reserved','dispatched','uncertain');
COMMIT;
