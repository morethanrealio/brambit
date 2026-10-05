import {execFileSync} from 'node:child_process';
import {copyFileSync} from 'node:fs';
execFileSync(process.execPath,[process.env.TSC_PATH||'node_modules/typescript/bin/tsc','-p','routines/tsconfig.json'],{stdio:'inherit'});
copyFileSync('.routines-build/ui.mjs','web/public/routines.mjs');
