// ── Mídia: geração de imagem, voz (TTS) e transcrição (STT) ──
// Tudo via Gemini (mesma GEMINI_API_KEY do chat). Cada operação devolve
// `usage` no MESMO shape do provider de texto ({ model, in, cached, out,
// think, total }) pra cair no mesmo pipeline de custo/crédito (recordUsages
// -> costOf -> usage_events). Os modelos têm linha própria em pricing.mjs.
//
// As tools seguem o shape do core (name/description/parameters/run). A entrega
// do binário (mostrar no chat, mandar no WhatsApp/Telegram) é feita pelo caller
// via callback onAttachment — aqui a gente só gera, salva e devolve a URL.

import {requireProviderContent} from './execution-credit-errors.mjs';
import {makeTogether,togetherEnabled,TOGETHER_FLASH_MODEL} from '../core-proto/providers/together.mjs';
import {selectedDeepSeek} from '../core-proto/deepseek/scope.mjs';
import {GEMINI_COMPARISON_MODEL,isGeminiComparison} from '../core-proto/deepseek/comparison.mjs';
import {makeGemini} from '../core-proto/providers/gemini.mjs';
import {throwIfAttemptControl} from '../core-proto/provider-attempt.mjs';
import {modeloPara} from '../core-proto/modelos.mjs';
import fs from 'fs';
import path from 'path';
import crypto, { randomUUID } from 'crypto';
import { awsCredentialsConfigured, currentAwsCredentials, getAwsCredentials } from './aws-credentials.mjs';
export { startAwsCredentialRefresh } from './aws-credentials.mjs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { costOf } from './pricing.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(__dirname, 'public', 'media');

const IMAGE_MODEL = 'gemini-2.5-flash-image';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const STT_MODEL = 'gemini-3.5-flash';
// Voz padrão do TTS (pt-BR soa bem na Kore; trocável por tool depois).
const DEFAULT_VOICE = 'Kore';

export function imageEnabled() { return !!process.env.GEMINI_API_KEY; }
export function ttsEnabled() { return !!process.env.GEMINI_API_KEY; }
export function sttEnabled() { return !!process.env.GEMINI_API_KEY; }

// ROUGH estimate of how much credit each media operation uses.
// Based on typical token counts and the pricing.mjs table; the real value varies
// (image size, audio length, chat model chosen for vision).
// Meant to show the user an order of magnitude ("generate image ~X credits").
// `toUnits` converts the US$ cost to the displayed unit (e.g. a plugin's credits);
// without it, the estimate is in US$.
export function mediaEstimates(toUnits = (usd) => usd) {
  // Gerar imagem: ~1290 tokens de saída no modelo de imagem (Nano Banana).
  const image = toUnits(costOf({ model: IMAGE_MODEL, in: 30, out: 1290, total: 1320 }));
  // Ler/entender uma imagem: imagem entra como input (~1100 tok) + resposta curta
  // (~300 tok) no modelo de chat. Uso o 3.5 Flash como referência (tier comum).
  const vision = toUnits(costOf({ model: 'gemini-3.5-flash', in: 1100, out: 300, total: 1400 }));
  // Transcrever áudio curto (~30s): áudio entra como input (~350 tok) no Flash.
  const stt = toUnits(costOf({ model: STT_MODEL, in: 350, out: 40, total: 390 }));
  // Responder em voz (fala curta ~25s): ~600 tokens de áudio de saída no TTS.
  const tts = toUnits(costOf({ model: TTS_MODEL, in: 40, out: 600, total: 640 }));
  return { image, vision, stt, tts };
}

function usageFrom(model, data) {
  const u = data.usageMetadata ?? {};
  return {
    model,
    in: u.promptTokenCount ?? 0,
    cached: u.cachedContentTokenCount ?? 0,
    out: u.candidatesTokenCount ?? 0,
    think: u.thoughtsTokenCount ?? 0,
    total: u.totalTokenCount ?? 0,
  };
}

