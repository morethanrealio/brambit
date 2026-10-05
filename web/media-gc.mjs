// ── Coleta de lixo do bucket (lápides de exclusão) ──
// Apagar um arquivo do usuário são dois passos que não cabem na mesma transação:
// (1) tirar a referência do banco, (2) tirar o objeto do S3. O passo 2 é rede e
// pode falhar. O desenho antigo fazia 1 e engolia a falha de 2, então o objeto
// (foto, documento, rosto biométrico) ficava no bucket pra sempre e SEM registro,
// impossível de reenfileirar.
//
// Agora o passo 1 grava uma LÁPIDE (tabela media_deletions) na mesma transação.
// A lápide é a memória do objeto entre os dois passos: só é fechada quando o
// bucket confirma o delete, e enquanto estiver aberta o varredor tenta de novo.
//
// Este módulo é só a lógica, sem banco nem S3 dentro: as dependências entram por
// parâmetro (deleteMedia/settle/claim). É o que deixa o comportamento testável.

// Tenta apagar o objeto e fechar a lápide. NUNCA lança: falha de bucket vira
// { ok:false, pendente:true } e a lápide continua aberta pro varredor.
export async function apagarObjetoComLapide({ key, tombstoneId, deleteMedia, settle, onErro }) {
  // Sem key não há objeto no bucket (modo disco ou mídia sem arquivo): a lápide,
  // se existir, já nasce cumprida.
  if (!key) {
    if (tombstoneId) await settle?.(tombstoneId, 'done');
    return { ok: true, pendente: false };
  }
  try {
    await deleteMedia(key);
  } catch (e) {
    onErro?.(e, key);
    return { ok: false, pendente: true, erro: e?.message ?? String(e) };
  }
  // Só fecha DEPOIS do bucket confirmar. Se o fechamento falhar, a lápide fica
  // aberta e o varredor repete o delete, que é idempotente (404 conta como ok).
  try {
    if (tombstoneId) await settle?.(tombstoneId, 'done');
  } catch (e) {
    onErro?.(e, key);
    return { ok: true, pendente: true, erro: e?.message ?? String(e) };
  }
  return { ok: true, pendente: false };
}

// Destruição de conta: apaga TODA a mídia do dono do bucket, com lápide.
// A ordem é o ponto: a lápide de todas as keys é gravada ANTES do primeiro delete,
// porque logo depois vem o DELETE da conta, que leva por CASCADE justamente as
// linhas (media_assets/user_likeness) que sabiam dessas keys. Sem esse registro,
// uma falha do bucket deixaria a foto, a voz e o ROSTO biométrico de uma conta
// EXCLUÍDA no bucket pra sempre e sem ninguém pra tentar de novo.
// Falha de bucket nunca lança: o que não sair agora fica pendente pro varredor.
// Falha ao GRAVAR a lápide, sim: destruir a conta sem registro das keys é
// exatamente o que a lápide existe pra impedir, então a rodada seguinte tenta de novo.
export async function purgarMidiaDaConta({ keys = [], registrarLapides, deleteMedia, settle, onErro }) {
  const uteis = [...new Set((keys || []).filter(Boolean))];
  if (!uteis.length) return { total: 0, apagados: 0, pendentes: 0 };
  const lapides = await registrarLapides(uteis);
  let apagados = 0, pendentes = 0;
  for (const l of lapides) {
    const r = await apagarObjetoComLapide({ key: l.s3_key, tombstoneId: l.id, deleteMedia, settle, onErro });
    if (r.ok && !r.pendente) apagados++; else pendentes++;
  }
  return { total: uteis.length, apagados, pendentes };
}

// Varre as lápides abertas e tenta de novo. Falha de uma não para as outras.
export async function varrerLapides({ claim, deleteMedia, settle, onErro, limite = 50 }) {
  const pendentes = await claim(limite);
  let apagados = 0, falhas = 0;
  for (const t of pendentes) {
    const r = await apagarObjetoComLapide({ key: t.s3_key, tombstoneId: t.id, deleteMedia, settle, onErro });
    if (r.ok && !r.pendente) apagados++; else falhas++;
  }
  return { vistos: pendentes.length, apagados, falhas };
}
