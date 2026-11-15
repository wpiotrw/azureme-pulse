import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert';
const { diffEvents, buildMail, dailyDue, metrics, notify } = await import('../../probes/notify.mjs');
const { merge } = await import('../../probes/probe.mjs');
const base = JSON.parse(readFileSync(new URL('./data/out.json', import.meta.url),'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
assert.equal(diffEvents(base, clone(base)).length, 0, 'no change -> no events');
// two consecutive failures of exo -> one crit event; single failure -> none
const n1 = clone(base); const t = n1.samples.at(-1).t;
n1.samples.push({ t: t+5, r: { ...n1.samples.at(-1).r, exo: [0, 10000, 0] } });
assert.equal(diffEvents(base, n1).length, 0, 'single failure is not reported');
const n2 = clone(n1); n2.samples.push({ t: t+10, r: { ...n1.samples.at(-1).r } }); n2.services.find(s=>s.id==='exo').last={ok:false,code:0,ms:10000,err:'timeout'};
let ev = diffEvents(n1, n2); assert.equal(ev.length,1); assert.equal(ev[0].sev,'crit');
const n3 = clone(n2); n3.samples.push({ t: t+15, r: { ...n2.samples.at(-1).r, exo:[1,90,401] } }); n3.services.find(s=>s.id==='exo').last={ok:true,code:401,ms:90,err:''};
ev = diffEvents(n2, n3); assert.equal(ev.length,1); assert.equal(ev[0].sev,'ok');
// health: status change in both tenants -> one event; new issue; resolved issue; check fail
const h = clone(base); h.health.forEach(x=>{ x.services.find(s=>s.name==='Microsoft Entra').status='serviceInterruption'; x.issues.unshift({id:'MO999',title:'New thing',service:'Microsoft 365 suite',status:'investigating',resolved:false,update:'We are investigating.'}); });
const firstOpen = h.health[0].issues.find(i=>!i.resolved && i.id!=='MO999'); h.health.forEach(x=>x.issues.forEach(i=>{ if(i.id===firstOpen.id) i.resolved=true; }));
h.health[0].checks.find(c=>c.id==='spo').state='fail';
ev = diffEvents(base, h); console.log(ev.map(e=>e.sev+' | '+e.kind+' | '+e.title));
assert.deepEqual(ev.map(e=>e.kind).sort(), ['Nowe zgłoszenie','Odczyt przez Graph','Service health','Zgłoszenie zamknięte'].sort());
// first run with empty prev health: no flood
assert.equal(diffEvents({samples:base.samples,services:base.services,health:[]}, base).length, 0);
assert.equal(dailyDue({}, Date.parse('2026-11-14T05:59:00Z')), null);
assert.equal(dailyDue({}, Date.parse('2026-11-14T06:01:00Z')), '2026-11-14');
assert.equal(dailyDue({notify:{lastDaily:'2026-11-14'}}, Date.parse('2026-11-14T09:00:00Z')), null);
// notify(): no config -> skip, state preserved; with config -> one POST with expected shape
delete process.env.PULSE_NOTIFY; assert.deepEqual(await notify({notify:{lastDaily:'x'}}, base), {lastDaily:'x'});
// merge keeps azure + notify
const mg = merge({ ...base, azure:{ok:true,items:[{title:'a'}],build:null}, notify:{lastDaily:'d'} }, {entra:{ok:true,ms:1,code:200}}, Date.now(), null, {ok:false,items:[],error:'HTTP 500'});
assert.equal(mg.azure.items.length,1); assert.equal(mg.azure.lastError,'HTTP 500'); assert.equal(mg.notify.lastDaily,'d');
console.log('ALL TESTS PASSED', metrics(base).length, 'groups');