async function gen(model, body) {
  const key = process.env.GEMINI_API_KEY;
  const res = await fetch(`${BASE}/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gemini ${model} ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Armazenamento S3 PRIVADO por usuário ─────────────────────────────────────
// Se as 4 envs estiverem setadas, a mídia vai pro bucket — que é 100% FECHADO
// ao público. Cada arquivo vive na pasta do dono: a key é "<user_id>/<uuid>.<ext>".
// O backend é o ÚNICO caminho de acesso: lê o byte com a credencial do servidor e
// entrega ao usuário pelo proxy /api/media (sessão + dono conferidos) ou injetando
// o byte direto no canal (WhatsApp/Telegram). Não há link público nem URL assinada.
// Sem as envs, cai no disco local (public/media), comportamento legado.
// Upload/download por SigV4 na mão pra manter o backend zero-dependência.
const S3_BUCKET = () => process.env.S3_BUCKET;
const S3_REGION = () => process.env.S3_REGION || 'us-east-1';
export function s3Enabled() {
  return !!(process.env.S3_BUCKET && awsCredentialsConfigured());
}

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const EMPTY_HASH = sha256hex('');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// Codifica cada segmento do path (mantém as barras), no esquema do S3/SigV4.
const encodeKey = (key) => key.split('/').map((s) => encodeURIComponent(s)).join('/');

// Assina e executa uma requisição S3 (SigV4). `payloadHash` já calculado pelo caller.
// bucket/region são parametrizáveis (default = bucket privado do produto), pra
// reusar a mesma assinatura em outro bucket (ex.: o dedicado de campanha/marketing).
// Credencial: chave fixa do .env ou role da instância (ver aws-credentials.mjs);
// com a role vem o session token, que entra assinado no x-amz-security-token.
async function s3Request(method, key, { body = undefined, contentType = undefined, payloadHash, bucket = S3_BUCKET(), region = S3_REGION() } = {}) {
  const cred = await getAwsCredentials();
  if (!cred) throw new Error('s3: sem credencial AWS');
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const now = new Date();
  const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);
  const canonicalUri = '/' + encodeKey(key);
  // Headers canônicos em ordem alfabética; content-type só entra no PUT.
  const hdrs = [];
  if (contentType) hdrs.push(['content-type', contentType]);
  hdrs.push(['host', host]);
  hdrs.push(['x-amz-content-sha256', payloadHash]);
  hdrs.push(['x-amz-date', amzdate]);
  if (cred.sessionToken) hdrs.push(['x-amz-security-token', cred.sessionToken]);
  const canonicalHeaders = hdrs.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = hdrs.map(([k]) => k).join(';');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${datestamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + cred.secretAccessKey, datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzdate, authorization };
  if (cred.sessionToken) headers['x-amz-security-token'] = cred.sessionToken;
  if (contentType) headers['content-type'] = contentType;
  return fetch(`https://${host}${canonicalUri}`, { method, headers, body });
}

async function s3PutObject(key, body, contentType) {
  const res = await s3Request('PUT', key, { body, contentType, payloadHash: sha256hex(body) });
  if (!res.ok) throw new Error(`s3 put ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return true;
}

async function s3GetObject(key) {
  const res = await s3Request('GET', key, { payloadHash: EMPTY_HASH });
  if (!res.ok) throw new Error(`s3 get ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

// Salva um binário do usuário. No S3 a key fica sob a pasta do dono
// (<userId>/<uuid>.<ext>) e a URL é o PROXY autenticado /api/media?key=...
// (NÃO um link público). No disco cai em /media/<id>.<ext> (estático legado).
export async function putMedia(userId, buffer, ext, mime) {
  const id = randomUUID();
  const name = `${id}.${ext}`;
  if (s3Enabled()) {
    const key = `${userId}/${name}`;
    await s3PutObject(key, buffer, mime || 'application/octet-stream');
    return { key, url: `/api/media?key=${encodeURIComponent(key)}` };
  }
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, name), buffer);
  return { key: null, url: `/media/${name}` };
}

// Recupera o byte de uma mídia guardada no S3 (só faz sentido no modo S3; no
// modo disco a entrega é pelo estático, então devolve null).
export async function fetchMedia(key) {
  if (!s3Enabled() || !key) return null;
  return s3GetObject(key);
}

// Apaga um objeto do bucket. Best-effort: um 404 (já sumiu) conta como sucesso.
// No modo disco tenta remover o arquivo estático correspondente.
export async function deleteMedia(key) {
  if (!key) return false;
  if (s3Enabled()) {
    const res = await s3Request('DELETE', key, { payloadHash: EMPTY_HASH });
    if (!res.ok && res.status !== 404) throw new Error(`s3 delete ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return true;
  }
  try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(key))); } catch {}
  return true;
}

// Builds a presigned HTTPS GET URL (SigV4, query-string) for a PRIVATE S3 key,
// valid for `expiresSec`. Used to hand media from the private bucket to an
// EXTERNAL SERVICE (e.g. the video worker, which downloads the anchor photo
// over HTTPS when creating the job) without exposing the bucket or sharing a
// credential: the signature carries the authorization and expires.
// No x-amz-content-sha256; presigned GET payload = UNSIGNED-PAYLOAD.
// With the instance role, the URL carries X-Amz-Security-Token and is valid at
// most until the temporary credential expires. Synchronous: uses the cached
// credential and returns null if the role hasn't answered yet (callers handle it).
export function presignGet(key, expiresSec = 900, { bucket = S3_BUCKET(), region = S3_REGION(), now = new Date() } = {}) {
  const cred = currentAwsCredentials();
  if (!key || !cred || !bucket) return null;
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);
  const canonicalUri = '/' + encodeKey(key);
  const scope = `${datestamp}/${region}/s3/aws4_request`;
  const expires = Math.min(Math.max(1, Math.round(expiresSec)), 604800); // teto S3 = 7d
  const signedHeaders = 'host';
  // Query canônica em ordem alfabética, cada valor RFC3986-encoded.
  const q = new Map([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cred.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzdate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ]);
  if (cred.sessionToken) q.set('X-Amz-Security-Token', cred.sessionToken);
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const canonicalQuery = [...q.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + cred.secretAccessKey, datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ── Bucket dedicado de CAMPANHA/marketing (separado do bucket privado) ───────
// Since 13/08: campaign media is public with a different lifecycle, so it
// lives in its own bucket (CAMPAIGN_S3_BUCKET), not under campanhas/ in the
// private one. Same AWS credentials; only bucket/region change. Reuses SigV4.
const CAMPAIGN_BUCKET = () => process.env.CAMPAIGN_S3_BUCKET;
const CAMPAIGN_REGION = () => process.env.CAMPAIGN_S3_REGION || process.env.S3_REGION || 'us-east-1';
export function campaignS3Enabled() {
  return !!(process.env.CAMPAIGN_S3_BUCKET && awsCredentialsConfigured());
}

// Grava um asset de campanha na key informada (ex.: campanhas/<slug>/<tipo>/<uuid>.<ext>).
export async function putCampaignObject(key, body, contentType) {
  const res = await s3Request('PUT', key, {
    body, contentType, payloadHash: sha256hex(body),
    bucket: CAMPAIGN_BUCKET(), region: CAMPAIGN_REGION(),
  });
  if (!res.ok) throw new Error(`campaign s3 put ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return true;
}

export async function getCampaignObject(key) {
  if (!campaignS3Enabled() || !key) return null;
  const res = await s3Request('GET', key, {
    payloadHash: EMPTY_HASH, bucket: CAMPAIGN_BUCKET(), region: CAMPAIGN_REGION(),
  });
  if (!res.ok) throw new Error(`campaign s3 get ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

export async function deleteCampaignObject(key) {
  if (!campaignS3Enabled() || !key) return false;
  const res = await s3Request('DELETE', key, {
    payloadHash: EMPTY_HASH, bucket: CAMPAIGN_BUCKET(), region: CAMPAIGN_REGION(),
  });
  if (!res.ok && res.status !== 404) throw new Error(`campaign s3 delete ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

// Link HTTPS pré-assinado de GET pro asset de campanha (entrega temporária ao
// admin / worker do ComfyUI sem expor o bucket).
export function presignCampaignGet(key, expiresSec = 900) {
  if (!campaignS3Enabled() || !key) return null;
  return presignGet(key, expiresSec, { bucket: CAMPAIGN_BUCKET(), region: CAMPAIGN_REGION() });
}

// Compat: salva sem dono (usado só onde não há userId). Mantém o disco como
// destino quando o S3 está ligado — evita gravar fora de uma pasta de usuário.
async function saveMedia(buffer, ext, mime) {
  const id = randomUUID();
  const name = `${id}.${ext}`;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, name), buffer);
  return { url: `/media/${name}` };
}

// ── Visão: relê uma imagem guardada e descreve/responde em texto ──
// O resultado de uma tool no core é só texto, então pra o agente "ver de novo"
// uma imagem antiga a gente faz uma releitura por visão (imagem -> texto). Devolve
// { text, usage } no shape padrão pra cair no pipeline de crédito.
export async function describeImage(buffer, mime, question, { maxOut = 0 } = {}) {
  const q = (question && question.trim())
    ? question.trim()
    : 'Descreva objetivamente o conteúdo desta imagem em português do Brasil, incluindo qualquer texto legível.';
  // Covers initial captions, stored-image rereads and connector image OCR too.
  // Explicit per-agent DeepSeek remains authoritative over the global default.
  if (isGeminiComparison()) {
    if (!imageEnabled()) throw new Error('Gemini 3.7 Flash indisponível. Nenhum outro modelo foi usado.');
    const result=await makeGemini({model:GEMINI_COMPARISON_MODEL,search:false,maxOutputTokens:maxOut || 32768}).complete({messages:[{role:'user',content:q,images:[{mimeType:mime || 'image/jpeg',data:buffer.toString('base64')}]}]});
    requireProviderContent(result);
    return {text:result.text || '',usage:result.usage,truncated:result.protocolError?.code === 'output_truncated'};
  }
  const selected = selectedDeepSeek(maxOut || 32768);
  const configurado = !selected && modeloPara('leitura_imagem', { maxTokens: maxOut || 32768 }); // modelos.yaml
  if (configurado) {
    const result = await configurado.complete({messages:[{role:'user',content:q,images:[{mimeType:mime || 'image/jpeg',data:buffer.toString('base64')}]}]});
    requireProviderContent(result);
    return {text:result.text || '',usage:result.usage,truncated:result.protocolError?.code === 'output_truncated'};
  }
  const useTogether = (process.env.PRIMARY_TEXT_MODEL ?? TOGETHER_FLASH_MODEL) === TOGETHER_FLASH_MODEL && togetherEnabled();
  if (selected || useTogether) {
    try {
      const provider = selected || makeTogether({model:TOGETHER_FLASH_MODEL,maxTokens:maxOut || 32768,reasoningEffort:'low'});
      const result = await provider.complete({messages:[{role:'user',content:q,images:[{mimeType:mime || 'image/jpeg',data:buffer.toString('base64')}]}]});
      requireProviderContent(result);
      return {text:result.text || '',usage:result.usage,truncated:result.protocolError?.code === 'output_truncated'};
    } catch (error) {
      throwIfAttemptControl(error);
      if (selected) throw error; // never escape an explicit account model selection
      console.error('[media vision] Together unavailable; using Gemini fallback');
    }
  }
  const data = await gen('gemini-3.5-flash', {
    contents: [{ role: 'user', parts: [
      { text: q },
      { inlineData: { mimeType: mime || 'image/jpeg', data: buffer.toString('base64') } },
    ] }],
    // maxOut = teto de saída, pra leitura longa (a legenda rica do recebimento)
    // caber inteira sem cortar no meio. Sem ele vale o default do modelo, que é o
    // comportamento de todos os chamadores antigos.
    generationConfig: { thinkingConfig: { thinkingBudget: 0 }, ...(maxOut ? { maxOutputTokens: maxOut } : {}) },
  });
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  const usage = usageFrom('gemini-3.5-flash', data);
  console.log(`[media vision] in=${usage.in} out=${usage.out} total=${usage.total}`);
  return { text, usage, truncated: data.candidates?.[0]?.finishReason === 'MAX_TOKENS' };
}

// OCR de PDF via Gemini: pro caso do pdf-parse voltar vazio (PDF escaneado, só
// imagem, sem camada de texto). Manda os bytes do PDF direto pro Gemini (que lê
// PDF nativamente) e pede o texto legível. Devolve { text, usage } no mesmo
// shape do resto pra cair no pipeline de custo. Bom pra boleto/guia (DAS/DARF):
// puxa a linha digitável, valores e datas que o pdf-parse não pega.
export async function ocrPdf(buffer, question) {
  const q = (question && question.trim())
    ? question.trim()
    : 'Extraia TODO o texto legível deste documento em português do Brasil, na ordem em que aparece. Preserve números, códigos, valores e datas exatamente como estão. Se for um boleto ou guia (DAS, DARF, boleto bancário), destaque no início a LINHA DIGITÁVEL completa (a sequência de números para pagamento) e o valor e a data de vencimento.';
  const data = await gen('gemini-3.5-flash', {
    contents: [{ role: 'user', parts: [
      { text: q },
      { inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } },
    ] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  });
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  const usage = usageFrom('gemini-3.5-flash', data);
  console.log(`[media ocr-pdf] in=${usage.in} out=${usage.out} total=${usage.total}`);
  return { text, usage };
}

// ── Imagem (Nano Banana) ──
// Proporções que o modelo aceita. Sem pedir nada, ele escolhe sozinho e o
// resultado costuma sair 16:9, que no WhatsApp/Instagram vira imagem com tarja
// ou cortada. Como a composição depois cola o texto e o logo em cima de um
// FUNDO, a proporção do fundo tem que ser a mesma da arte final, senão a peça
// nasce torta.
export const PROPORCOES_IMAGEM = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export async function generateImage(prompt, { proporcao = '' } = {}) {
  const ar = PROPORCOES_IMAGEM.includes(String(proporcao).trim()) ? String(proporcao).trim() : null;
  const data = await gen(IMAGE_MODEL, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], ...(ar ? { imageConfig: { aspectRatio: ar } } : {}) },
  });
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) throw new Error('o modelo não devolveu imagem');
  const mime = img.inlineData.mimeType || 'image/png';
  const ext = mime.split('/')[1] || 'png';
  const buffer = Buffer.from(img.inlineData.data, 'base64');
  const usage = usageFrom(IMAGE_MODEL, data);
  console.log(`[media image] in=${usage.in} out=${usage.out} total=${usage.total}`);
  return { buffer, mime, ext, usage };
}

