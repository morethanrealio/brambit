import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync} from 'node:fs';
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','deepseek/tsconfig.json'],{stdio:'inherit'});
mkdirSync('core-proto/deepseek',{recursive:true});
for(const file of ['provider','scope','comparison']) copyFileSync(`.deepseek-build/${file}.mjs`,`core-proto/deepseek/${file}.mjs`);
