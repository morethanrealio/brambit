// Leitor de .xlsx SEM dependência externa (mesma filosofia zero-dep do docgen.mjs).
// Um .xlsx é um ZIP de XMLs. A gente abre o ZIP na unha (diretório central +
// inflateRaw nativo do zlib) e lê xl/sharedStrings.xml + xl/worksheets/sheetN.xml,
// devolvendo o conteúdo como CSV (uma planilha vira texto que o modelo entende).
import zlib from 'node:zlib';
import {posix} from 'node:path';

// ---- ZIP: lê as entradas pelo End Of Central Directory + diretório central ----
function readZipEntries(buf) {
  // EOCD: assinatura 0x06054b50, procurada a partir do fim (comentário pode existir).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx inválido: não achei o fim do ZIP (EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // início do diretório central
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // fim/entrada inválida
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries[name] = { method, compSize, localOff };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  if (!entry) return null;
  // Cabeçalho local: recalcula o início dos dados (nome/extra podem diferir do central).
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('xlsx inválido: cabeçalho local ausente');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data; // stored
  if (entry.method === 8) return zlib.inflateRawSync(data); // deflate
  throw new Error(`xlsx: método de compressão ${entry.method} não suportado`);
}

// ---- XML mínimo (formato controlado; regex serve e evita dep de parser) ----
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // por último
}

// Texto de um bloco <si>/<is>: concatena todos os <t>...</t> (inclui runs <r><t>).
function textOfNode(xml) {
  let out = '';
  const re = /<t\b[^>]*?\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1] != null ? decodeXml(m[1]) : '';
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  // Autofechada primeiro pelo mesmo motivo do <row>/<c>: '<si/>' faria o ramo
  // com corpo engolir a string seguinte e desalinhar TODA a tabela de textos (achado #19).
  const re = /<si\b[^>]*?\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) strings.push(m[1] != null ? textOfNode(m[1]) : '');
  return strings;
}

// Letra da coluna ("A","AB") -> índice 0-based.
function colToIdx(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Attribute lookup also handles single quotes; never confuses r:id with id.
function attr(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = xml.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? decodeXml(m[1] ?? m[2]) : undefined;
}

const BUILTIN_DATES = {14:'mm-dd-yy',15:'d-mmm-yy',16:'d-mmm',17:'mmm-yy',18:'h:mm AM/PM',19:'h:mm:ss AM/PM',20:'h:mm',21:'h:mm:ss',22:'m/d/yy h:mm',45:'mm:ss',46:'[h]:mm:ss',47:'mmss.0'};
function dateStyles(xml) {
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) custom.set(attr(m[0],'numFmtId'),attr(m[0],'formatCode'));
  const xfs = (xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)||[])[1]||'';
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map(m => {
    const id=attr(m[0],'numFmtId')||'0';
    return custom.get(id) ?? BUILTIN_DATES[id] ?? '';
  });
}

