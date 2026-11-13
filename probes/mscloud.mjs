// AzureMe Pulse: public Microsoft status page (status.cloud.microsoft), read without authentication.
// The page publishes one current post for Microsoft 365 (shown when the admin center may be unreachable),
// one for Azure and a list of consumer services.
import { htmlToText } from './azure.mjs';

const BASE = 'https://status.cloud.microsoft/api/posts/';
const LABELS = ['Title', 'User impact', 'More info', 'Current status', 'Scope of impact', 'Start time', 'Preliminary root cause', 'Root cause', 'Next steps', 'Next update by', 'Estimated time to resolve', 'Final status'];

// Splits a Microsoft service post into its labelled parts ("User impact: … Current status: … Next update by: …").
export function postSections(text) {
  const t = String(text || '');
  const re = new RegExp(`(^|[\\s.])(${LABELS.join('|')}):\\s`, 'g');
  const marks = [...t.matchAll(re)].map((m) => ({ label: m[2], at: m.index + m[1].length, from: m.index + m[0].length }));
  const out = {};
  marks.forEach((m, i) => { if (!(m.label in out)) out[m.label] = t.slice(m.from, i + 1 < marks.length ? marks[i + 1].at : t.length).trim(); });
  return out;
}

export function parseNext(raw) {
  if (!raw) return null;
  const d = Date.parse(String(raw).replace(/^[A-Za-z]+,\s*/, '').replace(/,?\s+at\s+/i, ' ').replace(/\.$/, ''));
  return Number.isNaN(d) ? null : new Date(d).toISOString();
}

// Services listed in the "More info" part of a post as lines "- Service name: impact".
// The list describes the scope of one issue; the entries are not separate issues.
export function postServices(html) {
  const lines = String(html || '')
    .replace(/<\s*(br|\/div|\/p|\/li)\s*\/?>/gi, '\n')
    .split('\n')
    .map((l) => htmlToText(l, 2000));
  const out = [];
  const seen = new Set();
  for (const l of lines) {
    const m = /^[-•]\s*([A-Z][^:]{1,70}):\s+(.{10,})$/.exec(l);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ n: m[1].trim(), t: m[2].length > 320 ? `${m[2].slice(0, 319).trimEnd()}…` : m[2] });
    if (out.length >= 40) break;
  }
  return out;
}

// Identifiers of other issues mentioned in the text (for example EX1550543 inside MO1550821).
export function postRefs(text, ownId = '') {
  return [...new Set(String(text || '').match(/\b(?!MC)[A-Z]{2}\d{6,7}\b/g) || [])].filter((x) => x !== ownId).slice(0, 10);
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s || '');

// Fields published for one post: short parts only, never the whole message.
export function slimPost(text) {
  const s = postSections(text);
  return {
    impact: clip(s['User impact'], 400),
    current: clip(s['Current status'] || s['Final status'] || (Object.keys(s).length ? '' : text), 900),
    scope: clip(s['Scope of impact'], 300),
    nextRaw: clip(s['Next update by'], 80),
    next: parseNext(s['Next update by']),
  };
}

const iso = (v) => { const d = Date.parse(v || ''); return Number.isNaN(d) || d < 946684800000 ? null : new Date(d).toISOString(); };

async function get(name, fetchImpl) {
  const r = await fetchImpl(BASE + name, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

export async function readPublicStatus(fetchImpl = fetch) {
  const out = { ok: false, fetched: new Date().toISOString(), error: '', m365: null, azure: null, consumer: [] };
  try {
    const [mac, az, cons] = await Promise.all([get('mac', fetchImpl), get('azure', fetchImpl).catch(() => null), get('m365Consumer', fetchImpl).catch(() => [])]);
    const one = (p) => (p ? { title: clip(htmlToText(p.Title, 300), 300), status: String(p.Status || ''), authored: iso(p.AuthoredDateTime), updated: iso(p.LastUpdatedTime), ...slimPost(htmlToText(p.Message, 6000)), affected: postServices(p.Message), refs: postRefs(htmlToText(p.Message, 20000)) } : null);
    out.m365 = one(mac);
    out.azure = one(az);
    out.consumer = (Array.isArray(cons) ? cons : []).filter((c) => c.Status && c.Status !== 'Operational').slice(0, 10)
      .map((c) => ({ name: String(c.ServiceDisplayName || ''), status: String(c.Status), title: clip(htmlToText(c.Title, 300), 300), updated: iso(c.LastUpdatedTime), ...slimPost(htmlToText(c.Message, 6000)) }));
    out.ok = true;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 120);
  }
  return out;
}
