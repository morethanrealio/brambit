export function providerFailureDiagnostic(error,elapsedMs) {
  const status=Number.isInteger(error?.httpStatus) && error.httpStatus>=100 && error.httpStatus<=599 ? error.httpStatus : null;
  const code=error?.code || error?.cause?.code;
  const category=code==='PROVIDER_USAGE_MISSING'?'usage_missing'
    : code==='PROVIDER_IDLE_TIMEOUT'?'idle_timeout'
    : status?'http_error'
    : ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code)?'transport_error'
    : ['AbortError','TimeoutError'].includes(error?.name)?'aborted'
    : 'unclassified_failure';
  return {category,status,elapsedMs:Math.max(0,Math.round(elapsedMs))};
}