function numberSection(format, value) {
  // Semicolons inside literals/escapes are not section separators.
  const sections=[];let part='',quoted=false;
  for(let i=0;i<format.length;i++){
    const ch=format[i];
    if(ch==='\\'){part+=ch+(format[++i]||'');continue;}
    if(ch==='"')quoted=!quoted;
    if(ch===';'&&!quoted){sections.push(part);part='';}else part+=ch;
  }
  sections.push(part);
  const numeric=sections.slice(0,3),condition=s=>s.match(/\[(<=|>=|<>|=|<|>)(-?(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?)\]/i);
  if(numeric.some(condition)) {
    for(const s of numeric){const c=condition(s);if(!c)return s;const n=Number(c[2]);
      if(({ '<':value<n,'>':value>n,'=':value===n,'<>':value!==n,'<=':value<=n,'>=':value>=n })[c[1]])return s;}
    return '';
  }
  return numeric.length===1?numeric[0]:(value<0?numeric[1]:value===0&&numeric.length>2?numeric[2]:numeric[0]);
}

function formattedNumber(raw, format, date1904) {
  if(!format||!raw.trim())return raw;
  const serial=Number(raw);if(!Number.isFinite(serial))return raw;
  const section=numberSection(format,serial);
  // Quoted/escaped letters, colours, conditions and currency locale codes are
  // literals, not evidence that an ordinary amount is a date.
  const tokens=section.replace(/"[^"]*"|\\.|_.|\*./g,'').toLowerCase();
  const elapsed=/\[(h+|m+|s+)\]/.test(tokens);
  const clean=tokens.replace(/\[[^\]]*\]/g,'');
  const time=elapsed||/[hs]/.test(clean),date=/[yd]/.test(clean)||(!time&&/m/.test(clean));
  if(!date&&!time)return raw;
  const DAY=86400000;
  const millis=Math.round(serial*DAY);
  if(!Number.isSafeInteger(millis)||serial<0)return `[data/hora Excel inválida: ${raw}]`;
  const days=Math.floor(millis/DAY),rem=millis%DAY;
  const hours=elapsed?Math.floor(millis/3600000):Math.floor(rem/3600000);
  const pad=n=>String(n).padStart(2,'0');
  const clock=`${pad(hours)}:${pad(Math.floor(rem/60000)%60)}:${pad(Math.floor(rem/1000)%60)}`+(rem%1000?'.'+String(rem%1000).padStart(3,'0'):'');
  if(!date)return clock;
  // Excel deliberately preserves the fictitious 1900-02-29 at serial 60.
  if(!date1904&&days===60)return '1900-02-29 [data fictícia do Excel]'+(rem?' '+clock:'');
  const stamp=Date.UTC(date1904?1904:1899,date1904?0:11,date1904?1:31)+(days-(!date1904&&days>60?1:0))*DAY;
  const d=new Date(stamp);
  if(!Number.isFinite(d.getTime())||d.getUTCFullYear()>9999)return `[data/hora Excel inválida: ${raw}]`;
  // Floating calendar values: UTC arithmetic avoids host timezone shifts, but
  // the output deliberately has no Z/offset (the workbook supplies neither).
  return d.toISOString().slice(0,10)+(time||rem?' '+clock:'');
}

function cellText(attrs, inner, shared, formats=[],date1904=false) {
  const type=attr(attrs,'t')||'n';
  const vi=(inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)||[])[1];
  if(type==='s')return vi!=null?(shared[parseInt(vi,10)]??''):'';
  if(type==='inlineStr')return textOfNode(inner);
  const raw=vi!=null?decodeXml(vi):'';
  if(type==='b')return raw==='1'||raw==='true'?'TRUE':raw==='0'||raw==='false'?'FALSE':raw;
  if(type==='n')return formattedNumber(raw,formats[Number(attr(attrs,'s')||0)],date1904);
  return raw; // strings, ISO dates and error values already carry their meaning
}

