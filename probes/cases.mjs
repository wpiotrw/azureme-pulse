// Incident case files: one record per Microsoft incident seen in Service health.
// Each run adds new Microsoft updates and one point with the portal's own measurements.
// Closed cases move to history; the five most recent are kept.

export const MAX_CLOSED = 5;
export const MAX_POINTS = 2016; // 7 days at 5-minute cadence
export const TAIL_MIN = 60; // keep measuring this long after Microsoft closes the incident
const MAX_POSTS = 80;
const MAX_EVENTS = 60;

const isIncident = (i) => String(i.classification || '').toLowerCase() === 'incident';
const minutes = (iso) => Math.floor(Date.parse(iso) / 60000);

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// One point: [minute, bitmask of probes that answered correctly, median response time, regions not answering, bitmask of probes measured]
function point(sample, probes, regionsDown) {
  let mask = 0;
  let present = 0;
  const ms = [];
  probes.forEach((id, k) => {
    const v = sample.r?.[id];
    if (!v) return; // probe did not exist yet: no data, not a failure
    present += 2 ** k;
    if (v[0]) { mask += 2 ** k; ms.push(v[1]); }
  });
  return [sample.t, mask, median(ms), regionsDown, present];
}

function mergePosts(have, log) {
  const seen = new Set(have.map((p) => p.t));
  for (const p of log) if (p.t && !seen.has(p.t)) { have.push({ t: p.t, s: String(p.s || '').slice(0, 700) }); seen.add(p.t); }
  have.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  return have.slice(-MAX_POSTS);
}

function thin(pts) {
  if (pts.length <= MAX_POINTS) return pts;
  const half = Math.floor(pts.length / 2);
  return pts.slice(0, half).filter((_, k) => k % 2 === 0).concat(pts.slice(half));
}

export function updateCases(prevCases, next, now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  const cases = Array.isArray(prevCases?.cases) ? JSON.parse(JSON.stringify(prevCases.cases)) : [];
  const health = Array.isArray(next.health) ? next.health : [];
  const anyRead = health.some((h) => h.ok && !h.lastError);
  const samples = Array.isArray(next.samples) ? next.samples : [];
  const last = samples[samples.length - 1];
  const ids = (next.services || []).map((s) => s.id);
  const names = Object.fromEntries((next.services || []).map((s) => [s.id, `${s.name}: ${s.what}`]));
  const regionsDown = (next.regions?.list || []).filter((r) => !r.ok).length;

  // Issues classified as incidents, merged across tenants.
  const seen = new Map();
  for (const h of health) {
    for (const i of h.issues || []) {
      if (!isIncident(i)) continue;
      const e = seen.get(i.id) || { issue: i, tenants: [], open: false, log: [] };
      e.tenants.push(String(h.label).replace(/\s*\(.*$/, ''));
      if (!i.resolved) { e.open = true; e.issue = i; }
      if (Array.isArray(i.log) && i.log.length > e.log.length) e.log = i.log;
      seen.set(i.id, e);
    }
  }

  for (const [id, e] of seen) {
    const i = e.issue;
    let c = cases.find((x) => x.id === id);
    if (!c) {
      if (!e.open) continue; // already closed when first seen: nothing to follow
      c = { id, firstSeen: nowIso, probes: ids.slice(), probeNames: [], posts: [], pts: [], events: [] };
      const from = i.start ? minutes(i.start) - 60 : 0;
      c.pts = samples.filter((s) => s.t >= from && s !== last).map((s) => point(s, c.probes, 0));
      cases.push(c);
    }
    for (const pid of ids) if (!c.probes.includes(pid)) c.probes.push(pid);
    c.probeNames = c.probes.map((pid) => names[pid] || pid);
    c.title = i.title; c.service = i.service; c.feature = i.feature || ''; c.status = i.status;
    c.start = i.start || c.start || c.firstSeen; c.modified = i.modified || null; c.lastSeen = nowIso;
    c.tenants = [...new Set(e.tenants)].sort();
    if (Array.isArray(i.affected) && i.affected.length) c.affected = i.affected.map((a) => a.n).filter(Boolean).slice(0, 40);
    if (Array.isArray(i.refs) && i.refs.length) c.refs = i.refs.slice(0, 12);
    if (i.impact) c.impact = String(i.impact).slice(0, 500);
    c.posts = mergePosts(c.posts, e.log.length ? e.log : i.updateAt ? [{ t: i.updateAt, s: i.current || '' }] : []);
    c.postCount = Math.max(i.posts || 0, c.posts.length);
    if (e.open) { delete c.end; delete c.endAssumed; } else if (!c.end) { c.end = i.end || i.modified || nowIso; }
  }

  // Cases whose issue is no longer listed by any tenant.
  if (anyRead) for (const c of cases) if (!c.end && !seen.has(c.id)) { c.end = c.modified || c.lastSeen || nowIso; c.endAssumed = true; }

  // Own measurements and portal events for cases that are open or just closed.
  const fresh = (next.events || []).filter((ev) => ev.t === next.generated);
  for (const c of cases) {
    const live = !c.end || (last && last.t <= minutes(c.end) + TAIL_MIN);
    if (!live) continue;
    if (last && (!c.pts.length || c.pts[c.pts.length - 1][0] < last.t)) c.pts.push(point(last, c.probes, regionsDown));
    c.pts = thin(c.pts);
    if (fresh.length) c.events = [...fresh.map((ev) => ({ t: ev.t, sev: ev.sev, kind: ev.kind, title: ev.title })), ...(c.events || [])].slice(0, MAX_EVENTS);
  }

  const open = cases.filter((c) => !c.end).sort((a, b) => String(b.start).localeCompare(String(a.start)));
  const closed = cases.filter((c) => c.end).sort((a, b) => String(b.end).localeCompare(String(a.end))).slice(0, MAX_CLOSED);
  return { schema: 1, updated: nowIso, stepMin: next.stepMin || 5, cases: [...open, ...closed] };
}
