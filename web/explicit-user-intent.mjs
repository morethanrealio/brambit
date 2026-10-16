// Gates for writes that must originate in the owner's current message. These
// helpers deliberately ignore tool arguments: arguments are proposed by the
// model and cannot authorize their own persistence or an internal escalation.

const normalized = (value) => String(value || '')
  .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Quoted examples and copied instructions are content, not a request. Keep
// apostrophes because they are part of normal English contractions.
const withoutQuotedContent = (value) => normalized(value)
  .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, ' ')
  .replace(/\s+/g, ' ').trim();

const reportedRequest = (text) => /\b(?:ele|ela|eles|elas|alguem|he|she|they|someone|el|ella|ellos|ellas|alguien)\b[^.!?\n]{0,100}\b(?:disse|falou|pediu|mandou|escreveu|said|told|asked|requested|wrote|dijo|pidio|solicito|mando|escribio)\b/.test(text);

export function explicitPermanentMemoryIntent(ownerText, previousAssistantText = '') {
  const t = withoutQuotedContent(ownerText);
  if (!t || reportedRequest(t)) return false;
  if (/\b(?:nao|nunca|not|never|no)\b[^.!?\n]{0,35}\b(?:salv|guard|anot|memor|lembr|corrig|atualiz|alter|troc|substitu|store|save|remember|note|keep|update|correct|change|replace|guardar|recordar|correg|actualiz|cambi|reemplaz)\w*/.test(t)) return false;

  const namesPermanentDestination = /\b(?:memoria|memory|memoria permanente|permanent memory|lista permanente|lista (?:de )?chaves? pix|chave pix|pix key|cnpj)\b/.test(t);

  const direct = [
    // "pode salvar", "guarda isso", "quero que você anote".
    /(?:^|[.!?;,]\s*|\b(?:pode|por favor|quero|gostaria|preciso|vamos|bora)\s+(?:que\s+(?:voce\s+)?)?)(?:salv(?:a|e|ar)|guard(?:a|e|ar)|anot(?:a|e|ar)|memoriz(?:a|e|ar)|lembr(?:a|e|ar))\b/,
    /(?:^|[.!?;,]\s*|\b(?:please|can you|could you|would you|i want you to|i need you to|let us|let's)\s+)(?:save|store|remember|note|keep)\b/,
    /(?:^|[.!?;,]\s*|\b(?:puedes|podrias|por favor|quiero que|necesito que|vamos a)\s+)(?:guarda|guardar|guarde|anota|anotar|anote|recuerda|recordar|recuerde|memoriza|memorizar|salva|salvar)\b/,
  ];
  const updatePermanent = namesPermanentDestination && [
    /(?:^|[.!?;,]\s*|\b(?:pode|por favor|quero|gostaria|preciso|vamos|bora)\s+(?:que\s+(?:voce\s+)?)?)(?:corrig(?:ir|e|a)|atualiz(?:ar|e|a)|alter(?:ar|e|a)|troc(?:ar|e|a)|substitu(?:ir|a|i))\b/,
    /(?:^|[.!?;,]\s*|\b(?:please|can you|could you|would you|i want you to|i need you to|let us|let's)\s+)(?:update|correct|change|replace)\b/,
    /(?:^|[.!?;,]\s*|\b(?:puedes|podrias|por favor|quiero que|necesito que|vamos a)\s+)(?:corrige|corregir|actualiza|actualizar|cambia|cambiar|reemplaza|reemplazar)\b/,
  ].some((re) => re.test(t));
  if (!direct.some((re) => re.test(t)) && !updatePermanent) return false;

  // Informational questions are not permission. "Pode salvar?" remains a
  // direct request and intentionally passes the patterns above.
  if (/^(?:onde|como|quando|por que|what|where|how|when|why|que|donde|como|cuando|por que)\b/.test(t)) return false;
  if (/\b(?:voce|you|tu)\s+(?:ja\s+)?(?:salvou|guardou|anotou|saved|stored|remembered|guardaste|anotaste)\b/.test(t)) return false;
  const hasSubstantiveContent = !/^(?:(?:pode|por favor|please|puedes|podrias)\s+)?(?:salv(?:a|e|ar)|guard(?:a|e|ar)|anot(?:a|e|ar)|memoriz(?:a|e|ar)|lembr(?:a|e|ar)|save|store|remember|note|keep|guarda|guardar|guarde|anota|anotar|anote|recuerda|recordar|recuerde|memoriza|memorizar)(?:\s+(?:isso|isto|that|this|it|eso|esto))?(?:\s+(?:por favor|please))?\??$/.test(t);
  const context = withoutQuotedContent(previousAssistantText);
  const contextOfferedPermanentMemory = /\b(?:memoria(?: permanente| de longo prazo)?|permanent memory|lista permanente|salvar (?:essa|esta|a) chave|guardar (?:essa|esta|a) chave|save (?:this|the) key|guardar (?:esta|la) clave)\b/.test(context);
  return namesPermanentDestination || hasSubstantiveContent || contextOfferedPermanentMemory;
}

export function explicitFeatureRequestIntent(ownerText) {
  const t = withoutQuotedContent(ownerText);
  if (!t || reportedRequest(t)) return false;
  const object = /\b(?:sugestao|feedback|demanda|pedido|ideia|time|equipe|produto|desenvolvimento|feature|request|suggestion|team|product|development|solicitud|sugerencia|equipo|producto|desarrollo)\b/;
  if (!object.test(t)) return false;
  if (/\b(?:nao|nunca|not|never|no)\b[^.!?\n]{0,40}\b(?:registr|anot|envi|mand|encaminh|cri|abr|inclu|coloc|send|submit|log|record|create|forward|registra|anota|envia|manda|crea)\w*/.test(t)) return false;
  if (/^(?:que|qual|quem|onde|como|quando|what|which|who|where|how|when|que|cual|quien|donde|como|cuando)\b/.test(t)) return false;

  return [
    /(?:^|[.!?;,]\s*|\b(?:pode|por favor|quero|gostaria|preciso|vamos|bora)\s+(?:que\s+(?:voce\s+)?)?)(?:registr(?:a|e|ar)|anot(?:a|e|ar)|envi(?:a|e|ar)|mand(?:a|e|ar)|encaminh(?:a|e|ar)|cri(?:a|e|ar)|abr(?:a|ir)|inclu(?:a|ir)|coloc(?:a|ar|que))\b[^.!?\n]{0,100}/,
    /(?:^|[.!?;,]\s*|\b(?:please|can you|could you|would you|i want you to|i need you to|let us|let's)\s+)(?:send|submit|log|record|create|forward|add)\b[^.!?\n]{0,100}/,
    /(?:^|[.!?;,]\s*|\b(?:puedes|podrias|por favor|quiero que|necesito que|vamos a)\s+)(?:registra|registrar|registre|anota|anotar|anote|envia|enviar|envie|manda|mandar|mande|crea|crear|cree|incluye|incluir|incluya)\b[^.!?\n]{0,100}/,
  ].some((re) => re.test(t));
}
