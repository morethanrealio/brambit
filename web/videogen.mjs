// ── Cliente do worker de geração de vídeo (ComfyUI/H3, via wrapper HTTP) ──
// A geração de vídeo das pessoas roda FORA do harness, num worker GPU (ComfyUI
// na Mumbai) exposto por um wrapper HTTP fino da Yume. O fluxo é ASSÍNCRONO:
//   1) createRender() cria o job (POST /v1/render) e devolve { job_id, ... }
//   2) getRender(jobId) faz poll (GET /v1/render/{id}) até status done|error
//   3) fetchRenderVideo(jobId) baixa o mp4 (GET /v1/render/{id}/video)
//
// Contrato (Yume 05/08): image_url e audio_url podem ser URLs S3 pré-assinadas
// (o worker baixa por HTTPS no momento de criar o job). duration é OBRIGATÓRIO
// quando não há audio_url; com áudio, a duração sai do próprio áudio. Teto de
// 15s é do lado do worker também (duration>15 -> 400), mas validamos aqui antes.
//
// Cobrança: pelo `video_seconds` REAL que volta no GET quando done, não pelo
// `credits_seconds` estimado do POST nem pelo tempo de processamento.

import { lerCorpoComTeto } from './baixar-corpo.mjs';

const COMFY_URL = () => (process.env.COMFY_URL || '').replace(/\/+$/, '');
const COMFY_TOKEN = () => process.env.COMFY_TOKEN || '';

export const MAX_VIDEO_SECONDS = 15;
// Teto de download do mp4. Um vídeo de até 15s não chega perto disso; o teto está
// aqui pra um corpo que não acaba nunca não comer a memória do processo.
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

// Só habilita a feature quando as duas variáveis estão presentes. Enquanto o
// endpoint não estiver vivo, a tool nem se oferece a gerar (fica "em breve").
export function videoGenEnabled() {
  return !!(COMFY_URL() && COMFY_TOKEN());
}

// ── Freio de PRODUTO: geração de vídeo EM REVISÃO (22/09/2026) ──
// Diferente do videoGenEnabled() acima (que só diz se o worker GPU está de pé),
// este é o freio de PRODUTO: enquanto a feature está em revisão pelo time, a tool
// `gerar_video` não é registrada e a seção de verificação de identidade some do
// app. Assim o assistente nem sabe que vídeo existe e não promete o que não pode
// entregar (era o que acontecia: a promessa nascia da descrição da tool, e o
// freio só aparecia depois, dentro do run).
// LIGADO POR PADRÃO: religar a feature é um ato explícito (VIDEO_EM_REVISAO=0 no
// .env do box), nunca um esquecimento.
// O poller (pollVideoJobs) segue rodando de propósito: job criado ANTES da
// revisão continua sendo entregue ao dono.
export function videoEmRevisao() {
  return String(process.env.VIDEO_EM_REVISAO ?? '1') !== '0';
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${COMFY_TOKEN()}`, ...extra };
}

// ATENÇÃO (achado #26): o relógio vale só enquanto a função de dentro está
// rodando. O finally limpa o timer, então LER O CORPO da resposta depois que o
// withTimeout retornou é ler sem prazo nenhum e sem ninguém pra abortar. Tudo que
// precisa caber no prazo tem que acontecer DENTRO do callback.
async function withTimeout(promise, ms, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`${label} timeout (${ms}ms)`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Cria o job. Retorna { job_id, status, estimated_video_seconds, credits_seconds }.
//   imageUrl        (req) — foto-âncora de FRENTE (URL S3 pré-assinada) -> <Picture 1>
//   prompt          (req) — SÓ a cena/ação (no modo clone a fala NÃO vai aqui)
//   audioUrl        (opt) — áudio de referência
//   voiceCloneOnly  (opt) — modo clone: audioUrl vira só referência de TIMBRE e a
//                           fala vem de speechText (o server NÃO repete o áudio).
//                           Exige audioUrl + speechText. Duração deriva do texto
//                           (não mandar duration, senão a fala embola no fim).
//   speechText      (opt) — as palavras exatas a falar (obrigatório no modo clone).
//   duration        (opt) — segundos; OBRIGATÓRIO quando não há audioUrl. No clone,
//                           deixe null pra o server dimensionar pelo texto.
//   appImageUrl     (opt) — referência de app (screenshot) -> vem depois no numbering
//   faceRefUrls     (opt) — até 2 fotos EXTRA do MESMO rosto (outro ângulo/expressão),
//                           URLs S3 pré-assinadas. Entram como <Picture 2>/<Picture 3>
//                           "mesma pessoa, outro ângulo" e ajudam a reconstruir os
//                           traços. Contrato Yume 07/08: lista de strings, máx 2 (VRAM
//                           do L40S); mais que isso o worker rejeita com 400. Omitir
//                           quando o usuário só tem a âncora (retrocompatível).
export async function createRender({ imageUrl, prompt, audioUrl = null, voiceCloneOnly = false, speechText = null, duration = null, appImageUrl = null, faceRefUrls = [] } = {}) {
  if (!videoGenEnabled()) throw new Error('video gen desabilitado (COMFY_URL/COMFY_TOKEN ausentes)');
  if (!imageUrl) throw new Error('imageUrl obrigatório');
  if (!prompt || !String(prompt).trim()) throw new Error('prompt obrigatório');
  if (voiceCloneOnly && (!audioUrl || !speechText || !String(speechText).trim())) {
    throw new Error('modo clone exige audioUrl e speechText');
  }
  if (!audioUrl && duration == null) throw new Error('duration obrigatório quando não há audioUrl');
  if (duration != null && Number(duration) > MAX_VIDEO_SECONDS) throw new Error(`duration excede ${MAX_VIDEO_SECONDS}s`);

  const body = { image_url: imageUrl, prompt: String(prompt) };
  if (audioUrl) body.audio_url = audioUrl;
  if (voiceCloneOnly) { body.voice_clone_only = true; body.speech_text = String(speechText); }
  // No modo clone a duração sai do speech_text; só mandamos duration fora do clone.
  if (duration != null && !voiceCloneOnly) body.duration = Number(duration);
  if (appImageUrl) body.app_image_url = appImageUrl;
  // Fotos extras do mesmo rosto (máx 2). Só strings não-vazias; corta em 2 pra não
  // tomar 400 do worker (a validação dele exige lista de strings, tamanho <= 2).
  const refs = (Array.isArray(faceRefUrls) ? faceRefUrls : [])
    .filter((u) => typeof u === 'string' && u).slice(0, 2);
  if (refs.length) body.face_ref_urls = refs;

  const j = await withTimeout(async (signal) => {
    const res = await fetch(`${COMFY_URL()}/v1/render`, {
      method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body), signal,
    });
    if (!res.ok) throw new Error(`createRender ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }, 30_000, 'createRender');
  if (!j?.job_id) throw new Error('createRender: resposta sem job_id');
  return j;
}

