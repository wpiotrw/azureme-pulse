// AzureMe Pulse: Microsoft 365 Service Health read through Microsoft Graph.
// Authentication: GitHub Actions OIDC token exchanged for a Graph token (workload identity federation, no secret).
// Configuration: env PULSE_TENANTS = JSON array of { "label": "...", "tenantId": "...", "clientId": "..." }.
// Tenant and client identifiers are never written to the output file; only the label is.

import { htmlToText } from './azure.mjs';
import { slimPost } from './mscloud.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0/admin/serviceAnnouncement';
const AUDIENCE = 'api://AzureADTokenExchange';
const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const CHECK_TIMEOUT_MS = 15000;

// Functional checks: one cheap read per service, each behind the narrowest application permission
// that Microsoft documents for that call. A check runs only when the token carries its permission.
// Response bodies are discarded; only the outcome, HTTP code and duration are stored.
export const CHECKS = [
  { id: 'dir', service: 'Microsoft Entra', name: 'odczyt organizacji z katalogu', role: 'Organization.Read.All', path: () => '/organization?$select=id' },
  { id: 'exo', service: 'Exchange Online', name: 'odczyt ustawień skrzynki testowej', role: 'MailboxSettings.Read', needs: 'mailboxUser', path: (t) => `/users/${encodeURIComponent(t.mailboxUser)}/mailboxSettings` },
  { id: 'spo', service: 'SharePoint Online', name: 'odczyt ustawień SharePoint tenanta', role: 'SharePointTenantSettings.Read.All', path: () => '/admin/sharepoint/settings' },
  { id: 'intune', service: 'Microsoft Intune', name: 'odczyt konfiguracji rejestracji urządzeń', role: 'DeviceManagementServiceConfig.Read.All', path: () => '/deviceManagement/deviceEnrollmentConfigurations?$top=1&$select=id' },
  { id: 'teams', service: 'Microsoft Teams', name: 'odczyt listy zespołów', role: 'Team.ReadBasic.All', path: () => '/teams?$top=1&$select=id' },
];

export function tokenRoles(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).roles || []; } catch { return []; }
}

export async function runChecks(tenant, token, fetchImpl = fetch) {
  const roles = tokenRoles(token);
  return Promise.all(CHECKS.map(async (c) => {
    const base = { id: c.id, service: c.service, name: c.name, role: c.role };
    if (!roles.includes(c.role)) return { ...base, state: 'noperm', code: 0, ms: 0 };
    if (c.needs && !tenant[c.needs]) return { ...base, state: 'noconfig', code: 0, ms: 0 };
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CHECK_TIMEOUT_MS);
    try {
      const r = await fetchImpl(GRAPH_ROOT + c.path(tenant), { signal: ac.signal, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      await r.arrayBuffer().catch(() => {});
      // 403 after the role check means the service itself refused (for example no licence), not an outage.
      const state = r.status === 200 ? 'ok' : r.status === 403 ? 'denied' : 'fail';
      return { ...base, state, code: r.status, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ...base, state: 'fail', code: 0, ms: Math.round(performance.now() - t0), err: e.name === 'AbortError' ? 'timeout' : 'sieć' };
    } finally { clearTimeout(timer); }
  }));
}

const RECENT_DAYS = 7;
const MAX_ISSUES = 40;

export async function githubOidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) throw new Error('brak tokenu OIDC (zadanie nie ma uprawnienia id-token: write)');
  const r = await fetch(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, { headers: { authorization: `bearer ${token}` } });
  if (!r.ok) throw new Error(`OIDC GitHub: HTTP ${r.status}`);
  return (await r.json()).value;
}

export async function graphToken(tenant, assertion) {
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
    ...latestPost(i),
  };
}

// Latest Microsoft update on the issue, as plain text. Only a short excerpt is published.
export function latestPost(i) {
  const posts = Array.isArray(i.posts) ? i.posts.slice() : [];
  if (!posts.length) return {};
  posts.sort((a, b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)));
  const text = htmlToText(posts[0].description?.content, 8000);
  return text ? { ...slimPost(text), updateAt: posts[0].createdDateTime || null, posts: posts.length } : {};
}

export function slimMessage(m) {
  return {
    id: m.id,
    title: String(m.title || '').slice(0, 240),
    services: Array.isArray(m.services) ? m.services.slice(0, 6) : [],
    category: m.category || '',
    major: !!m.isMajorChange,
    actionBy: m.actionRequiredByDateTime || null,
    modified: m.lastModifiedDateTime || null,
  };
}

const MESSAGE_DAYS = 14;
const MAX_MESSAGES = 20;

// Message Center: announcements changed in the last 14 days. Runs only when the token carries ServiceMessage.Read.All.
async function loadMessages(token) {
  if (!tokenRoles(token).includes('ServiceMessage.Read.All')) return { state: 'noperm', list: [] };
  const since = new Date(Date.now() - MESSAGE_DAYS * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
  const attempts = [
    `${GRAPH}/messages?$filter=${encodeURIComponent(`lastModifiedDateTime ge ${since}`)}&$top=100`,
    `${GRAPH}/messages?$top=100`,
  ];
  for (const url of attempts) {
    const r = await graphGet(url, token);
    if (r.status !== 200) continue;
    const list = (r.body.value || [])
      .filter((m) => Date.parse(m.lastModifiedDateTime || '') >= Date.parse(since))
      .sort((a, b) => String(b.lastModifiedDateTime).localeCompare(String(a.lastModifiedDateTime)))
      .slice(0, MAX_MESSAGES)
      .map(slimMessage);
    return { state: 'ok', list };
  }
  return { state: 'fail', list: [] };
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
  const out = { label: publicLabel(tenant), fetched: new Date().toISOString(), ok: false, error: '', services: [], issues: [], checks: [], query: '' };
  try {
    const token = await graphToken(tenant, assertion);
    out.checks = await runChecks(tenant, token);
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
    // Message Center is supplementary: its failure must not invalidate the Service Health reading.
    try { const mc = await loadMessages(token); out.messages = mc.list; out.messagesState = mc.state; } catch { out.messagesState = 'fail'; }
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
