import {createHash} from 'node:crypto';
import {validateTrace} from './trace.mjs';
const fail=(message,status=422)=>{throw Object.assign(Error(message),{status,jeraSafe:true});};
export function archiveHandler({snapbackOrigin,serviceToken,fetcher=fetch}){
 const locks=new Map();const pendingOwners=new Map();let running=0;
 async function post(path,token,value){const r=await fetcher(snapbackOrigin+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(30000)});const j=await r.json();if(!r.ok||j.denied||j.state==='failed')fail('Recording archive refused the operation.',r.status===401?401:503);return j;}
 return async(token,request)=>{
  const who=await post('/q/currentIdentity',token,{args:{}});const owner=who.data?.did;
  if(!/^did:(plc:[a-z2-7]{24}|web:[A-Za-z0-9._:%-]+)$/.test(owner??''))fail('A verified account is required.',401);
  const a=request?.args;if(!a||!/^\w[\w-]*$/.test(a.trace?.id??'')||! /^[a-f0-9]{64}$/.test(a.digest??''))fail('Invalid recording reference.');
  const run=async()=>{
   const response=await fetcher(`${snapbackOrigin}/assets/${a.trace.id}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
   if(!response.ok)fail('Recording file is unavailable.',response.status===401?401:422);
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>2097152)fail('Recording exceeds 2 MiB.',413);chunks.push(chunk);}
   const bytes=Buffer.concat(chunks);if(createHash('sha256').update(bytes).digest('hex')!==a.digest)fail('Recording checksum does not match.');
   let trace;try{trace=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('Invalid recording JSON.');}validateTrace(trace);
   if(a.expected!==(trace.expected??'')||a.frames!==trace.frames.length||a.element!==(trace.element??0)||a.model!==(trace.element_model??'legacy')||a.captured!==Math.trunc(trace.captured_at_ms??0))fail('Recording metadata does not match its file.');
   if(typeof a.label!=='string'||a.label.length<1||[...a.label].length>100||typeof a.expected!=='string'||[...a.expected].length>1000||!Number.isSafeInteger(a.captured))fail('Invalid recording metadata.');
   const found=await post('/q/findTake',token,{args:{owner,digest:a.digest}});if(found.complete!==true)fail('Incomplete archive lookup.',503);
   if(found.data){for(const k of ['expected','frames','element','model','captured'])if(found.data[k]!==a[k])fail('Existing recording metadata differs.');return {state:'sent',result:found.data};}
   // Service-owned copy permits the service-only mutation to place the asset.
   const upload=await fetcher(snapbackOrigin+'/assets?as=file&name=gesture.json',{method:'POST',headers:{authorization:`Bearer ${serviceToken}`,'content-type':'application/json'},body:bytes,signal:AbortSignal.timeout(30000)});
   const file=await upload.json();if(!upload.ok||!file.asset?.id)fail('Archive file copy failed.',503);
   return post('/m/archive',serviceToken,{id:`${a.digest.slice(0,16)}-${file.asset.id}`,args:{...a,owner,trace:{id:file.asset.id}}});
  };
  if(running>=32||(pendingOwners.get(owner)??0)>=8)fail('Recording archive is busy. Retry shortly.',429);
  running++;pendingOwners.set(owner,(pendingOwners.get(owner)??0)+1);
  const key=owner+':'+a.digest;const prior=locks.get(key)??Promise.resolve();const pending=prior.catch(()=>{}).then(run);locks.set(key,pending);
  try{return await pending;}finally{running--;const left=pendingOwners.get(owner)-1;if(left)pendingOwners.set(owner,left);else pendingOwners.delete(owner);if(locks.get(key)===pending)locks.delete(key);}
 };
}
