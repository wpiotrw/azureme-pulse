import assert from 'node:assert';
import { readFileSync } from 'node:fs';
const { updateCases, MAX_CLOSED, TAIL_MIN } = await import('../../probes/cases.mjs');
const base = JSON.parse(readFileSync(new URL('./data/real12.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const T0 = Date.parse(base.generated);
// 1. creation with backfill
let c1 = updateCases({}, base, T0);
const inc = c1.cases.map((c) => c.id);
console.log('cases', inc, 'pts', c1.cases.map((c) => c.pts.length), 'posts', c1.cases.map((c) => c.posts.length));
assert.equal(c1.cases.length, 2, 'two incidents -> two cases');
assert.ok(c1.cases.every((c) => !c.end && c.pts.length === base.samples.length), 'backfilled from samples');
assert.ok(c1.cases.every((c) => c.tenants.length >= 1 && c.probes.length === 17));
const full = 2 ** 17 - 1; assert.equal(c1.cases[0].pts.at(-1)[1], full, 'all probes ok in mask');
// 2. same run again -> no duplicate point / post
let c2 = updateCases(c1, base, T0 + 1000);
assert.deepEqual(c2.cases.map((c) => c.pts.length), c1.cases.map((c) => c.pts.length), 'no duplicate points');
assert.deepEqual(c2.cases.map((c) => c.posts.length), c1.cases.map((c) => c.posts.length));
// 3. next run: new sample with one failure, new post via log, fresh event
const n = clone(base); const lt = n.samples.at(-1).t; n.generated = new Date(T0 + 300000).toISOString();
n.samples.push({ t: lt + 5, r: { ...n.samples.at(-1).r, exo: [0, 10000, 0] } });
n.events = [{ t: n.generated, sev: 'crit', kind: 'Sonda HTTP', title: 'x', text: 'y' }];
for (const h of n.health) for (const i of h.issues) if (i.id === inc[0]) { i.log = [{ t: '2026-11-12T19:00:00Z', s: 'old' }, { t: '2026-11-14T01:00:00Z', s: 'new update' }]; i.updateAt = '2026-11-14T01:00:00Z'; }
let c3 = updateCases(c2, n, T0 + 300000);
const a = c3.cases.find((c) => c.id === inc[0]);
assert.equal(a.pts.length, c1.cases[0].pts.length + 1); assert.equal(a.pts.at(-1)[1], full - 2 ** a.probes.indexOf('exo'), 'failed probe bit cleared');
assert.ok(a.posts.some((p) => p.s === 'new update') && a.posts.some((p) => p.s === 'old'), 'log merged'); assert.equal(a.events.length, 1);
assert.ok(a.posts.every((p, k, arr) => !k || arr[k - 1].t <= p.t), 'posts sorted');
// 4. resolved -> end set, tail keeps measuring, then freezes
const r = clone(n); r.generated = new Date(T0 + 600000).toISOString(); r.samples.push({ t: lt + 10, r: n.samples.at(-1).r }); r.events = [];
const endIso = new Date((lt + 10) * 60000).toISOString();
for (const h of r.health) for (const i of h.issues) if (i.id === inc[0]) { i.resolved = true; i.end = endIso; i.status = 'serviceRestored'; }
let c4 = updateCases(c3, r, T0 + 600000); const b = c4.cases.find((c) => c.id === inc[0]);
assert.equal(b.end, endIso); assert.equal(b.pts.length, a.pts.length + 1, 'tail point added');
assert.equal(c4.cases.at(-1).id, inc[0], 'closed case sorted after open ones');
const late = clone(r); late.samples.push({ t: lt + 10 + TAIL_MIN + 5, r: n.samples.at(-1).r });
let c5 = updateCases(c4, late, T0 + 9e6); assert.equal(c5.cases.find((c) => c.id === inc[0]).pts.length, b.pts.length, 'frozen after tail');
// 5. reopened
const ro = clone(late); for (const h of ro.health) for (const i of h.issues) if (i.id === inc[0]) { i.resolved = false; }
assert.ok(!updateCases(c5, ro, T0 + 9.1e6).cases.find((c) => c.id === inc[0]).end, 'reopened clears end');
// 6. issue dropped from all tenants -> assumed end; but not when no tenant was read
const d = clone(late); for (const h of d.health) h.issues = h.issues.filter((i) => i.id !== inc[1]);
const c6 = updateCases(c5, d, T0 + 9.2e6).cases.find((c) => c.id === inc[1]); assert.ok(c6.end && c6.endAssumed, 'dropped -> assumed end');
const f = clone(d); for (const h of f.health) h.lastError = 'x';
assert.ok(!updateCases(c5, f, T0 + 9.2e6).cases.find((c) => c.id === inc[1]).end, 'no close when reads failed');
// 7. history cap, already-closed-on-first-sight ignored, advisories ignored
const many = { cases: Array.from({ length: 9 }, (_, k) => ({ id: 'XX' + k, start: '2026-10-0' + (k + 1) + 'T00:00:00Z', end: '2026-10-1' + k + 'T00:00:00Z', pts: [], posts: [], probes: [] })) };
const c7 = updateCases(many, base, T0); assert.equal(c7.cases.filter((c) => c.end).length, MAX_CLOSED); assert.equal(c7.cases.filter((c) => c.end)[0].id, 'XX8', 'newest closed first');
const g = clone(base); for (const h of g.health) for (const i of h.issues) i.resolved = true; assert.equal(updateCases({}, g, T0).cases.length, 0, 'closed on first sight ignored');
assert.ok(!c1.cases.some((c) => base.health.some((h) => h.issues.some((i) => i.id === c.id && i.classification !== 'incident'))), 'advisories ignored');
console.log('size bytes', JSON.stringify(c1).length);
// 9. wycofane teczki: osobna pula na 7 dni, niezależna od limitu zamkniętych
{
  const { WITHDRAWN_DAYS } = await import('../../probes/cases.mjs');
  const iso = (ms) => new Date(ms).toISOString();
  const mk = (id, endMs, extra = {}) => ({ id, firstSeen: iso(endMs - 3600000), probes: [], probeNames: [], posts: [], pts: [], events: [], title: id, start: iso(endMs - 3600000), end: iso(endMs), lastSeen: iso(endMs), ...extra });
  const prevC = { cases: [mk('WD0000001', T0 - 2 * 86400000, { endAssumed: true }), mk('WD0000002', T0 - (WITHDRAWN_DAYS + 1) * 86400000, { endAssumed: true }), ...Array.from({ length: MAX_CLOSED + 2 }, (_, k) => mk('ZZ000000' + k, T0 - (k + 1) * 3600000))] };
  const empty = clone(base); for (const h of empty.health) h.issues = [];
  const r = updateCases(prevC, empty, T0); const ids = r.cases.map((c) => c.id);
  assert.ok(ids.includes('WD0000001'), 'wycofana teczka sprzed 2 dni zostaje mimo nowszych zamkniętych');
  assert.ok(!ids.includes('WD0000002'), 'wycofana teczka starsza niż 7 dni znika');
  assert.equal(r.cases.filter((c) => c.end && !c.endAssumed).length, MAX_CLOSED);
}
console.log('ALL CASE TESTS PASSED');
