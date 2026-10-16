import {execFileSync} from 'node:child_process';
import {copyFileSync} from 'node:fs';
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','onboarding/tsconfig.json'],{stdio:'inherit'});
copyFileSync('.onboarding-build/store.mjs','web/onboarding-store.mjs');
copyFileSync('.onboarding-build/ui.mjs','web/public/onboarding.mjs');

copyFileSync('.onboarding-build/ui-texts.mjs','web/public/ui-texts.mjs');

copyFileSync('.onboarding-build/connections.mjs','web/onboarding-connections.mjs');
