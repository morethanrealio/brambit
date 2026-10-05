// Together's public HTTP schema takes a string enum, even though DeepSeek's
// reference encoder also accepts integers. Keep model internals off the wire.
export const TOGETHER_FLASH_MODEL='deepseek-ai/DeepSeek-V4.1-Flash';
export function flashReasoning(effort,direct=false){
 const value=direct?'low':(effort??'low');
 if(!['low','medium','high'].includes(value))throw Error('Together Flash reasoning effort must be low, medium or high');
 return {reasoning_effort:value};
}
// Admission bound, NOT the provider bill or exact tokenization. Reference model:
// inference/model.py vision_max_n_token=1024; image_processor.safe_resize clamps
// to that cap. Reserve1536/image plus UTF8/framing margin. Actual API usage settles.
// This applies ONLY to this Together route; it does not generalize all image models.
// Calibrated 30/09/2026 on 187 prod calls without cache hint: bytes+framing came
// out at a median 4.5x the real prompt tokens (1st percentile 3.3x), so people
// with long threads were refused calls costing a tenth of the hold. Dividing by
// 2.25 keeps a 2x median margin (1st percentile still 1.46x). Images keep 1536.
const TEXT_OVERESTIMATE=2.25;
export function estimateTogetherFlashInput(spec){
 if(spec?.provider!=='together'||spec.model!==TOGETHER_FLASH_MODEL||spec.body?.model!==TOGETHER_FLASH_MODEL||!Array.isArray(spec.body.messages))throw Error('Unsupported Together quote');
 const body=structuredClone(spec.body);let images=0;
 for(const m of body.messages){
  if(!Array.isArray(m.content))continue;
  m.content=m.content.map(p=>{
   if(p?.type==='text'&&typeof p.text==='string')return p;
   if(p?.type!=='image_url'||m.role!=='user'||typeof p.image_url?.url!=='string'||!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image_url.url))throw Error('Unsupported Together image input');
   if(++images>4)throw Error('Too many images for this route');
   return {type:'image_url',image_url:{url:'[image reserved separately]'}};
  });
 }
 const text=Buffer.byteLength(JSON.stringify(body),'utf8')+512*(body.messages.length+(body.tools?.length||0)+1);
 const tokens=Math.ceil(text/TEXT_OVERESTIMATE)+1536*images;
 if(!Number.isSafeInteger(tokens)||tokens<0)throw Error('Invalid Together quote');
 return tokens;
}
// Never retain error text: providers may echo a private prompt or image URL.
export async function togetherRejectionDiagnostic(response){
 let raw='';const reader=response.body?.getReader?.();
 try{
  if(reader){const decoder=new TextDecoder();let length=0;while(length<16384){const {value,done}=await reader.read();if(done)break;const n=Math.min(value.length,16384-length);raw+=decoder.decode(value.subarray(0,n),{stream:true});length+=n;}}
 }catch{}finally{try{await reader?.cancel();}catch{}}
 let data;try{data=JSON.parse(raw);}catch{}
 const err=data?.error||data||{},param=String(err.param||err.parameter||'');
 const message=String(err.message||'');
 const field=['reasoning_effort','model','max_tokens','messages','tools','image_url'].find(x=>param===x||new RegExp('\\b'+x+'\\b','i').test(message))||'unknown';
 const reason=/must be|invalid|unsupported|expected|not supported|not one of/i.test(message)?'invalid_parameter':/not found|not available|does not exist/i.test(message)?'unavailable':'unclassified';
 return {field,reason};
}
