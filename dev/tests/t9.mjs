import assert from 'node:assert';
import { slimEvent, readTenantAzure, mergeAzure } from '../../probes/azurehealth.mjs';
const SUB1 = '11111111-2222-3333-4444-555555555555', SUB2 = '66666666-7777-8888-9999-000000000000';
const ev = (id, status, type = 'ServiceIssue') => ({ name: id, properties: { eventType: type, eventLevel: 'Warning', status, title: `Active – Microsoft Defender for Cloud <b>issue</b> ${id}`, summary: '<p>Customers may see&nbsp;delays.</p>', impactStartTime: '2026-11-17T09:00:00Z', lastUpdateTime: '2026-11-18T11:00:00Z', impact: [{ impactedService: 'Microsoft Defender for Cloud', impactedRegions: [{ impactedRegion: 'Global' }] }] } });
function mk({ subs = [SUB1, SUB2], events = { [SUB1]: [ev('7PRY-G18', 'Active'), ev('PM-1', 'Active', 'PlannedMaintenance')], [SUB2]: [ev('7PRY-G18', 'Active'), ev('OLD-1', 'Resolved')] }, tokenOk = true, firstApi400 = false } = {}) {
  const calls = [];
  const f = async (url, opt = {}) => {
    calls.push(String(url));
    const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (String(url).includes('login.microsoftonline.com')) return tokenOk ? res(200, { access_token: 'ARM-TOKEN' }) : res(401, { error: 'invalid_client', error_description: 'AADSTS700016: no app' });
    assert.equal(opt.headers.authorization, 'Bearer ARM-TOKEN');
    if (String(url).includes('/subscriptions?')) return res(200, { value: subs.map((s) => ({ subscriptionId: s, displayName: 'Azure subscription 1', state: 'Enabled' })) });
    const m = /subscriptions\/([^/]+)\/providers\/Microsoft\.ResourceHealth\/events\?api-version=([\d-]+)/.exec(String(url));
    if (m) { if (firstApi400 && m[2] === '2025-05-01') return res(400, {}); return res(200, { value: events[decodeURIComponent(m[1])] || [] }); }
    return res(404, {});
  };
  f.calls = calls; return f;
}
const T = { label: 'Tenant 1', tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', clientId: 'ffffffff-0000-1111-2222-333333333333' };
// 1. event reduced correctly, HTML removed
let s = slimEvent(ev('7PRY-G18', 'Active'));
assert.equal(s.id, '7PRY-G18'); assert.equal(s.level, 'Warning'); assert.ok(!/[<>]/.test(s.title + s.summary)); assert.deepEqual(s.services, ['Microsoft Defender for Cloud']); assert.deepEqual(s.regions, ['Global']);
// 2. two subscriptions, same issue counted once, planned maintenance skipped
let f = mk(); let r = await readTenantAzure(T, 'assertion', f);
assert.equal(r.ok, true); assert.equal(r.subs, 2); assert.equal(r.items.length, 2); assert.equal(r.items.find((i) => i.id === '7PRY-G18').subs, 2); assert.ok(!r.items.some((i) => i.id === 'PM-1'));
// 3. no identifiers leak into the result
const dump = JSON.stringify(r) + JSON.stringify(mergeAzure([r]));
for (const secret of [SUB1, SUB2, T.tenantId, T.clientId, 'ARM-TOKEN', 'Azure subscription 1']) assert.ok(!dump.includes(secret), 'leak ' + secret);
// 4. no role assigned: zero subscriptions is a valid, empty result
r = await readTenantAzure(T, 'a', mk({ subs: [] })); assert.equal(r.ok, true); assert.equal(r.subs, 0); assert.equal(r.items.length, 0);
// 5. sign-in failure is reported without secrets
r = await readTenantAzure(T, 'a', mk({ tokenOk: false })); assert.equal(r.ok, false); assert.match(r.error, /AADSTS700016/);
// 6. older API version is used when the newest one is refused
f = mk({ firstApi400: true }); r = await readTenantAzure(T, 'a', f); assert.equal(r.ok, true); assert.ok(f.calls.some((u) => u.includes('2022-10-01')));
// 7. merge across tenants: one entry, both tenants listed, active first
const a = await readTenantAzure({ ...T, label: 'Tenant 1' }, 'a', mk()), b = await readTenantAzure({ ...T, label: 'Tenant 2' }, 'a', mk({ subs: [SUB1], events: { [SUB1]: [ev('7PRY-G18', 'Active')] } }));
const m = mergeAzure([a, b], Date.parse('2026-11-18T12:00:00Z'));
assert.equal(m.ok, true); assert.equal(m.subs, 3); assert.equal(m.items[0].id, '7PRY-G18'); assert.equal(m.items[0].active, true); assert.equal(m.items[0].tenants.length, 2); assert.equal(m.items.find((i) => i.id === 'OLD-1').active, false);
console.log('AZURE HEALTH TESTS PASSED');
