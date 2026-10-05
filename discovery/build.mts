import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'discovery/tsconfig.json'], { stdio: 'inherit' });
for (const file of ['store', 'runtime', 'routes', 'conversation', 'closing', 'report', 'report-instructions', 'report-format', 'report-account']) {
    const src = readFileSync(`.discovery-build/${file}.mjs`, 'utf8').replace(/'\.\/(store|conversation|closing|report(?:-instructions|-format|-account)?)\.mjs'/g, "'./discovery-$1.mjs'").replace("'../web/marca.mjs'", "'./marca.mjs'");
    writeFileSync(`web/discovery-${file}.mjs`, src);
}
// Tela do painel: arquivo da nuvem (plugin brambs); o núcleo sozinho não a compila.
for (const file of ['admin-ui'])
    if (existsSync(`.discovery-build/${file}.mjs`))
        copyFileSync(`.discovery-build/${file}.mjs`, `web/plugins/brambs/publico/discovery-${file}.mjs`);
