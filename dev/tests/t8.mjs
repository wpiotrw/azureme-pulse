import { radarWeekly, readRadar } from '../../probes/signals.mjs';
import assert from 'node:assert';
const H=3600000, t0=Date.parse('2026-11-01T00:00:00Z');
function serie(n,f){const ts=[],vs=[];for(let i=0;i<n;i++){ts.push(new Date(t0+i*H).toISOString());vs.push(f(i));}return [ts,vs];}
const cyc=(i)=>0.6+0.3*Math.sin((i%24)/24*2*Math.PI)+(Math.floor(i/24)%7>=5?-0.15:0);
let [ts,vs]=serie(336,cyc); let w=radarWeekly(ts,vs); assert.equal(w.basis,'week'); assert.ok(w.ratio>=95&&w.ratio<=105,'normal '+w.ratio); assert.equal(w.state,'ok');
vs[vs.length-2]*=0.6; w=radarWeekly(ts,vs); assert.equal(w.state,'warn'); assert.ok(w.ratio>=55&&w.ratio<=65);
vs[vs.length-2]*=0.5; w=radarWeekly(ts,vs); assert.equal(w.state,'crit');
[ts,vs]=serie(100,cyc); w=radarWeekly(ts,vs); assert.equal(w.basis,'days'); assert.equal(w.state,'ok');
assert.equal(radarWeekly(...serie(10,cyc)),null);
// readRadar: weekly failure must not break the daily reading; weekly state can only worsen it
const day=serie(96,()=>0.8); const mk=(weekOk,drop)=>async(u)=>{ if(u.includes('14d')){ if(!weekOk) return {status:500,body:{}}; const [a,b]=serie(336,cyc); if(drop) b[b.length-2]*=0.3; return {status:200,body:{result:{serie_0:{timestamps:a,values:b}}}};} return {status:200,body:{result:{serie_0:{timestamps:day[0],values:day[1]}}}}; };
let r=await readRadar(null,Date.now(),mk(false),'x'); assert.equal(r.ok,true); assert.equal(r.state,'ok'); assert.ok(r.weekError); assert.equal(r.week,undefined);
r=await readRadar(null,Date.now(),mk(true),'x'); assert.equal(r.week.state,'ok'); assert.equal(r.state,'ok');
r=await readRadar(null,Date.now(),mk(true,true),'x'); assert.equal(r.week.state,'crit'); assert.equal(r.state,'crit');
assert.ok(!JSON.stringify(r).includes('Bearer'));
console.log('RADAR WEEKLY TESTS PASSED');
