// AzureMe Pulse: unauthenticated HTTP reachability probes for public Microsoft endpoints.
// Usage: node probes/probe.mjs <previous status.json> <output status.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { readServiceHealth } from './health.mjs';
import { readAzureStatus } from './azure.mjs';
import { notify, diffEvents } from './notify.mjs';
import { probeRegions } from './regions.mjs';
import { readPublicStatus } from './mscloud.mjs';
import { updateCases } from './cases.mjs';
import { readSignals, signalEvents } from './signals.mjs';

const [, , prevPath, outPath, prevCasesPath, casesPath] = process.argv;
const UA = 'azureme-pulse-probe/0.1 (+https://pulse.azureme.pl)';
const TIMEOUT_MS = 10000;
const MAX_SAMPLES = 576; // 48 h at 5-minute cadence
const MAX_DAYS = 60;
const MAX_EVENTS = 80;

// expect: explicit list of acceptable HTTP codes. Without it any 2xx/3xx final response counts.
// A 401 from an API without a token still proves that the API front end answers.
export const TARGETS = [
  { id: 'entra', name: 'Entra ID', what: 'metadane OpenID Connect', url: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration', expect: [200] },
  { id: 'entra-keys', name: 'Entra ID', what: 'klucze podpisujące tokeny (JWKS)', url: 'https://login.microsoftonline.com/common/discovery/v2.0/keys', expect: [200] },
  { id: 'exo', name: 'Exchange Online', what: 'punkt końcowy EWS, odpowiedź bez tokenu', url: 'https://outlook.office365.com/EWS/Exchange.asmx', expect: [401] },
  { id: 'exo-mapi', name: 'Exchange Online', what: 'MAPI over HTTP (Outlook), odpowiedź bez tokenu', url: 'https://outlook.office365.com/mapi/emsmdb/', expect: [401] },
  { id: 'exo-autod', name: 'Exchange Online', what: 'Autodiscover v2, odpowiedź JSON', url: 'https://outlook.office365.com/autodiscover/autodiscover.json/v1.0/pulse@outlook.com?Protocol=EWS', expect: [200] },
  { id: 'graph', name: 'Microsoft Graph', what: 'odpowiedź API bez tokenu', url: 'https://graph.microsoft.com/v1.0/me', expect: [401] },
  { id: 'graph-userinfo', name: 'Microsoft Graph', what: 'OpenID Connect UserInfo, odpowiedź bez tokenu', url: 'https://graph.microsoft.com/oidc/userinfo', expect: [401] },
  { id: 'graph-meta', name: 'Microsoft Graph', what: 'dokument metadanych API v1.0', url: 'https://graph.microsoft.com/v1.0/$metadata', expect: [200], noBody: true },
  { id: 'teams', name: 'Teams', what: 'strona klienta WWW', url: 'https://teams.microsoft.com/' },
  { id: 'copilot', name: 'Microsoft 365 Copilot', what: 'strona klienta WWW', url: 'https://m365.cloud.microsoft/' },
  { id: 'intune', name: 'Intune', what: 'centrum administracyjne', url: 'https://intune.microsoft.com/' },
  { id: 'intune-enroll', name: 'Intune', what: 'usługa wykrywania rejestracji urządzeń', url: 'https://enrollment.manage.microsoft.com/enrollmentserver/discovery.svc', expect: [200] },
  { id: 'defender', name: 'Defender XDR', what: 'portal zabezpieczeń', url: 'https://security.microsoft.com/' },
  { id: 'defender-api', name: 'Defender XDR', what: 'API incydentów, odpowiedź bez tokenu', url: 'https://api.security.microsoft.com/api/incidents', expect: [401] },
  { id: 'azure', name: 'Azure Portal', what: 'strona portalu', url: 'https://portal.azure.com/' },
  { id: 'arm', name: 'Azure Resource Manager', what: 'odpowiedź API bez tokenu', url: 'https://management.azure.com/subscriptions?api-version=2022-12-01', expect: [401] },
  { id: 'arm-meta', name: 'Azure Resource Manager', what: 'metadane punktów końcowych chmury', url: 'https://management.azure.com/metadata/endpoints?api-version=2022-09-01', expect: [200] },
];

async function once(t) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(t.url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': UA, accept: '*/*' } });
    // noBody: a large document; the response headers are enough, so the body is not downloaded.
    if (t.noBody) await r.body?.cancel().catch(() => {});
    else await r.arrayBuffer().catch(() => {});
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

export function merge(prev, results, now = Date.now(), health = null, azure = null) {
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
    services: TARGETS.map(({ id, name, what, url, expect }) => ({ id, name, what, url, expect: expect ? expect.join(', ') : '2xx lub 3xx', last: results[id] })),
    health: health ?? prev.health ?? [],
    // Keep the last good Azure reading when the feed is unreachable.
    azure: azure?.ok ? azure : prev.azure ? { ...prev.azure, lastError: azure?.error || '' } : azure,
    notify: prev.notify || {},
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
    console.log(`${v.ok ? 'OK  ' : 'FAIL'} ${t.id.padEnd(14)} code=${v.code} ${v.ms} ms ${v.err}`);
  }
  const health = await readServiceHealth();
  for (const h of health) console.log(`${h.ok ? 'OK  ' : 'FAIL'} health:${h.label} services=${h.services.length} issues=${h.issues.length} ${h.query || ''} ${h.error || ''}`);
  // Keep the previous reading for a tenant whose read failed, so one failed login does not blank the page.
  const prevHealth = Array.isArray(prev.health) ? prev.health : [];
  const merged = health.map((h) => (h.ok ? h : { ...(prevHealth.find((p) => p.label === h.label && p.ok) || h), lastError: h.error, lastErrorAt: h.fetched }));
  const azure = await readAzureStatus();
  console.log(`${azure.ok ? 'OK  ' : 'FAIL'} azure-status items=${azure.items.length} ${azure.error}`);
  const next = merge(prev, results, Date.now(), health.length ? merged : null, azure);
  const pub = await readPublicStatus();
  console.log(`${pub.ok ? 'OK  ' : 'FAIL'} status.cloud.microsoft m365=${pub.m365?.status || ''} ${pub.error}`);
  next.public = pub.ok ? pub : prev.public ? { ...prev.public, lastError: pub.error } : pub;
  next.regions = await probeRegions(prev.regions);
  const down = next.regions.list.filter((r) => !r.ok);
  console.log(`${down.length ? 'FAIL' : 'OK  '} regions ${next.regions.list.length - down.length}/${next.regions.list.length} ${down.map((r) => r.id).join(',')}`);
  try { next.signals = await readSignals(prev.signals); } catch (e) { next.signals = prev.signals || {}; console.log(`FAIL signals ${e.message}`); }
  console.log(`${next.signals.bgp?.ok ? 'OK  ' : 'FAIL'} bgp AS8075 v4=${next.signals.bgp?.v4?.seen}/${next.signals.bgp?.v4?.total} prefixes=${next.signals.bgp?.v4?.prefixes} state=${next.signals.bgp?.state} ${next.signals.bgp?.error || ''}`);
  console.log(`${next.signals.atlas?.ok ? 'OK  ' : 'FAIL'} atlas www.office.com anchors=${next.signals.atlas?.n} reach=${next.signals.atlas?.reach}% med=${next.signals.atlas?.med} ms countries=${next.signals.atlas?.countries} pl=${JSON.stringify(next.signals.atlas?.pl)} bad=${JSON.stringify(next.signals.atlas?.bad)} state=${next.signals.atlas?.state} ${next.signals.atlas?.error || ''}`);
  console.log(next.signals.radar?.configured ? `${next.signals.radar.ok ? 'OK  ' : 'FAIL'} radar points=${next.signals.radar.values?.length} dev=${next.signals.radar.dev} state=${next.signals.radar.state} week=${next.signals.radar.week ? `${next.signals.radar.week.ratio}%/${next.signals.radar.week.basis}` : `- ${next.signals.radar.weekError || ''}`} ${next.signals.radar.error || ''}` : 'SKIP radar: secret PULSE_CLOUDFLARE_TOKEN not set');
  // Change log shown on the page: state changes detected between this run and the previous one, newest first.
  const hasPrev = Array.isArray(prev.samples) && prev.samples.length > 0;
  const fresh = hasPrev ? [...diffEvents(prev, next), ...signalEvents(prev.signals, next.signals)].map((e) => ({ t: next.generated, sev: e.sev, kind: e.kind, title: String(e.title).slice(0, 200), text: String(e.text || '').slice(0, 300) })) : [];
  next.events = [...fresh, ...(Array.isArray(prev.events) ? prev.events : [])].slice(0, MAX_EVENTS);
  // Incident case files (separate file on the data branch). A failure here must not stop the measurement.
  if (casesPath) {
    try {
      let prevCases = {};
      try { prevCases = JSON.parse(readFileSync(prevCasesPath, 'utf8')); } catch { prevCases = {}; }
      const cases = updateCases(prevCases, next);
      writeFileSync(casesPath, JSON.stringify(cases));
      console.log(`OK   cases open=${cases.cases.filter((c) => !c.end).length} closed=${cases.cases.filter((c) => c.end).length}`);
    } catch (e) {
      console.log(`FAIL cases ${e.message}`);
      try { writeFileSync(casesPath, readFileSync(prevCasesPath, 'utf8')); } catch { writeFileSync(casesPath, '{"schema":1,"cases":[]}'); }
    }
  }
  for (const h of next.health || []) for (const i of h.issues || []) delete i.log;
  next.notify = await notify(prev, next);
  writeFileSync(outPath, JSON.stringify(next));
}