// ── Voz (TTS) ── Gemini devolve PCM 16-bit 24kHz mono (audio/L16); embrulhamos
// num WAV (toca no navegador e converte fácil pros canais).
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Lê o sampleRate do mimeType (ex: "audio/L16;codec=pcm;rate=24000").
function rateFromMime(mime) {
  const m = /rate=(\d+)/.exec(mime || '');
  return m ? +m[1] : 24000;
}

// Converte um buffer (WAV) pra OGG/Opus via ffmpeg (stdin->stdout). É o formato
// que WhatsApp e Telegram aceitam como nota de voz, e o navegador toca igual.
// Se o ffmpeg não estiver disponível ou falhar, devolve null (caller cai no WAV).
function toOggOpus(wavBuffer) {
  return new Promise((resolve) => {
    let ff;
    try {
      ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-ar', '24000', '-ac', '1', '-f', 'ogg', 'pipe:1']);
    } catch { return resolve(null); }
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    ff.stdin.on('error', () => {});
    ff.stdin.end(wavBuffer);
  });
}

// Converte um áudio qualquer (webm/opus do navegador, ogg, mp3, etc.) pra WAV
// PCM 16kHz mono via ffmpeg (stdin->stdout). É o formato mais universal pro
// worker de vídeo consumir a voz de referência. Se o ffmpeg não estiver
// disponível ou falhar, devolve null (o caller decide o fallback).
export function audioToWav(inputBuffer) {
  return new Promise((resolve) => {
    let ff;
    try {
      ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1']);
    } catch { return resolve(null); }
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    ff.stdin.on('error', () => {});
    ff.stdin.end(inputBuffer);
  });
}