function parseSheet(xml, shared, {maxRows,formats,date1904}) {
  const rows = new Map();let totalRows=0,previous=0;
  const rowRe = /<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const attrs=rm[1]!==undefined?rm[1]:rm[2],body=rm[3]||'';
    const declared=attr(attrs,'r');
    const inferred=(body.match(/<c\b[^>]*\br=["'][A-Z]+(\d+)["']/)||[])[1];
    const row=Number(declared??inferred??previous+1);
    if(!Number.isInteger(row)||row<1||row>1048576||row<=previous)throw Error('xlsx: índice de linha inválido ou fora de ordem');
    previous=row;totalRows=row;
    if(row>maxRows)continue; // count extent without allocating omitted rows
    const cells=[];
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm;
    while((cm=cellRe.exec(body))){
      const ca=cm[1]!==undefined?cm[1]:cm[2],inner=cm[3]||'',ref=attr(ca,'r');
      if(ref&&!/^[A-Z]+\d+$/.test(ref))throw Error('xlsx: referência de célula inválida');
      const idx=ref?colToIdx(ref):cells.length;
      if(idx<0||idx>=16384||(ref&&Number(ref.match(/\d+$/)[0])!==row))throw Error('xlsx: referência fora da linha ou do limite de colunas');
      cells[idx]=cellText(ca,inner,shared,formats,date1904);
    }
    rows.set(row,cells);
  }
  return {rows,totalRows};
}

// Ordena as planilhas pelo nome do arquivo (sheet1, sheet2, ...).
function sheetNames(entries) {
  return Object.keys(entries)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    .sort((a, b) => {
      const na = parseInt(a.match(/sheet(\d+)/i)[1], 10);
      const nb = parseInt(b.match(/sheet(\d+)/i)[1], 10);
      return na - nb;
    });
}

/**
 * Lê um Buffer .xlsx e devolve texto (CSV por planilha).
 * @param {Buffer} buf
 * @param {object} [opts] { maxChars=40000, maxRowsPerSheet=2000 }
 * @returns {{ text:string, sheets:number, rows:number, truncated:boolean }}
 */
export function xlsxToText(buf, opts = {}) {
  const maxChars=opts.maxChars??40000,maxRows=opts.maxRowsPerSheet??2000;
  if(!Number.isSafeInteger(maxChars)||maxChars<1||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>1048576)throw Error('xlsx: limites de leitura inválidos');
  const entries=readZipEntries(buf);
  const dec=name=>readEntry(buf,entries[name]||entries[Object.keys(entries).find(k=>k.toLowerCase()===name.toLowerCase())])?.toString('utf8')||'';
  const shared=parseSharedStrings(dec('xl/sharedStrings.xml'));
  const formats=dateStyles(dec('xl/styles.xml'));
  const date1904=/^(1|true)$/i.test(attr((dec('xl/workbook.xml').match(/<workbookPr\b[^>]*>/)||[])[0]||'','date1904')||'');
  const sheets=sheetFileByName(entries,dec);
  if(!sheets.size)throw Error('xlsx: nenhuma planilha encontrada');
  let totalRows=0,truncated=false,text='';
  const append=chunk=>{const room=Math.max(0,maxChars-text.length);if(chunk.length>room)truncated=true;text+=chunk.slice(0,room);};
  for(const [label,file] of sheets){
    const {rows,totalRows:extent}=parseSheet(dec(file),shared,{maxRows:text.length<maxChars?Math.min(maxRows,maxChars-text.length+1):0,formats,date1904});
    totalRows+=extent;if(extent>maxRows)truncated=true;
    append((text?'\n\n':'')+'# '+label+'\n');
    const shown=Math.min(extent,maxRows);
    for(let r=1;r<=shown;r++){
      const cells=rows.get(r)||[];
      // Array.from fills column holes; row gaps are explicit CSV lines.
      const chunk=(r>1?'\n':'')+Array.from(cells,csvEscape).join(',');
      const cut=chunk.length>maxChars-text.length;append(chunk);if(cut)break;
    }
  }
  return {text,sheets:sheets.size,rows:totalRows,truncated};
}

// ── Peças internas do arquivo (fidelidade de round-trip) ───────────────────
// Um .xlsx é um ZIP: gráfico, imagem, tabela dinâmica e macro são PEÇAS
// separadas (xl/charts/, xl/media/, xl/pivotCache/, xl/vbaProject.bin). Quando
// um script de edição recria o arquivo (ou a lib não entende uma peça), a peça
// simplesmente DESAPARECE do zip — sem erro nenhum. Comparar a lista de peças
// antes/depois pega essa classe inteira de dano, incluindo recursos que a gente
// nunca testou, sem precisar prever cada um. `formulas` conta os <f> de todas as
// abas: fórmula achatada em valor estático (o clássico data_only=True) não muda
// a lista de peças, mas zera essa contagem.
export function xlsxParts(buf) {
  const entries = readZipEntries(buf);
  const names = Object.keys(entries).sort();
  let formulas = 0;
  for (const n of names) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/i.test(n)) continue;
    const xml = (readEntry(buf, entries[n]) || Buffer.alloc(0)).toString('utf8');
    formulas += (xml.match(/<f[\s>/]/g) || []).length;
  }
  return { names, formulas };
}

