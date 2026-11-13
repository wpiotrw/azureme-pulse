// AzureMe Pulse: Microsoft 365 Service Health read through Microsoft Graph.
// Authentication: GitHub Actions OIDC token exchanged for a Graph token (workload identity federation, no secret).
// Configuration: env PULSE_TENANTS = JSON array of { "label": "...", "tenantId": "...", "clientId": "..." }.
// Tenant and client identifiers are never written to the output file; only the label is.

const GRAPH = 'https://graph.microsoft.com/v1.0/admin/serviceAnnouncement';
const AUDIENCE = 'api://AzureADTokenExchange';
const RECENT_DAYS = 7;
const MAX_ISSUES = 40;

async function githubOidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) throw new Error('brak tokenu OIDC (zadanie nie ma uprawnienia id-token: write)');
  const r = await fetch(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, { headers: { authorization: `bearer ${token}` } });
  if (!r.ok) throw new Error(`OIDC GitHub: HTTP ${r.status}`);
  return (await r.json()).value;
}

async function graphToken(tenant, assertion) {
  const body = new URLSearchParams({
    client_id: tenant.clientId,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant.tenantId)}/oauth2/v2.0/token`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const code = /AADSTS\d+/.exec(j.error_description || '')?.[0] || j.error || `HTTP ${r.status}`;
    // The subject claim identifies the workflow, not a secret; reporting it makes a mismatch with the federated credential visible.
    let sub = '';
    try { sub = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()).sub || ''; } catch { sub = ''; }
    throw new Error(`logowanie: ${code}; sub=${sub}`);
  }
  return j.access_token;
}

async function graphGet(url, token) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

// Label shown on the public page: the configured name plus the first four characters of the tenant id,
// enough for the owner to tell tenants apart without publishing the identifier.
export function publicLabel(tenant) {
  return `${tenant.label} (${String(tenant.tenantId || '').slice(0, 4)}…)`;
}

export function slimIssue(i) {
  return {
    id: i.id,
    title: String(i.title || '').slice(0, 300),
    service: i.service,
    feature: i.featureGroup || i.feature || '',
    status: i.status,
    classification: i.classification,
    start: i.startDateTime || null,
    end: i.endDateTime || null,
    modified: i.lastModifiedDateTime || null,
    resolved: !!i.isResolved,
  };
}

export function isRelevant(i, now = Date.now()) {
  if (!i.isResolved) return true;
  const m = Date.parse(i.lastModifiedDateTime || i.endDateTime || '');
  return !Number.isNaN(m) && now - m <= RECENT_DAYS * 86400000;
}

// The documentation does not list which $filter expressions the issues endpoint accepts,
// so try the narrow queries first and fall back to paging through everything.
async function loadIssues(token) {
  const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
  const attempts = [
    ['filter:lastModified', `${GRAPH}/issues?$filter=${encodeURIComponent(`lastModifiedDateTime ge ${since}`)}`],
    ['filter:unresolved', `${GRAPH}/issues?$filter=${encodeURIComponent('isResolved eq false')}`],
    ['paging', `${GRAPH}/issues`],
  ];
  for (const [mode, first] of attempts) {
    let url = first;
    const all = [];
    let pages = 0;
    let failed = false;
    while (url && pages < 25) {
      const r = await graphGet(url, token);
      if (r.status !== 200) { failed = true; break; }
      all.push(...(r.body.value || []));
      url = r.body['@odata.nextLink'] || null;
      pages += 1;
    }
    if (!failed) return { mode, issues: all.filter((i) => isRelevant(i)) };
  }
  throw new Error('issues: żadne zapytanie nie powiodło się');
}

async function readTenant(tenant, assertion) {
  const out = { label: publicLabel(tenant), fetched: new Date().toISOString(), ok: false, error: '', services: [], issues: [], query: '' };
  try {
    const token = await graphToken(tenant, assertion);
    const ho = await graphGet(`${GRAPH}/healthOverviews`, token);
    if (ho.status !== 200) throw new Error(`healthOverviews: HTTP ${ho.status} ${ho.body?.error?.code || ''}`.trim());
    out.services = (ho.body.value || []).map((s) => ({ id: s.id, name: s.service, status: s.status }));
    const { mode, issues } = await loadIssues(token);
    out.query = mode;
    out.issues = issues
      .sort((a, b) => String(b.lastModifiedDateTime).localeCompare(String(a.lastModifiedDateTime)))
      .slice(0, MAX_ISSUES)
      .map(slimIssue);
    out.ok = true;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 200);
  }
  return out;
}

export async function readServiceHealth() {
  let tenants;
  try { tenants = JSON.parse(process.env.PULSE_TENANTS || '[]'); } catch { return [{ label: 'konfiguracja', ok: false, error: 'PULSE_TENANTS nie jest poprawnym JSON', services: [], issues: [] }]; }
  if (!Array.isArray(tenants) || tenants.length === 0) return [];
  let assertion;
  try { assertion = await githubOidcToken(); } catch (e) {
    return tenants.map((t) => ({ label: publicLabel(t), fetched: new Date().toISOString(), ok: false, error: String(e.message).slice(0, 200), services: [], issues: [] }));
  }
  return Promise.all(tenants.map((t) => readTenant(t, assertion)));
}
