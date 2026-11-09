// ElevenLabs as the voice (elevenlabs.mjs, audio-provider.mjs): only the
// installation's listed voices reach the request, a half-configured choice
// falls back to the audio provider instead of leaving replies without a voice,
// and every model it may bill under has a price. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {elevenlabsVoices,elevenlabsPcm,ELEVENLABS_DEFAULT_MODEL} from '../web/elevenlabs.mjs';
import {speechProvider} from '../web/audio-provider.mjs';
import {priceFor} from '../web/pricing.mjs';

const ENV=['BRAMBIT_SPEECH_PROVIDER','BRAMBIT_AUDIO_PROVIDER','ELEVENLABS_API_KEY','ELEVENLABS_VOICES','ELEVENLABS_MODEL','ELEVENLABS_VOICE_SETTINGS','GEMINI_API_KEY','OPENAI_API_KEY'];
function withEnv(values,fn){
 const saved=Object.fromEntries(ENV.map(k=>[k,process.env[k]]));
 for(const k of ENV)delete process.env[k];
 Object.assign(process.env,values);
 return Promise.resolve().then(fn).finally(()=>{for(const k of ENV){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}});
}

test('voices: id or id:Name, the first is the default; ids that could bend the request path are left out',()=>{
 assert.deepEqual(elevenlabsVoices(' AbCdEfGh12345678:Ana Paula , ../../x:Bad,AbCdEfGh12345678:Again,Zz99Yy88Xx77'),
  [{id:'AbCdEfGh12345678',name:'Ana Paula'},{id:'Zz99Yy88Xx77',name:'Zz99Yy88Xx77'}]);
});

test('speaks with a listed voice, an unlisted one gets the first, and the usage counts characters',()=>withEnv(
 {ELEVENLABS_API_KEY:'test-key',ELEVENLABS_VOICES:'VoiceOne1234:One,VoiceTwo1234:Two'},async()=>{
  const urls=[];
  const fetchImpl=async(url,init)=>{urls.push(url);assert.equal(JSON.parse(init.body).model_id,ELEVENLABS_DEFAULT_MODEL);return new Response(new Uint8Array(480));};
  await elevenlabsPcm('Olá',`VoiceTwo1234`,fetchImpl);
  const {buffer,rate,usage}=await elevenlabsPcm('hello','../admin',fetchImpl);
  assert.match(urls[0],/\/text-to-speech\/VoiceTwo1234\?output_format=pcm_24000$/);
  assert.match(urls[1],/\/text-to-speech\/VoiceOne1234\?/);
  assert.equal(buffer.length,480);assert.equal(rate,24000);
  assert.deepEqual([usage.in,usage.out],[5,0]);
 }));

test('the voice settings reach the request; out of range or not JSON, the voice keeps its own',()=>withEnv(
 {ELEVENLABS_API_KEY:'test-key',ELEVENLABS_VOICES:'VoiceOne1234'},async()=>{
  const bodies=[];
  const fetchImpl=async(url,init)=>{bodies.push(JSON.parse(init.body));return new Response(new Uint8Array(480));};
  const set={stability:0.3,similarity_boost:0.75,style:0.7,use_speaker_boost:true};
  process.env.ELEVENLABS_VOICE_SETTINGS=JSON.stringify(set);
  await elevenlabsPcm('Olá','VoiceOne1234',fetchImpl);
  for(const bad of ['{"style":7}','{"stability":',' ']){process.env.ELEVENLABS_VOICE_SETTINGS=bad;await elevenlabsPcm('Olá','VoiceOne1234',fetchImpl);}
  assert.deepEqual(bodies.map(b=>b.voice_settings),[set,undefined,undefined,undefined]);
 }));

test('elevenlabs without its key or voices speaks with the audio provider',()=>withEnv(
 {BRAMBIT_SPEECH_PROVIDER:'elevenlabs',ELEVENLABS_API_KEY:'test-key',GEMINI_API_KEY:'g'},()=>{
  assert.equal(speechProvider(),'gemini');
  process.env.ELEVENLABS_VOICES='VoiceOne1234';
  assert.equal(speechProvider(),'elevenlabs');
 }));

test('the default model has a price, so its speech is not billed at the fallback rate',()=>{
 assert.equal(priceFor(ELEVENLABS_DEFAULT_MODEL).in,40);
});
