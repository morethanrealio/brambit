// A shell blocklist cannot establish a read-only boundary. Only these utilities
// are accepted, with literal arguments rebuilt by us. Scripts, interpreters,
// repository hooks, pipelines and expansions use the confirmed command tool.
const PROGRAMS = new Set(['pwd','ls','cat','head','tail','wc','du','df','uname','stat']);
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
export function readOnlyCommand(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000 || /[\x00-\x1f\x7f$`;|&<>*?{}()]/.test(value)) return null;
  const words = []; let word = '', mode = null, started = false;
  for (let i=0;i<value.length;i++) {
    const c=value[i];
    if (c==='\\' && mode!=="'") { if (++i>=value.length) return null; word+=value[i]; started=true; }
    else if (mode) { if(c===mode)mode=null;else word+=c; }
    else if(c==='"'||c==="'") {mode=c;started=true;}
    else if(c===' ') {if(started){words.push(word);word='';started=false;}}
    else {word+=c;started=true;}
  }
  if(mode)return null;if(started)words.push(word);
  if(!PROGRAMS.has(words[0]))return null;
  // POSIX command -p selects the default system utility path, bypassing aliases
  // and shell functions as well as executables supplied by the project PATH.
  return 'command -p '+words.map(quote).join(' ');
}
