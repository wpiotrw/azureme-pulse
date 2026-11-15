import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
const N = await import('../../probes/notify.mjs');
const H = await import('../../probes/health.mjs');
const live = JSON.parse(readFileSync(new URL('./data/live14.json', import.meta.url), 'utf8')); const base = JSON.parse(readFileSync(new URL('./data/real12.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x)); const T = Date.parse(base.generated);
const types = (prev, next, st = {}, cfg = {}) => N.mailEvents(prev, next, st, T, cfg).map((e) => e.type + (e.issue ? ':' + e.issue.id : e.probe ? ':' + e.probe.id : ''));
// 1. nothing changed
assert.deepEqual(types(base, clone(base)), []);
// 2. Graph check failures and service-health state flips do NOT mail
let n = clone(base); n.health[0].checks.find((c) => c.id === 'teams').state = 'fail'; n.health[0].services[0].status = 'serviceInterruption';
assert.deepEqual(types(base, n), [], 'check failure / service state: no mail'); assert.ok(N.diffEvents(base, n).length >= 1, 'still in the change log');
// 3. Microsoft update on an incident -> one mail event even if two tenants show it; advisory update -> none
n = clone(base); for (const h of n.health) for (const i of h.issues) { if (i.id === 'MO1550821') { i.updateAt = '2026-11-14T02:00:00Z'; i.current = 'New text'; } if (i.id === 'TM1551945') i.updateAt = '2026-11-14T02:00:00Z'; }
assert.deepEqual(types(base, n), ['update:MO1550821']);
// 4. status change, closed, reopened
n = clone(base); for (const h of n.health) for (const i of h.issues) if (i.id === 'MO1550821') i.status = 'restoringService';
let ev = N.mailEvents(base, n, {}, T); assert.equal(ev.length, 1); assert.equal(ev[0].prevStatus, 'serviceDegradation');
n = clone(base); for (const h of n.health) for (const i of h.issues) if (i.id === 'MO1550821') { i.resolved = true; i.status = 'serviceRestored'; i.end = '2026-11-14T03:00:00Z'; }
assert.deepEqual(types(base, n), ['closed:MO1550821']); assert.deepEqual(types(n, base), ['new:MO1550821'], 'reopened');
// closed in one tenant only -> still open -> no mail
n = clone(base); n.health[0].issues.find((i) => i.id === 'MO1550821').resolved = true; assert.deepEqual(types(base, n), []);
// 5. new incident / new advisory (off by default, on with cfg)
n = clone(base); n.health[0].issues.unshift({ id: 'EX999', title: 'New outage', service: 'Exchange Online', classification: 'incident', status: 'investigating', resolved: false, start: '2026-11-14T01:00:00Z', updateAt: '2026-11-14T01:05:00Z' }, { id: 'TM999', title: 'New adv', service: 'Microsoft Teams', classification: 'advisory', status: 'serviceDegradation', resolved: false, updateAt: '2026-11-14T01:05:00Z' });
assert.deepEqual(types(base, n), ['new:EX999']); assert.deepEqual(types(base, n, {}, { advisories: true }).sort(), ['new:EX999', 'new:TM999']);
// 6. tenant read failed this run -> no issue mails; first run without previous health -> none
let f = clone(n); for (const h of f.health) h.lastError = 'x'; assert.deepEqual(types(base, f), []);
assert.deepEqual(types({ samples: base.samples, services: base.services, health: [] }, base), []);
// 7. probe outage: needs two failures, cooldown, recovery only after a mailed outage
const lt = base.samples.at(-1).t; const fail = (st, k) => { const c = clone(st); c.samples.push({ t: lt + 5 * k, r: { ...base.samples.at(-1).r, exo: [0, 10000, 0] } }); c.services.find((s) => s.id === 'exo').last = { ok: false, code: 0, ms: 10000 }; return c; };
const okk = (st, k) => { const c = clone(st); c.samples.push({ t: lt + 5 * k, r: { ...base.samples.at(-1).r } }); c.services.find((s) => s.id === 'exo').last = { ok: true, code: 401, ms: 200 }; return c; };
const d1 = fail(base, 1), d2 = fail(d1, 2), u3 = okk(d2, 3), d4 = fail(u3, 4), d5 = fail(d4, 5), u6 = okk(d5, 6); const st = {};
assert.deepEqual(types(base, d1, st), []); assert.deepEqual(types(d1, d2, st), ['probe-down:exo']); assert.deepEqual(types(d2, u3, st), ['probe-up:exo']);
assert.deepEqual(types(u3, d4, st), []); assert.deepEqual(types(d4, d5, st), [], 'second outage within cooldown: no mail'); assert.ok(st.sent['probe:exo'] !== undefined);
// 8. signal crit with cooldown
const s1 = clone(base); s1.signals = { atlas: { ok: true, state: 'ok', n: 1000, reach: 97.8 } }; const s2 = clone(s1); s2.signals.atlas.state = 'crit'; const sst = {};
assert.deepEqual(types(s1, s2, sst), ['signal']); assert.deepEqual(types(s1, s2, sst), []);
// 9. mails render; subjects; links; no "undefined"
n = clone(base); for (const h of n.health) for (const i of h.issues) if (i.id === 'MO1550821') { i.updateAt = '2026-11-14T02:00:00Z'; i.status = 'restoringService'; }
n.signals = live.signals; ev = N.mailEvents(base, n, {}, T);
const m1 = N.buildMail(n, ev, null, T); const m2 = N.buildMail(live, [], '2026-11-14', Date.parse(live.generated)); const m3 = N.buildMail(d2, N.mailEvents(d1, d2, {}, T), null, T);
for (const m of [m1, m2, m3]) { assert.ok(!/undefined|NaN|\[object/.test(m.html), 'no junk in ' + m.subject); assert.ok(m.html.includes('https://pulse.azureme.pl/#/incydenty')); }
assert.ok(m1.html.includes('Adminportal/Home#/servicehealth/:/alerts/MO1550821') && m1.html.includes('status.cloud.microsoft') && m1.html.includes('#/model'));
assert.ok(/MessageCenter\/:\/messages\/MC\d+/.test(m2.html), 'daily has Message Center links');
console.log(m1.subject); console.log(m2.subject); console.log(m3.subject);
writeFileSync('/tmp/mail_event.html', m1.html); writeFileSync('/tmp/mail_daily.html', m2.html); writeFileSync('/tmp/mail_probe.html', m3.html);
// 10. Graph 429: retried once, then throttled (not fail); 429 then 200 -> ok
const tok = 'a.' + Buffer.from(JSON.stringify({ roles: ['Team.ReadBasic.All', 'Organization.Read.All', 'Sites.Read.All', 'DeviceManagementServiceConfig.Read.All', 'ServiceHealth.Read.All'] })).toString('base64url') + '.c';
let calls = 0; const R = (status) => ({ status, headers: { get: () => '1' }, arrayBuffer: async () => new ArrayBuffer(0) });
let res = await H.runChecks({}, tok, async () => { calls++; return R(429); }); const tc = res.filter((c) => c.state !== 'noperm' && c.state !== 'noconfig');
assert.ok(tc.length && tc.every((c) => c.state === 'throttled'), 'still 429 -> throttled'); assert.equal(calls, tc.length * 2, 'one retry each');
const seen = {}; res = await H.runChecks({}, tok, async (u) => { seen[u] = (seen[u] || 0) + 1; return R(seen[u] === 1 ? 429 : 200); }); assert.ok(res.filter((c) => c.state !== 'noperm' && c.state !== 'noconfig').every((c) => c.state === 'ok'), '429 then 200 -> ok');
const th = clone(base); th.health[0].checks.find((c) => c.id === 'teams').state = 'throttled'; assert.equal(N.diffEvents(base, th).length, 0, 'throttled is not an event');
console.log('ALL MAIL TESTS PASSED');
