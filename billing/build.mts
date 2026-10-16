import {execFileSync} from 'node:child_process';
import {copyFileSync} from 'node:fs';
execFileSync(process.execPath,[process.env.TSC_PATH||'node_modules/typescript/bin/tsc','-p','billing/tsconfig.json'],{stdio:'inherit'});
copyFileSync('.billing-build/ui.mjs','web/public/billing-result.mjs');
