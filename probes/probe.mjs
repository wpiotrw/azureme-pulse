// AzureMe Pulse: unauthenticated HTTP reachability probes for public Microsoft endpoints.
// Usage: node probes/probe.mjs <previous status.json> <output status.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { readServiceHealth } from './health.mjs';

const [, , prevPath, outPath] = process.argv;
const UA = 'azureme-pulse-probe/0.1 (+https://pulse.azureme.pl)';
const TIMEOUT_MS = 10000;
const MAX_SAMPLES = 576; // 48 h at 5-minute cadence
const MAX_DAYS = 60;

// expect: explicit list of acceptable HTTP codes. Without it any 2xx/3xx final response counts.
// A 401 from an API without a token still proves that the API front end answers.
export const TARGETS = [
  { id: 'entra', name: 'Entra ID', what: 'metadane OpenID Connect', url: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration', expect: [200] },
  { id: 'exo', name: 'Exchange Online', what: 'punkt końcowy EWS, odpowiedź bez tokenu', url: 'https://outlook.office365.com/EWS/Exchange.asmx', expect: [401] },
  { id: 'graph', name: 'Microsoft Graph', what: 'odpowiedź API bez tokenu', url: 'https://graph.microsoft.com/v1.0/me', expect: [401] },
  { id: 'teams', name: 'Teams', what: 'strona klienta WWW', url: 'https://teams.microsoft.com/' },
  { id: 'copilot', name: 'Microsoft 365 Copilot', what: 'strona klienta WWW', url: 'https://m365.cloud.microsoft/' },
  { id: 'intune', name: 'Intune', what: 'centrum administracyjne', url: 'https://intune.microsoft.com/' },
  { id: 'defender', name: 'Defender XDR', what: 'portal zabezpieczeń', url: 'https://security.microsoft.com/' },
  { id: 'azure', name: 'Azure Portal', what: 'strona portalu', url: 'https://portal.azure.com/' },
  { id: 'arm', name: 'Azure Resource Manager', what: 'odpowiedź API bez tokenu', url: 'https://management.azure.com/subscriptions?api-version=2022-12-01', expect: [401] },
];

async function once(t) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(t.url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': UA, accept: '*/*' } });
    await r.arrayBuffer().catch(() => {});
    const ok = t.expect ? t.expect.includes(r.status) : r.status >= 200 && r.status < 400;
    return { ok, code: r.status, ms: Math.round(performance.now() - t0), err: '' };
  } catch (e) {
    const err = e.name === 'AbortError' ? 'timeout' : String(e.cause?.code || e.message || e.name);
    return { ok: false, code: 0, ms: Math.round(performance.now() - t0), err };
  } finally {
    clearTimeout(timer);
  }
}

// One retry, so a single dropped connection is not reported as an outage.
async function probe(t) {
  const first = await once(t);
  if (first.ok) return first;
  const second = await once(t);
  return second.ok ? { ...second, retried: true } : second;
}

export function merge(prev, results, now = Date.now(), health = null) {
  const samples = Array.isArray(prev.samples) ? prev.samples.slice() : [];
  const r = {};
  for (const [id, v] of Object.entries(results)) r[id] = [v.ok ? 1 : 0, v.ms, v.code];
  samples.push({ t: Math.floor(now / 60000), r });
  while (samples.length > MAX_SAMPLES) samples.shift();

  const days = { ...(prev.days || {}) };
  const day = new Date(now).toISOString().slice(0, 10);
  const d = { ...(days[day] || {}) };
  for (const [id, v] of Object.entries(results)) {
    const [ok, total] = d[id] || [0, 0];
    d[id] = [ok + (v.ok ? 1 : 0), total + 1];
  }
  days[day] = d;
  for (const k of Object.keys(days).sort().slice(0, -MAX_DAYS)) delete days[k];

  return {
    schema: 1,
    generated: new Date(now).toISOString(),
    stepMin: 5,
    vantage: 'GitHub Actions (jedna lokalizacja)',
    services: TARGETS.map(({ id, name, what }) => ({ id, name, what, last: results[id] })),
    health: health ?? prev.health ?? [],
    samples,
    days,
  };
}

if (prevPath && outPath) {
  let prev = {};
  try { prev = JSON.parse(readFileSync(prevPath, 'utf8')); } catch { prev = {}; }
  const entries = await Promise.all(TARGETS.map(async (t) => [t.id, await probe(t)]));
  const results = Object.fromEntries(entries);
  for (const t of TARGETS) {
    const v = results[t.id];
    console.log(`${v.ok ? 'OK  ' : 'FAIL'} ${t.id.padEnd(9)} code=${v.code} ${v.ms} ms ${v.err}`);
  }
  const health = await readServiceHealth();
  for (const h of health) console.log(`${h.ok ? 'OK  ' : 'FAIL'} health:${h.label} services=${h.services.length} issues=${h.issues.length} ${h.query || ''} ${h.error || ''}`);
  // Keep the previous reading for a tenant whose read failed, so one failed login does not blank the page.
  const prevHealth = Array.isArray(prev.health) ? prev.health : [];
  const merged = health.map((h) => (h.ok ? h : { ...(prevHealth.find((p) => p.label === h.label && p.ok) || h), lastError: h.error, lastErrorAt: h.fetched }));
  writeFileSync(outPath, JSON.stringify(merge(prev, results, Date.now(), health.length ? merged : null)));
}
