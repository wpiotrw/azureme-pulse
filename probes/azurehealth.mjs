// Azure Service Health per subscription (Service issues visible in the Azure portal under Service Health).
// Uses the same federated sign-in as Service health for Microsoft 365, with a token for Azure Resource Manager.
// The app needs the Reader role on a subscription; subscriptions are discovered automatically, so no
// subscription identifier is stored in the repository, in logs or in the published data.
import { githubOidcToken, publicLabel } from './health.mjs';

const ARM = 'https://management.azure.com';
const API = ['2025-05-01', '2022-10-01'];
const MAX_SUBS = 10;

export async function armToken(tenant, assertion, fetchImpl = fetch) {
  const body = new URLSearchParams({
    client_id: tenant.clientId,
    scope: `${ARM}/.default`,
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });
  const r = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenant.tenantId)}/oauth2/v2.0/token`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`logowanie ARM: ${/AADSTS\d+/.exec(j.error_description || '')?.[0] || j.error || `HTTP ${r.status}`}`);
  return j.access_token;
}

async function armGet(url, token, fetchImpl) {
  const r = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

const text = (s, n) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, n);

// One Service Health event reduced to what the portal shows. No subscription or resource identifiers.
export function slimEvent(e) {
  const p = e?.properties || {};
  const services = [];
  const regions = [];
  for (const i of p.impact || []) {
    if (i.impactedService && !services.includes(i.impactedService)) services.push(i.impactedService);
    for (const r of i.impactedRegions || []) if (r.impactedRegion && !regions.includes(r.impactedRegion)) regions.push(r.impactedRegion);
  }
  return {
    id: String(e?.name || p.trackingId || '').slice(0, 40),
    type: p.eventType || '',
    level: p.eventLevel || p.level || '',
    status: p.status || '',
    title: text(p.title, 200),
    summary: text(p.summary, 600),
    services: services.slice(0, 12),
    regions: regions.slice(0, 12),
    start: p.impactStartTime || null,
    end: p.impactMitigationTime || null,
    updated: p.lastUpdateTime || null,
  };
}

export async function readTenantAzure(tenant, assertion, fetchImpl = fetch) {
  const out = { label: publicLabel(tenant), ok: false, subs: 0, error: '', items: [] };
  try {
    const token = await armToken(tenant, assertion, fetchImpl);
    const s = await armGet(`${ARM}/subscriptions?api-version=2022-12-01`, token, fetchImpl);
    if (s.status !== 200) throw new Error(`subskrypcje: HTTP ${s.status}`);
    const subs = (s.body.value || []).filter((x) => x.state === 'Enabled' || !x.state).slice(0, MAX_SUBS);
    out.subs = subs.length;
    const seen = new Map();
    for (const sub of subs) {
      let got = null;
      for (const v of API) {
        const r = await armGet(`${ARM}/subscriptions/${encodeURIComponent(sub.subscriptionId)}/providers/Microsoft.ResourceHealth/events?api-version=${v}`, token, fetchImpl);
        if (r.status === 200) { got = r.body; break; }
        if (r.status !== 400 && r.status !== 404) throw new Error(`zdarzenia: HTTP ${r.status}`);
      }
      if (!got) throw new Error('zdarzenia: nieobsługiwana wersja interfejsu');
      for (const e of got.value || []) {
        const x = slimEvent(e);
        if (!x.id || x.type !== 'ServiceIssue') continue;
        const k = seen.get(x.id);
        if (k) k.subs += 1; else seen.set(x.id, { ...x, subs: 1 });
      }
    }
    out.items = [...seen.values()];
    out.ok = true;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 160);
  }
  return out;
}

// Merged view across tenants: one entry per tracking ID with the list of tenants in which it is visible.
export function mergeAzure(perTenant, now = Date.now()) {
  const map = new Map();
  for (const t of perTenant) {
    for (const i of t.items || []) {
      const m = map.get(i.id);
      if (m) { m.tenants.push(t.label); m.subs += i.subs; } else map.set(i.id, { ...i, tenants: [t.label] });
    }
  }
  const items = [...map.values()].map((i) => ({ ...i, active: i.status === 'Active' })).sort((a, b) => (b.active - a.active) || String(b.updated).localeCompare(String(a.updated)));
  return {
    fetched: new Date(now).toISOString(),
    ok: perTenant.some((t) => t.ok),
    tenants: perTenant.map((t) => ({ label: t.label, ok: t.ok, subs: t.subs, error: t.error })),
    subs: perTenant.reduce((a, t) => a + (t.subs || 0), 0),
    items,
  };
}

export async function readAzureHealth(now = Date.now()) {
  let tenants;
  try { tenants = JSON.parse(process.env.PULSE_TENANTS || '[]'); } catch { return null; }
  if (!Array.isArray(tenants) || tenants.length === 0) return null;
  let assertion;
  try { assertion = await githubOidcToken(); } catch (e) {
    return mergeAzure(tenants.map((t) => ({ label: publicLabel(t), ok: false, subs: 0, error: String(e.message).slice(0, 160), items: [] })), now);
  }
  return mergeAzure(await Promise.all(tenants.map((t) => readTenantAzure(t, assertion))), now);
}
