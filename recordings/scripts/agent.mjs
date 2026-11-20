#!/usr/bin/env node
// Credentials stay in a private file; stdout contains records, never sessions.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RecordingClient } from './client.mjs';
const [command, owner, digest, destination] = process.argv.slice(2);
const path=process.env.ANSUZ_CREDENTIALS_FILE;
if(!path) throw Error('Set ANSUZ_CREDENTIALS_FILE to the private account file.');
if((await stat(path)).mode & 0o077) throw Error('Credential file must be private (chmod 600).');
const config=JSON.parse(await readFile(path,'utf8'));
if(config.origin!=='https://ansuz.jera.ink')throw Error('Unexpected recording service origin.');
const client=new RecordingClient(config.origin,config.session?.token);
let auth;
if(config.mode==='operator-session'){
 if(config.session?.principal!=='operator:ansuz-recorder' || !config.session?.token || !Number.isFinite(config.session.expiresAt)||config.session.expiresAt<=Date.now()) throw Error('Operator session unavailable or expired; renew it through ops/issue-reader.py.');
 auth={session:config.session};
}else{
 if(config.email || config.password) throw Error('Legacy password credentials are retired. Provision the independent recorder-agent session.');
 auth=await client.request('/auth/refresh',{});
 if(!auth.session?.token || !auth.session.principal?.startsWith('did:'))throw Error('No verified account session returned');
 config.session=auth.session;await writeFile(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
}
client.token=auth.session.token;
if(command==='identity'){console.log(auth.session.principal);}
else if(command==='libraries'){
 let cursor=null;const items=[];do{const r=await client.query('sharedLibraries',{c:cursor});if(r.complete!==true)throw Error('Incomplete library query');items.push(...r.data);cursor=r.next;}while(cursor);console.log(JSON.stringify(items,null,2));
}
else if(command==='history'){
 if(!owner)throw Error('Usage: agent.mjs history <owner-principal>');
 let cursor=null;const records=[];do{const r=await client.query('history',{owner,c:cursor});if(r.complete!==true)throw Error('Incomplete server history; retry instead of treating it as complete.');records.push(...r.data);cursor=r.next;}while(cursor);
 console.log(JSON.stringify(records,null,2));
}else if(command==='fetch'){
 if(!owner||!digest||!destination)throw Error('Usage: agent.mjs fetch <owner-principal> <digest> <output.json>');
 const row=(await client.query('findTake',{owner,digest})).data;if(!row)throw Error('Take unavailable or access not granted.');
 const response=await fetch(`${client.origin}/assets/${encodeURIComponent(row.trace.id)}`,{headers:{authorization:`Bearer ${client.token}`},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error(`Download HTTP ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==digest)throw Error('Trace checksum mismatch');
 const trace=JSON.parse(bytes);if(trace.schema!=='ansuz.gesture-take')throw Error('Not an Ansuz gesture');
 await writeFile(destination,bytes,{flag:'wx',mode:0o600});
 console.log(JSON.stringify({file:destination,digest,frames:trace.frames.length,expected:row.expected}));
}else throw Error('Commands: identity, libraries, history <owner>, fetch <owner> <digest> <output.json>');
