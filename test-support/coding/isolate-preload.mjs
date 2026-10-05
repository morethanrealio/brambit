import {syncBuiltinESMExports} from 'node:module';
import net from 'node:net';import http from 'node:http';import https from 'node:https';import child from 'node:child_process';
const deny=()=>{throw Error('External IO forbidden in synthetic reproduction')};
globalThis.fetch=deny;net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;
for(const k of ['exec','execFile','spawn','fork','execSync','execFileSync','spawnSync'])child[k]=deny;syncBuiltinESMExports();