export async function synthesizeSpeech(text, voice = DEFAULT_VOICE) {
  const data = await gen(TTS_MODEL, {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const aud = parts.find((p) => p.inlineData?.data);
  if (!aud) throw new Error('o modelo não devolveu áudio');
  const pcm = Buffer.from(aud.inlineData.data, 'base64');
  const wav = pcmToWav(pcm, rateFromMime(aud.inlineData.mimeType));
  const usage = usageFrom(TTS_MODEL, data);
  console.log(`[media tts] in=${usage.in} out=${usage.out} total=${usage.total}`);
  // Preferimos OGG/Opus (nota de voz nativa no WhatsApp/Telegram); WAV é fallback.
  const ogg = await toOggOpus(wav);
  if (ogg) return { buffer: ogg, mime: 'audio/ogg', ext: 'ogg', usage };
  // WAV toca na web, mas o WhatsApp recusa (02/10/2026: prod sem ffmpeg, a voz
  // nunca chegou no WhatsApp e o assistente confirmava "mandado em voz").
  console.error('[media tts] ffmpeg indisponível ou falhou: áudio saiu em WAV, que o WhatsApp recusa');
  return { buffer: wav, mime: 'audio/wav', ext: 'wav', usage };
}

// ── Transcrição (STT) ── áudio entra como input multimodal no Flash.
export async function transcribeAudio(buffer, mime = 'audio/ogg') {
  const data = await gen(STT_MODEL, {
    contents: [{ role: 'user', parts: [
      { text: 'Transcreva o áudio a seguir no idioma em que foi falado (normalmente português do Brasil; se a pessoa falar inglês ou outra língua, transcreva nessa língua, sem traduzir). Devolva APENAS o texto falado, sem comentários, sem aspas.' },
      { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
    ] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  });
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  const usage = usageFrom(STT_MODEL, data);
  console.log(`[media stt] in=${usage.in} out=${usage.out} total=${usage.total} -> ${text.length} chars`);
  return { text, usage };
}

// ── Tools de mídia pro tool-loop ──
// onUsage({usage, kind})  -> caller grava o custo (créditos) com o kind certo.
// onAttachment({type,url,mime,key}) -> caller entrega o binário no canal (chat/WhatsApp/Telegram).
// saveBlob({buffer,ext,mime,kind,caption}) -> persiste o binário (S3 na pasta do
//   dono + registra na biblioteca) e devolve { url, key }. Se não vier, cai no
//   putMedia direto (sem registrar na biblioteca).
export function mediaTools(userId, { onUsage = () => {}, onAttachment = () => {}, audio = false, image = true, saveBlob = null } = {}) {
  const store = saveBlob || ((b) => putMedia(userId, b.buffer, b.ext, b.mime));
  const tools = [];

  if (image && imageEnabled()) tools.push({
    name: 'gerar_imagem',
    description: 'DRAWS a new image from a text description (prompt). Use when the user asks to create/draw/illustrate. The image is shown to the user automatically; in your reply do NOT describe the image in detail, just comment briefly. LIMITS, respect them: it INVENTS everything it draws, so (a) it is NOT suitable for placing someone\'s real logo/brand/photo (it comes out as a similar logo, not theirs) and (b) it gets letters and accents wrong when text is requested inside the artwork. When the image must contain a logo or correct words, generate only the BACKGROUND here (no text, no brand) and then call compor_imagem, which pastes the original file and writes the text with a real font.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the desired image (English usually renders better, but pt-BR works). Do NOT ask for text written inside the image: the model gets letters and accents wrong. Text and logo come in later, with compor_imagem.' },
        proporcao: { type: 'string', enum: PROPORCOES_IMAGEM, description: 'Image format. Without this the model chooses on its own (it usually comes out 16:9). Use 1:1 for WhatsApp/Instagram, 9:16 for a story, 16:9 for a cover.' },
      },
      required: ['prompt'],
    },
    async run({ prompt, proporcao }) {
      if (!prompt || !prompt.trim()) return 'ERRO: descreva a imagem que você quer gerar.';
      const { buffer, mime, ext, usage } = await generateImage(prompt, { proporcao });
      onUsage({ usage, kind: 'image' });
      const saved = await store({ buffer, ext, mime, kind: 'image', source: 'generated', caption: prompt.slice(0, 200) });
      const { url, key, assetId } = saved;
      onAttachment({ type: 'image', url, mime, key });
      // Devolve o id da biblioteca pra esta imagem poder virar CAMADA numa
      // composição (fundo de um cartão, por exemplo) sem o usuário ter que
      // reenviá-la; sem o id, compor_imagem não tem como referenciá-la.
      const ref = assetId != null ? ` id na biblioteca: ${assetId} (use este id se for compor algo por cima dela com compor_imagem).` : '';
      return `Imagem gerada e já enviada ao usuário (URL: ${url}).${ref} Responda em uma frase curta.`;
    },
  });

  if (audio && ttsEnabled()) {
    tools.push({
      name: 'gerar_audio',
      description: 'Converts a text into speech (voice message). Use ONLY when the user asks you to reply/speak in audio or read something aloud, in this message or in a standing request they left in place. The audio is sent to the user automatically.',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'The text to be spoken, in the language it should sound in (default Brazilian Portuguese; e.g.: English in an English practice session).' },
        },
        required: ['texto'],
      },
      async run({ texto }) {
        if (!texto || !texto.trim()) return 'ERRO: informe o texto a ser falado.';
        const { buffer, mime, ext, usage } = await synthesizeSpeech(texto.slice(0, 2000));
        onUsage({ usage, kind: 'tts' });
        const { url, key } = await store({ buffer, ext, mime, kind: 'audio', source: 'generated', caption: texto.slice(0, 120) });
        // `fala` vai junto pro canal mandar o texto se o áudio não puder ser entregue.
        onAttachment({ type: 'audio', url, mime, key, fala: texto.slice(0, 2000) });
        return `Áudio gerado e já enviado ao usuário (URL: ${url}). Confirme em uma frase curta.`;
      },
    });
  }

  return tools;
}
