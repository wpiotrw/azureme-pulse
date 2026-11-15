import assert from 'node:assert';
const S = await import('../../probes/signals.mjs');
const T = Date.parse('2026-11-14T00:00:00Z');
const ripe = (seen, total, pfx) => async () => ({ status: 200, body: { data: { visibility: { v4: { ris_peers_seeing: seen, total_ris_peers: total }, v6: { ris_peers_seeing: 300, total_ris_peers: 310 } }, announced_space: { v4: { prefixes: pfx }, v6: { prefixes: 50 } } } } });
let b = await S.readBgp(null, T, ripe(330, 335, 400)); assert.ok(b.ok && b.state === 'ok' && b.v4.prefixes === 400 && b.hist.length === 1);
assert.strictEqual(await S.readBgp(b, T + 5 * 60000, ripe(1, 1, 1)), b, 'cached within 14 min');
let b2 = await S.readBgp(b, T + 15 * 60000, ripe(330, 335, 330)); assert.equal(b2.state, 'warn', 'prefix drop >10% -> warn'); assert.equal(b2.hist.length, 2);
let b3 = await S.readBgp(b, T + 15 * 60000, ripe(100, 335, 400)); assert.equal(b3.state, 'crit', 'visibility <50% -> crit');
let b4 = await S.readBgp(b, T + 15 * 60000, async () => ({ status: 503, body: null })); assert.ok(!b4.ok && b4.v4.prefixes === 400 && b4.state === 'ok' && /^HTTP 503/.test(b4.error), 'failure keeps last reading');
let b5 = await S.readBgp(null, T, async () => { throw new Error('timeout'); }); assert.ok(!b5.ok && !b5.v4);
assert.deepEqual(await S.readRadar(null, T, null, ''), { configured: false });
const day = Array.from({ length: 96 }, (_, k) => 0.6 + 0.3 * Math.sin(k / 15));
const cf = (vals) => async (url, h) => { assert.ok(h.authorization === 'Bearer tok' && url.includes('asn=8075')); return { status: 200, body: { success: true, result: { meta: {}, serie_0: { timestamps: vals.map((_, k) => new Date(T + k * 900000).toISOString()), values: vals.map(String) } } } }; };
let r = await S.readRadar(null, T, cf(day), 'tok'); assert.ok(r.ok && r.state === 'ok' && r.values.length === 96 && !JSON.stringify(r).includes('tok"'), 'radar ok, token not stored');
const dropv = day.slice(); dropv[94] = 0.1; assert.equal((await S.readRadar(null, T, cf(dropv), 'tok')).state, 'crit');
const dip = day.slice(); dip[94] = Math.min(...day.slice(0, 94)) * 0.6; assert.equal((await S.readRadar(null, T, cf(dip), 'tok')).state, 'warn');
let rf = await S.readRadar(r, T + 20 * 60000, async () => ({ status: 403, body: { errors: [{ message: 'Authentication error' }] } }), 'tok'); assert.ok(!rf.ok && rf.values.length === 96 && /403 Authentication/.test(rf.error));
assert.equal(S.signalEvents({ bgp: { state: 'ok' } }, { bgp: b2, radar: { configured: false } }).length, 1);
assert.equal(S.signalEvents({ bgp: { state: 'ok' } }, { bgp: b }).length, 0);
console.log('ALL SIGNAL TESTS PASSED');
// ---- RIPE Atlas
{
  const now = T, sec = Math.floor(now / 1000);
  const probes = Array.from({ length: 120 }, (_, k) => ({ id: 6000 + k, country_code: k < 6 ? 'PL' : k < 12 ? 'XX' : 'DE' }));
  const mk = (failXX, failAll) => async (url) => {
    if (url.includes('/probes/')) return { status: 200, body: { results: probes, next: null } };
    const ids = url.split('probe_ids=')[1].split(',').map(Number);
    return { status: 200, body: ids.map((id) => { const p = probes.find((x) => x.id === id); const down = failAll ? id % 2 === 0 : failXX && p.country_code === 'XX'; return { prb_id: id, timestamp: sec - 100, rcvd: down ? 0 : 3, sent: 3, avg: down ? -1 : 10 + (id % 7) }; }) };
  };
  let a = await S.readAtlas(null, now, mk(false, false)); assert.ok(a.ok && a.n === 120 && a.reach === 100 && a.pl.n === 6 && a.pl.ok === 6 && a.state === 'ok' && a.bad.length === 0, 'atlas ok');
  let a2 = await S.readAtlas(a, now + 15 * 60000, mk(true, false)); assert.ok(a2.reach === 95 && a2.bad[0][0] === 'XX' && a2.state === 'ok', 'one country down: listed, global still ok');
  let a3 = await S.readAtlas(a, now + 15 * 60000, mk(false, true)); assert.equal(a3.state, 'crit', 'half the world down -> crit');
  let a4 = await S.readAtlas(a, now + 15 * 60000, async () => ({ status: 500, body: null })); assert.ok(!a4.ok && a4.reach === 100 && /probes HTTP 500/.test(a4.error));
  const old = await S.readAtlas(null, now, async (url) => url.includes('/probes/') ? { status: 200, body: { results: probes, next: null } } : { status: 200, body: probes.map((p) => ({ prb_id: p.id, timestamp: sec - 7200, rcvd: 3, avg: 5 })) }); assert.ok(!old.ok, 'stale results rejected');
  console.log('ATLAS TESTS PASSED');
}
