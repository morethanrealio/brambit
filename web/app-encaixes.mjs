// Encaixes do app (C2, passo 11c6c). O app logado (web/public/index.html) tem
// marcadores onde um plugin pode pôr tela própria: <!--encaixe:NOME--> no HTML e
// /*encaixe:NOME*/ dentro de <style> e <script>, cada um sozinho na linha. O
// plugin traz uma pasta (campo `app`) com um arquivo por encaixe, NOME.<ext>
// (estilo.css, menu.html, script.js...), e o servidor troca a linha do marcador
// pelo conteúdo dos arquivos, na ordem da lista de plugins. Encaixe sem plugin
// some sem deixar linha. A troca acontece antes do nonce e da tradução, então
// os pedaços ganham as duas coisas como o resto da página.
// O script do plugin se pendura em `ganchosDoApp` (declarado no index.html):
// rotas da aba, o que roda ao entrar no app, a cada troca de aba e quando a
// conta é criada (aoCadastrar, com o método: email ou google).
import fs from 'node:fs';
import path from 'node:path';

// \r?: on Windows git checks out index.html with CRLF.
const MARCADOR = /^[ \t]*(?:<!--encaixe:([a-z0-9-]+)-->|\/\*encaixe:([a-z0-9-]+)\*\/)[ \t]*\r?\n/gm;

function pedacos(pastas) {
  const porNome = {};
  for (const pasta of pastas) {
    for (const arq of fs.readdirSync(pasta).sort()) {
      const nome = arq.replace(/\.[^.]+$/, '');
      porNome[nome] = (porNome[nome] || '') + fs.readFileSync(path.join(pasta, arq), 'utf8');
    }
  }
  return porNome;
}

export function marcadores(html) {
  return [...html.matchAll(MARCADOR)].map((m) => m[1] || m[2]);
}

export function montarApp(html, pastas) {
  const p = pedacos(pastas);
  return html.replace(MARCADOR, (_, a, b) => p[a || b] || '');
}

// Leitor das páginas do site: o app sai montado, o resto sai como está no disco.
// Confere os encaixes já na criação, ou seja, no boot.
export function leitorDePagina(app, pastas) {
  conferirEncaixes(fs.readFileSync(app, 'utf8'), pastas);
  return (arq) => {
    const html = fs.readFileSync(arq, 'utf8');
    return arq === app ? montarApp(html, pastas) : html;
  };
}

// No boot: pedaço sem marcador (nome com erro de digitação) falha logo, e não
// vira tela que some calada.
export function conferirEncaixes(html, pastas) {
  const existe = new Set(marcadores(html));
  for (const pasta of pastas) {
    for (const arq of fs.readdirSync(pasta)) {
      const nome = arq.replace(/\.[^.]+$/, '');
      if (!existe.has(nome)) throw Error(`Encaixe desconhecido no app: ${path.join(pasta, arq)}`);
    }
  }
}