// Mapa "nome da aba" -> arquivo da aba, resolvido pelos rels (a ordem de
// sheet1/sheet2 no zip NÃO é garantida igual à ordem das abas no workbook).
function sheetFileByName(entries, dec) {
  const wb=dec('xl/workbook.xml'),rels=dec('xl/_rels/workbook.xml.rels'),map=new Map(),targets=new Map();
  for(const m of rels.matchAll(/<Relationship\b[^>]*>/g)){
    const id=attr(m[0],'Id'),target=attr(m[0],'Target'),type=attr(m[0],'Type')||'';
    if(!id||!target)continue;
    if(targets.has(id))throw Error('xlsx: relacionamento de aba duplicado');
    if(attr(m[0],'TargetMode')==='External'){targets.set(id,{external:true});continue;}
    let file;
    try{const decoded=decodeURIComponent(target);file=posix.normalize(decoded.startsWith('/')?decoded.slice(1):posix.join('xl',decoded));}catch{throw Error('xlsx: destino de aba inválido');}
    targets.set(id,{file,type});
  }
  const named=[...wb.matchAll(/<sheet\b[^>]*>/g)];
  if(!named.length){
    // Minimal workbooks without a manifest get generic labels, never guessed names.
    sheetNames(entries).forEach((file,i)=>map.set(`Planilha ${i+1}`,file));return map;
  }
  for(const m of named){
    const name=attr(m[0],'name'),rid=attr(m[0],'r:id'),target=targets.get(rid);
    if(name===undefined||!target||target.external)throw Error('xlsx: não foi possível associar a aba ao seu relacionamento');
    if(/\/(chartsheet|dialogsheet)$/.test(target.type))continue; // not cell grids
    if(target.type&&!target.type.endsWith('/worksheet'))throw Error('xlsx: tipo de aba não suportado');
    target.file=Object.keys(entries).find(k=>k.toLowerCase()===target.file.toLowerCase())||target.file;
    if(!target.file.toLowerCase().startsWith('xl/')||!entries[target.file])throw Error('xlsx: arquivo da aba não encontrado');
    if(map.has(name))throw Error('xlsx: nome de aba duplicado');
    map.set(name,target.file);
  }
  return map;
}

/**
 * Lê células específicas de um .xlsx por referência A1 ("Aba!C8" ou "C8").
 * Serve pra CONFERIR, do lado de fora, que uma edição feita por código caiu
 * onde disse que caiu — sem trazer o conteúdo da planilha pro contexto.
 * @param {Buffer} buf
 * @param {string[]} refs
 * @returns {Array<{ref:string, sheet:string, cell:string, exists:boolean, value:string, formula:string}>}
 */
export function xlsxCells(buf, refs = []) {
  const entries = readZipEntries(buf);
  const dec = (name) => {
    const e = entries[name] || entries[Object.keys(entries).find((k) => k.toLowerCase() === name.toLowerCase())];
    const raw = readEntry(buf, e);
    return raw ? raw.toString('utf8') : '';
  };
  const shared = parseSharedStrings(dec('xl/sharedStrings.xml'));
  const byName = sheetFileByName(entries, dec);
  const first = byName.values().next().value;
  const cache = new Map();
  const sheetXml = (file) => {
    if (!cache.has(file)) cache.set(file, dec(file));
    return cache.get(file);
  };
  const out = [];
  for (const raw of refs) {
    const ref = String(raw || '').trim().replace(/^'|'$/g, '');
    const m = ref.match(/^(?:'?([^!']+)'?!)?\$?([A-Za-z]+)\$?(\d+)$/);
    if (!m) { out.push({ ref, sheet: '', cell: '', exists: false, value: '', formula: '', invalid: true }); continue; }
    const tab = m[1] ? m[1].trim() : '';
    const cell = `${m[2].toUpperCase()}${m[3]}`;
    let file = tab ? byName.get(tab) : first;
    if (!file && tab) {
      const hit = [...byName.keys()].find((k) => k.toLowerCase() === tab.toLowerCase());
      file = hit ? byName.get(hit) : null;
    }
    if (!file) { out.push({ ref, sheet: tab, cell, exists: false, value: '', formula: '', noSheet: true }); continue; }
    const xml = sheetXml(file);
    // Autofechada primeiro, senao a celula vazia procurada devolve o valor da
    // celula seguinte e o conferidor de edicao acusa erro num arquivo certo (achado #19).
    const cm = xml.match(new RegExp(`<c\\b[^>]*\\br="${cell}"[^>]*?/>|<c\\b[^>]*\\br="${cell}"[^>]*?>([\\s\\S]*?)</c>`));
    if (!cm) { out.push({ ref, sheet: tab, cell, exists: false, value: '', formula: '' }); continue; }
    const inner = cm[1] || '';
    const attrs = cm[0].slice(0, cm[0].indexOf('>') + 1);
    const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
    const formula = (inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/) || [])[1];
    let value = '';
    if (type === 's') {
      const vi = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      value = vi != null ? (shared[parseInt(vi, 10)] ?? '') : '';
    } else if (type === 'inlineStr') {
      value = textOfNode(inner);
    } else {
      const vi = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      value = vi != null ? decodeXml(vi) : '';
    }
    out.push({ ref, sheet: tab, cell, exists: true, value, formula: formula ? decodeXml(formula) : '' });
  }
  return out;
}

export default { xlsxToText, xlsxParts, xlsxCells };