// Faz o poll de um job. Retorna { status, video_seconds, video_url, error }.
// status ∈ queued | processing | done | error.
export async function getRender(jobId) {
  if (!videoGenEnabled()) throw new Error('video gen desabilitado');
  if (!jobId) throw new Error('jobId obrigatório');
  return withTimeout(async (signal) => {
    const res = await fetch(`${COMFY_URL()}/v1/render/${encodeURIComponent(jobId)}`, {
      method: 'GET', headers: authHeaders(), signal,
    });
    if (!res.ok) throw new Error(`getRender ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }, 20_000, 'getRender');
}

// Baixa o mp4 gerado. Retorna { buffer, contentType }.
//
// Achado #26: os 120s cobriam só o aperto de mão. O withTimeout devolvia a
// resposta assim que os CABEÇALHOS chegavam e o finally já limpava o timer, então
// o download do arquivo (que é justamente a parte demorada) corria sem prazo e sem
// ninguém pra abortar. Worker lento ou socket meio-morto travava o poller de vídeo
// PRA SEMPRE, e como o dono só pode ter 1 vídeo em andamento, ele ficava sem poder
// pedir outro. Agora a leitura do corpo acontece dentro do mesmo relógio, e com
// teto de bytes.
export async function fetchRenderVideo(jobId, { timeoutMs = 120_000, maxBytes = MAX_VIDEO_BYTES } = {}) {
  if (!videoGenEnabled()) throw new Error('video gen desabilitado');
  if (!jobId) throw new Error('jobId obrigatório');
  return withTimeout(async (signal) => {
    const res = await fetch(`${COMFY_URL()}/v1/render/${encodeURIComponent(jobId)}/video`, {
      method: 'GET', headers: authHeaders(), signal,
    });
    if (!res.ok) throw new Error(`fetchRenderVideo ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const buffer = await lerCorpoComTeto(res, maxBytes, 'fetchRenderVideo');
    return { buffer, contentType: res.headers.get('content-type') || 'video/mp4' };
  }, timeoutMs, 'fetchRenderVideo');
}
