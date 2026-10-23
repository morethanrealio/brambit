// The ready-made voices of the speech provider the installation uses
// (audio-provider.mjs), for a screen where the person picks one. Gemini's come
// with the style its docs give each voice (ai.google.dev, speech generation);
// the settings screen translates the style (index_script.avatar.style.*).
import { OPENAI_DEFAULT_VOICE, OPENAI_VOICES } from './audio-provider.mjs';

export const GEMINI_DEFAULT_VOICE = 'Kore';
const GEMINI_VOICES = [
  ['Zephyr', 'bright'], ['Puck', 'upbeat'], ['Charon', 'informative'], ['Kore', 'firm'],
  ['Fenrir', 'excitable'], ['Leda', 'youthful'], ['Orus', 'firm'], ['Aoede', 'breezy'],
  ['Callirrhoe', 'easy_going'], ['Autonoe', 'bright'], ['Enceladus', 'breathy'], ['Iapetus', 'clear'],
  ['Umbriel', 'easy_going'], ['Algieba', 'smooth'], ['Despina', 'smooth'], ['Erinome', 'clear'],
  ['Algenib', 'gravelly'], ['Rasalgethi', 'informative'], ['Laomedeia', 'upbeat'], ['Achernar', 'soft'],
  ['Alnilam', 'firm'], ['Schedar', 'even'], ['Gacrux', 'mature'], ['Pulcherrima', 'forward'],
  ['Achird', 'friendly'], ['Zubenelgenubi', 'casual'], ['Vindemiatrix', 'gentle'], ['Sadachbia', 'lively'],
  ['Sadaltager', 'knowledgeable'], ['Sulafat', 'warm'],
];

// provider: 'gemini' | 'openai' (audioProvider()) → [{id, style}] (style null when the provider gives none).
export function readyVoices(provider) {
  if (provider === 'gemini') return GEMINI_VOICES.map(([id, style]) => ({ id, style }));
  if (provider === 'openai') return [...OPENAI_VOICES].map((id) => ({ id, style: null }));
  return [];
}

export function defaultVoice(provider) {
  return provider === 'gemini' ? GEMINI_DEFAULT_VOICE : provider === 'openai' ? OPENAI_DEFAULT_VOICE : null;
}

export const isReadyVoice = (provider, voice) => readyVoices(provider).some((v) => v.id === voice);
