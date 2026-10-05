// Used ONLY by the disposable PostgreSQL/server boot test. No production config.
import net from 'node:net';
import tls from 'node:tls';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
const socket=process.env.TEST_BOOT_SOCKET;
if(!socket||!path.isAbsolute(socket)||!socket.includes('brambs-boot-test-'))throw Error('Owned disposable socket required');
const denied=()=>{throw Error('BOOT_TEST_EXTERNAL_IO_BLOCKED');};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 // net normalizes arguments into [options, callback] for net.createConnection.
 let a=args[0];if(Array.isArray(a))a=a[0];
 const p=typeof a==='string'?a:a?.path;
 if(p===path.join(socket,'.s.PGSQL.5432'))return connect.apply(this,args);
 return denied();
};
tls.connect=denied;globalThis.fetch=denied;
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=denied;
syncBuiltinESMExports();
