// Server-side trace contract. Keep compatibility with ansuz/shared/gesture_trace.rs.
const number=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<1e7;
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const vec=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(number);
const quat=a=>vec(a,4)&&a.reduce((s,n)=>s+n*n,0)>=.9801&&a.reduce((s,n)=>s+n*n,0)<=1.0201;
function requireThat(ok){if(!ok)throw Object.assign(Error('Invalid gesture recording.'),{status:422,jeraSafe:true});}
export function validateTrace(j){
 const work=[[j,0]];while(work.length){const [value,depth]=work.pop();requireThat(depth<128);if(typeof value==='number')requireThat(Number.isFinite(value));if(value&&typeof value==='object')for(const child of Object.values(value))work.push([child,depth+1]);}
 requireThat(j?.schema==='ansuz.gesture-take'&&[1,2,3,4].includes(j.version)&&j.hz===120);
 requireThat(vec(j.viewport,2)&&j.viewport.every(n=>n>=1)&&[0,1].includes(j.mode)&&typeof j.reduced_motion==='boolean');
 const n=j.initial;requireThat(n&&quat(n.orientation)&&vec(n.velocity,2)&&vec(n.position,2)&&typeof n.down==='boolean'&&uint(n.pointer)&&number(n.quiet)&&n.quiet>=0);
 if(j.version>=3)requireThat(uint(j.element)&&j.element<=4&&['ansuz.elements/1','ansuz.elements/2'].includes(j.element_model));
 requireThat(Array.isArray(j.frames)&&j.frames.length>0&&j.frames.length<=2400);
 for(const a of j.frames){
  requireThat(Array.isArray(a)&&((j.version>=3&&a.length===22)||(j.version<3&&a.length===18)||(j.version===1&&a.length===15)));
  requireThat(uint(a[0])&&a[0]<16&&uint(a[1])&&typeof a[2]==='boolean'&&a.slice(3,Math.min(17,a.length)).every(number)&&quat(a.slice(9,13)));
  if(a.length>=18)requireThat(a[15]>=1&&a[16]>=1&&typeof a[17]==='boolean');
  if(a.length===22)requireThat(number(a[18])&&a[18]>=0&&a[18]<=1&&uint(a[19])&&a[19]<=4&&a.slice(20).every(number));
 }
 requireThat(Array.isArray(j.observed)&&j.observed.length<=4800);let tick=0;
 for(const a of j.observed){requireThat(Array.isArray(a)&&a.length===7&&uint(a[0])&&a[0]>=tick&&a[0]<=j.frames.length&&Number.isFinite(a[1])&&a[1]>=0&&uint(a[2])&&a[2]<=2&&uint(a[3])&&a.slice(4,6).every(number)&&uint(a[6])&&a[6]<=4294967295);tick=a[0];}
 if(j.version===4){
  requireThat(JSON.stringify(j.delivered_columns)===JSON.stringify(['tick','host_event_ms','phase_0_down_1_move_2_up_3_cancel_4_blur','pointer_id','x','y','dx','dy','buttons']));
  requireThat(j.capture&&['manual','duration_limit','input_limit','interrupted'].includes(j.capture.stop_reason)&&uint(j.capture.dropped_events)&&j.capture.dropped_events<=4294967295&&j.capture.max_contacts===10&&(j.capture.dropped_events===0||j.capture.stop_reason==='input_limit'));
  requireThat(Array.isArray(j.initial_contacts)&&j.initial_contacts.length<=10);const active=new Set();
  for(const a of j.initial_contacts){requireThat(Array.isArray(a)&&a.length===3&&uint(a[0])&&a.slice(1).every(number)&&!active.has(a[0]));active.add(a[0]);}
  requireThat(Array.isArray(j.delivered)&&j.delivered.length<=8000);tick=0;
  for(const a of j.delivered){
   requireThat(Array.isArray(a)&&a.length===9&&uint(a[0])&&a[0]>=tick&&a[0]<=j.frames.length&&Number.isFinite(a[1])&&a[1]>=0&&uint(a[2])&&a[2]<=4&&uint(a[3])&&a.slice(4,8).every(number)&&uint(a[8])&&a[8]<=4294967295);tick=a[0];
   if(a[2]===0){active.add(a[3]);requireThat(active.size<=10);}else if(a[2]===4)active.clear();else {requireThat(active.has(a[3]));if(a[2]===3||(a[2]===2&&a[8]===0))active.delete(a[3]);}
  }
 }
}
