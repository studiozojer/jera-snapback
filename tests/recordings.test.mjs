import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createHandler } from '../auth/service.mjs';
import { RecordingClient, intentId } from '../recordings/scripts/client.mjs';
const root = new URL('../', import.meta.url).pathname;
async function start(dir) {
 const p=spawn(resolve(root,'node_modules/.bin/snapback4'),['dev','--port','0','--no-watch'],{cwd:dir,stdio:['ignore','pipe','pipe']});
 let out='',err='';p.stderr.on('data',x=>err+=x);
 const url=await new Promise((yes,no)=>{const timer=setTimeout(()=>{p.kill();no(Error(err))},30000);p.once('error',no);p.once('exit',()=>{clearTimeout(timer);no(Error(err))});p.stdout.on('data',x=>{out+=x;const m=out.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);yes(m[0])}})});
 return {url,async stop(){const done=once(p,'exit');p.kill();await done}};
}
async function account(url,label,dir){
 const principal=label==='agent@ansuz.test'?'operator:ansuz-recorder':'did:plc:'+({'owner@ansuz.test':'a','other@ansuz.test':'c'}[label]).repeat(24);
 const token=execFileSync(resolve(root,'node_modules/.bin/snapback4'),['token','--service','auth-tests'],{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const r=await new RecordingClient(url,token).request('/auth/session',{principal,days:1});
 return {principal:r.session.principal,client:new RecordingClient(url,r.session.token)};
}
async function upload(c,text){const r=await fetch(c.origin+'/assets?as=file&name=gesture.json',{method:'POST',headers:{authorization:`Bearer ${c.token}`,'content-type':'application/json'},body:text});const j=await r.json();assert(r.ok,JSON.stringify(j));return j.asset;}
async function download(c,id){return fetch(c.origin+'/assets/'+id,{headers:{authorization:`Bearer ${c.token}`}})}
test('real Snapback: immutable trace bytes, retry, private history, read grant, revocation, restart', {timeout:120000}, async t=>{
 const dir=await mkdtemp(resolve(tmpdir(),'ansuz-recordings-'));await mkdir(resolve(dir,'snapback'));await copyFile(resolve(root,'snapback/schema.q'),resolve(dir,'snapback/schema.q'));
 let server=await start(dir);t.after(async()=>{await server?.stop();await rm(dir,{recursive:true,force:true})});
 const owner=await account(server.url,'owner@ansuz.test',dir),agent=await account(server.url,'agent@ansuz.test',dir),other=await account(server.url,'other@ansuz.test',dir);
 const c=owner.client, a=agent.client, o=other.client;
 const serviceToken = execFileSync(resolve(root, 'node_modules/.bin/snapback4'), ['token', '--service', 'atproto-auth'], {
   cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
 }).trim();
 const gateway = createServer(createHandler({
   profile: 'ansuz', publicOrigin: 'http://127.0.0.1', callbacks: [],
   snapbackOrigin: server.url, serviceToken,
 }));
 gateway.listen(0, '127.0.0.1');
 await once(gateway, 'listening');
 t.after(() => { gateway.closeAllConnections(); gateway.close(); });
 const archive = (token, request) => new RecordingClient(
   `http://127.0.0.1:${gateway.address().port}`, token
 ).request('/m/archive', request);
 assert.equal((await (await fetch(server.url+'/auth/config')).json()).password,false);
 await assert.rejects(new RecordingClient(server.url).request('/auth/signup',{email:'wrong@example.test',password:'not an account'}));
 assert.equal((await c.query('currentIdentity')).data.did,owner.principal);
 await assert.rejects(a.request('/auth/session',{principal:owner.principal,days:1}),'ordinary machine bearer must not mint identity');
 await assert.rejects(c.request('/auth/session',{principal:other.principal,days:1}),'ordinary DID bearer must not mint identity');
 const original=JSON.stringify({schema:'ansuz.gesture-take',version:4,hz:120,element:3,element_model:'ansuz.elements/2',viewport:[390,500],mode:0,reduced_motion:false,
 initial:{orientation:[0,0,0,1],velocity:[0,0],position:[0,0],down:false,pointer:0,quiet:0},
 captured_at_ms:1793500000000,expected:'Hold, then press the earth upward — 土',
 frames:Array.from({length:2400},(_,i)=>[0,0,false,i*.001,0,0,0,0,0,0,0,0,1,0,0,390,500,false,0,0,0,0]),observed:[],
 initial_contacts:[],delivered_columns:['tick','host_event_ms','phase_0_down_1_move_2_up_3_cancel_4_blur','pointer_id','x','y','dx','dy','buttons'],
 delivered:Array.from({length:2000},(_,i)=>[i,1000+i*8.333, i<2?0:i===1998?2:i===1999?3:1,i%2+1,100+i*.001,200+i*.002,0,0,0]),
 capture:{stop_reason:'manual',dropped_events:0,max_contacts:10}});
 assert(original.length>200000);
 const digest=createHash('sha256').update(original).digest('hex');
 const asset=await upload(c,original);
 const args={digest,label:'Earth intention',expected:'Hold, then press the earth upward — 土',element:3,captured:1793500000000,frames:2400,model:'ansuz.elements/2',trace:{id:asset.id}};
 const write=intentId();
 await assert.rejects(c.mutate('archive',{...args,owner:owner.principal}),'direct mutation must be denied');
 await assert.rejects(archive(c.token,{args:{...args,frames:1}}),'metadata mismatch');
 await assert.rejects(archive(c.token,{args:{...args,digest:'a'.repeat(64)}}),'digest mismatch');
 const malformed=await upload(c,'{}');
 await assert.rejects(archive(c.token,{args:{...args,digest:createHash('sha256').update('{}').digest('hex'),trace:{id:malformed.id}}}),'invalid trace content');
 for(const damage of [j=>j.frames[0][2]=0,j=>j.delivered[0][2]=1,j=>j.viewport[0]=0,j=>j.version=999]){
  const j=JSON.parse(original);damage(j);const text=JSON.stringify(j);const bad=await upload(c,text);
  await assert.rejects(archive(c.token,{args:{...args,digest:createHash('sha256').update(text).digest('hex'),trace:{id:bad.id}}}));
 }
 assert.equal((await c.query('history',{owner:owner.principal})).data.length,0,'invalid submissions create no archive rows');
 const record=(await archive(c.token,{id:write,args})).result;await Promise.all([archive(c.token,{id:write,args}),archive(c.token,{id:write,args})]);
 assert.equal((await c.query('history',{owner:owner.principal})).data.length,1);
 assert.equal((await c.query('findTake',{owner:owner.principal,digest})).data.id,record.id);
 assert.deepEqual((await a.query('history',{owner:owner.principal})).data,[]);
 assert.equal((await download(a,record.trace.id)).status,404);
 await c.mutate('allowReader',{reader:agent.principal});
 assert.equal((await a.query('history',{owner:owner.principal})).data[0].digest,digest);
 assert.equal(await (await download(a,record.trace.id)).text(),original);
 await assert.rejects(a.mutate('archive',args)); // A reader cannot steal/place the owner's asset.
 await a.mutate('allowReader',{reader:other.principal}); // Only shares the agent's own empty library.
 assert.deepEqual((await o.query('history',{owner:owner.principal})).data,[]);
 await c.mutate('removeReader',{reader:agent.principal});
 assert.deepEqual((await a.query('history',{owner:owner.principal})).data,[]);
 assert.equal((await download(a,record.trace.id)).status,404);
 await server.stop();server=await start(dir);for(const client of [c,a,o])client.origin=server.url;
 assert.equal(await (await download(c,record.trace.id)).text(),original);
 assert.equal((await c.query('history',{owner:owner.principal})).data.length,1);
 // A duplicate content key cannot replace original bytes or metadata.
 const replacement=await upload(c,'{"different":true}');await assert.rejects(c.mutate('archive',{...args,trace:{id:replacement.id},expected:'rewritten'}));
 assert.equal((await c.query('findTake',{owner:owner.principal,digest})).data.expected,args.expected);
});
