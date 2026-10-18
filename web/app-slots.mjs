// App ports (C2, step 11c6c). The logged-in app (web/public/index.html) has
// markers where a plugin can put its own screen: <!--encaixe:NAME--> in HTML
// and /*encaixe:NAME*/ inside <style> and <script>, each alone on its line.
// The plugin brings a folder (field `app`) with one file per port, NAME.<ext>
// (estilo.css, menu.html, script.js...), and the server swaps the marker line
// for the files' content, in the plugin list's order. A port with no plugin
// disappears without leaving a line. The swap happens before the nonce and
// the translation, so the pieces get both just like the rest of the page.
// The plugin's script hangs off `ganchosDoApp` (declared in index.html): tab
// routes, what runs on entering the app, on every tab switch, and when the
// account is created (aoCadastrar, with the method: email or google).
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

// Site pages reader: the app comes out assembled, the rest comes out as it
// is on disk. Checks the ports right at creation, i.e. at boot.
export function leitorDePagina(app, pastas) {
  conferirEncaixes(fs.readFileSync(app, 'utf8'), pastas);
  return (arq) => {
    const html = fs.readFileSync(arq, 'utf8');
    return arq === app ? montarApp(html, pastas) : html;
  };
}

// At boot: a piece with no marker (typo'd name) fails right away, and does
// not become a screen that silently disappears.
export function conferirEncaixes(html, pastas) {
  const existe = new Set(marcadores(html));
  for (const pasta of pastas) {
    for (const arq of fs.readdirSync(pasta)) {
      const nome = arq.replace(/\.[^.]+$/, '');
      if (!existe.has(nome)) throw Error(`Encaixe desconhecido no app: ${path.join(pasta, arq)}`);
    }
  }
}
