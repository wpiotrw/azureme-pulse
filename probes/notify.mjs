// AzureMe Pulse: e-mail notifications and a daily report.
// An e-mail is sent only for: a new Microsoft incident, a Microsoft update of an open incident, a closed incident,
// an outage detected by the portal's own HTTP probes (and its end), a large deviation of an external signal,
// and once a day the daily report. Everything else is visible in the portal's change log only.
// Configuration: env PULSE_NOTIFY = JSON { "to": ["address"], "tenant": "<label from PULSE_TENANTS>", "from": "<sender mailbox UPN>" }.
// Sending: Microsoft Graph sendMail with the same federated application (application permission Mail.Send in the sender's tenant).
// Addresses live only in the Actions secret; they are never written to the repository or to the public data file.
import { githubOidcToken, graphToken } from './health.mjs';

const SITE = 'https://pulse.azureme.pl/';
const DAILY_HOUR_UTC = 6;
const OK_STATUS = new Set(['serviceOperational', 'serviceRestored', 'postIncidentReviewPublished', 'falsePositive', 'resolved', 'mitigated', 'mitigatedExternal', 'resolvedExternal']);
const RANK = { ok: 0, warn: 1, crit: 2 };
const WORD = { ok: 'w dobrej kondycji', warn: 'obniżenie wydajności', crit: 'przerwa w świadczeniu usługi' };

export const statusClass = (s) => (OK_STATUS.has(s) ? 'ok' : s === 'serviceInterruption' ? 'crit' : 'warn');
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A probe counts as down only after two consecutive failed samples.
function isDown(st, id) {
  const s = (st.samples || []).slice(-2).map((x) => x.r?.[id]).filter(Boolean);
  return s.length === 2 && !s[0][0] && !s[1][0];
}
function healthMap(st) {
  const m = new Map();
  for (const h of st.health || []) {
    if (!h.ok) continue;
    for (const s of h.services || []) {
      const c = statusClass(s.status);
      if (!m.has(s.name) || RANK[c] > RANK[m.get(s.name)]) m.set(s.name, c);
    }
  }
  return m;
}
function openIssues(st) {
  const m = new Map();
  for (const h of st.health || []) if (h.ok) for (const i of h.issues || []) if (!i.resolved) m.set(i.id, i);
  return m;
}
function allIssues(st) {
  const m = new Map();
  for (const h of st.health || []) if (h.ok) for (const i of h.issues || []) m.set(i.id, i);
  return m;
}

export function diffEvents(prev, next) {
  const ev = [];
  const names = new Map((next.services || []).map((s) => [s.id, s]));
  for (const [id, s] of names) {
    const was = isDown(prev, id);
    const now = isDown(next, id);
    if (now && !was) ev.push({ sev: 'crit', kind: 'Sonda HTTP', title: `${s.name}: brak poprawnej odpowiedzi`, text: `${s.what}. Dwa kolejne pomiary nieudane, ostatni kod: ${s.last?.code || 'brak odpowiedzi'}.` });
    if (!now && was && s.last?.ok) ev.push({ sev: 'ok', kind: 'Sonda HTTP', title: `${s.name}: odpowiedź przywrócona`, text: `${s.what}. Ostatni pomiar poprawny, ${s.last.ms} ms.` });
  }
  const hadHealth = (prev.health || []).some((h) => h.ok);
  if (hadHealth) {
    const a = healthMap(prev);
    const b = healthMap(next);
    for (const [name, c] of b) {
      const p = a.get(name);
      if (p && p !== c) ev.push({ sev: c, kind: 'Service health', title: `${name}: ${WORD[c]}`, text: `Zmiana stanu deklarowanego przez Microsoft: ${WORD[p]} → ${WORD[c]}.` });
    }
    const pa = allIssues(prev);
    const po = openIssues(prev);
    const no = openIssues(next);
    const na = allIssues(next);
    const wasGone = new Set((prev.withdrawn || []).map((w) => w.id));
    for (const [id, i] of no) { const p = po.get(id); if (p && isIncident(p) !== isIncident(i)) ev.push({ sev: isIncident(i) ? 'crit' : 'ok', kind: 'Zmiana klasyfikacji', title: `${id}: ${i.title}`, text: isIncident(i) ? 'Microsoft zmienił klasyfikację zgłoszenia z porady na incydent.' : 'Microsoft zmienił klasyfikację zgłoszenia z incydentu na poradę.' }); }
    for (const [id, i] of no) if (!pa.has(id)) ev.push({ sev: statusClass(i.status) === 'crit' ? 'crit' : 'warn', kind: wasGone.has(id) ? 'Zgłoszenie przywrócone' : 'Nowe zgłoszenie', title: `${id}: ${i.title}`, text: `${i.service || ''}${i.current ? `. ${i.current}` : ''}` });
    for (const [id, i] of po) if (na.has(id) && na.get(id).resolved) ev.push({ sev: 'ok', kind: 'Zgłoszenie zamknięte', title: `${id}: ${i.title}`, text: i.service || '' });
    if ((next.health || []).length && (next.health || []).every((h) => h.ok && !h.lastError)) for (const [id, i] of po) if (!na.has(id)) ev.push({ sev: 'ok', kind: 'Zgłoszenie wycofane', title: `${id}: ${i.title}`, text: 'Microsoft usunął zgłoszenie z Service health bez wpisu o zamknięciu.' });
    const chk = (st) => new Map((st.health || []).filter((h) => h.ok).flatMap((h) => (h.checks || []).map((c) => [`${h.label}|${c.id}`, { ...c, label: h.label }])));
    const ca = chk(prev);
    for (const [k, c] of chk(next)) {
      const p = ca.get(k);
      if (!p) continue;
      if (p.state === 'ok' && c.state === 'fail') ev.push({ sev: 'crit', kind: 'Odczyt przez Graph', title: `${c.service}: sprawdzenie nieudane`, text: `${c.label}: ${c.name}, kod ${c.code || 'brak odpowiedzi'}.` });
      if (p.state === 'fail' && c.state === 'ok') ev.push({ sev: 'ok', kind: 'Odczyt przez Graph', title: `${c.service}: sprawdzenie ponownie poprawne`, text: `${c.label}: ${c.name}, ${c.ms} ms.` });
    }
  }
  if (prev.regions?.list && next.regions?.list) {
    const was = new Map(prev.regions.list.map((r) => [r.id, r.fails || 0]));
    for (const r of next.regions.list) {
      const p = was.get(r.id);
      if (p === undefined) continue;
      if (r.fails === 2) ev.push({ sev: 'crit', kind: 'Region Azure', title: `${r.name} (${r.city}): brak odpowiedzi`, text: `Regionalny punkt końcowy Azure Resource Manager nie odpowiedział poprawnie w dwóch kolejnych pomiarach, ostatni kod: ${r.code || 'brak odpowiedzi'}.` });
      if (r.ok && p >= 2) ev.push({ sev: 'ok', kind: 'Region Azure', title: `${r.name} (${r.city}): odpowiedź przywrócona`, text: `Ostatni pomiar poprawny, ${r.ms} ms.` });
    }
  }
  if (prev.azure?.ok && next.azure?.ok) {
    const seen = new Set(prev.azure.items.map((i) => i.link || i.title));
    for (const i of next.azure.items) if (!seen.has(i.link || i.title)) ev.push({ sev: 'warn', kind: 'Azure Status', title: i.title, text: i.summary });
  }
  return ev;
}

export function dailyDue(prev, now = Date.now()) {
  const d = new Date(now);
  const day = d.toISOString().slice(0, 10);
  return d.getUTCHours() >= DAILY_HOUR_UTC && prev.notify?.lastDaily !== day ? day : null;
}

function fdt(iso) {
  const x = new Date(iso);
  if (Number.isNaN(x.getTime())) return 'brak danych';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getUTCDate())}-${p(x.getUTCMonth() + 1)}-${x.getUTCFullYear()} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())} UTC`;
}

// Per-service metrics from the stored samples (last 24 h): availability, median response time, current state.
export function metrics(st, now = Date.now()) {
  const from = Math.floor(now / 60000) - 1440;
  const groups = new Map();
  for (const s of st.services || []) {
    const g = groups.get(s.name) || { name: s.name, ok: 0, total: 0, ms: [], down: 0, probes: 0 };
    g.probes += 1;
    if (!s.last?.ok) g.down += 1;
    for (const x of st.samples || []) {
      const v = x.r?.[s.id];
      if (!v || x.t < from) continue;
      g.total += 1;
      if (v[0]) { g.ok += 1; g.ms.push(v[1]); }
    }
    groups.set(s.name, g);
  }
  return [...groups.values()].map((g) => {
    g.ms.sort((a, b) => a - b);
    return { name: g.name, probes: g.probes, down: g.down, avail: g.total ? (g.ok / g.total) * 100 : null, median: g.ms.length ? g.ms[Math.floor(g.ms.length / 2)] : null, samples: g.total };
  });
}

const COL = { ok: '#15803d', warn: '#b45309', crit: '#b91c1c', info: '#1d4ed8', mute: '#64748b' };
const BG = { ok: '#ecfdf3', warn: '#fff7e6', crit: '#fef0f0', info: '#eef4ff' };
const HST = { serviceOperational: 'W dobrej kondycji', investigating: 'Badanie', restoringService: 'Przywracanie usługi', verifyingService: 'Weryfikacja przywrócenia usługi', serviceRestored: 'Usługa została przywrócona', postIncidentReviewPublished: 'Opublikowany raport po zdarzeniu', serviceDegradation: 'Obniżenie wydajności usługi', serviceInterruption: 'Przerwa w świadczeniu usługi', extendedRecovery: 'Przedłużone odzyskiwanie usługi', falsePositive: 'Wynik fałszywie dodatni', investigationSuspended: 'Wstrzymano badanie problemu', resolved: 'Problem rozwiązany', mitigated: 'Skutki problemu ograniczone', resolvedExternal: 'Problem rozwiązany przez dostawcę zewnętrznego', mitigatedExternal: 'Skutki ograniczone przez dostawcę zewnętrznego', confirmed: 'Problem potwierdzony', reported: 'Problem zgłoszony' };
const LINK = {
  portal: SITE,
  issues: `${SITE}#/incydenty`,
  analysis: `${SITE}#/model`,
  services: `${SITE}#/uslugi`,
  probes: `${SITE}#/pomiary`,
  messages: `${SITE}#/microsoft`,
  admin: (id) => `https://admin.microsoft.com/Adminportal/Home#/servicehealth/:/alerts/${encodeURIComponent(id)}`,
  mc: (id) => `https://admin.microsoft.com/Adminportal/Home#/MessageCenter/:/messages/${encodeURIComponent(id)}`,
  adminHealth: 'https://admin.microsoft.com/Adminportal/Home#/servicehealth',
  m365: 'https://status.cloud.microsoft',
  azure: 'https://azure.status.microsoft/status',
};
const PROBE_COOLDOWN_MIN = 180;
const SIGNAL_COOLDOWN_MIN = 360;
const isIncident = (i) => String(i.classification || '').toLowerCase() === 'incident';
const hstWord = (s) => HST[s] || s || 'brak danych';

// Issues merged across tenants: one entry per identifier, with the list of tenants that show it.
export function issuesById(st) {
  const m = new Map();
  for (const h of st.health || []) {
    if (!h.ok) continue;
    const label = String(h.label || '').replace(/\s*\(.*$/, '');
    for (const i of h.issues || []) {
      const e = m.get(i.id);
      if (!e) { m.set(i.id, { ...i, tenants: [label] }); continue; }
      e.tenants.push(label);
      if (!i.resolved && e.resolved) Object.assign(e, i, { tenants: e.tenants });
      else if (String(i.updateAt || '') > String(e.updateAt || '')) Object.assign(e, i, { tenants: e.tenants, resolved: e.resolved && i.resolved });
    }
  }
  return m;
}

// Events that justify an e-mail. `state` is the stored notify state (cooldown keys); it is updated in place.
export function mailEvents(prev, next, state = {}, now = Date.now(), cfg = {}) {
  const ev = [];
  const nowMin = Math.floor(now / 60000);
  const sent = state.sent && typeof state.sent === 'object' ? state.sent : {};
  for (const k of Object.keys(sent)) if (nowMin - sent[k] > 2880) delete sent[k];
  const cool = (key, minutes) => { if (sent[key] !== undefined && nowMin - sent[key] < minutes) return false; sent[key] = nowMin; return true; };

  if ((prev.health || []).some((h) => h.ok) && (next.health || []).some((h) => h.ok && !h.lastError)) {
    const a = issuesById(prev);
    const b = issuesById(next);
    for (const [id, i] of b) {
      const p = a.get(id);
      const inc = isIncident(i);
      if (!inc && p && isIncident(p) && !p.resolved && !i.resolved) { ev.push({ type: 'downgraded', sev: 'ok', issue: i, prev: p }); continue; }
      if (!inc && !(cfg.advisories === true && !p && !i.resolved)) continue;
      if (!p) {
        if (i.resolved) continue;
        const r = inc ? (next.restored || []).find((x) => x.id === id && !(prev.restored || []).some((y) => y.id === id)) : null;
        ev.push(r ? { type: 'restored', sev: 'crit', issue: i, gone: r.gone, last: r.last } : { type: 'new', sev: inc ? 'crit' : 'warn', issue: i });
        continue;
      }
      if (inc && !isIncident(p) && !i.resolved) { ev.push({ type: 'new', sev: 'crit', issue: i, prev: p, reclass: true }); continue; }
      if (!p.resolved && i.resolved) { ev.push({ type: 'closed', sev: 'ok', issue: i }); continue; }
      if (i.resolved) continue;
      if (p.resolved) { ev.push({ type: 'new', sev: 'crit', issue: i, reopened: true }); continue; }
      if (String(i.updateAt || '') > String(p.updateAt || '') || i.status !== p.status) ev.push({ type: 'update', sev: statusClass(i.status) === 'crit' ? 'crit' : 'warn', issue: i, prev: p, prevStatus: p.status !== i.status ? p.status : null });
    }
  }
  // An open incident that disappears from Service health without being marked resolved: Microsoft withdrew it.
  // Reported after two consecutive complete readings without it, so a single incomplete answer does not send a message.
  const pend = state.pending && typeof state.pending === 'object' ? state.pending : {};
  if ((prev.health || []).some((h) => h.ok) && (next.health || []).some((h) => h.ok)) {
    const a = issuesById(prev);
    const b = issuesById(next);
    const clean = (next.health || []).every((h) => h.ok && !h.lastError);
    for (const [id, p] of a) if (!b.has(id) && isIncident(p) && !p.resolved && !pend[id]) pend[id] = { n: 0, issue: { id, title: p.title, service: p.service, status: p.status, classification: p.classification, start: p.start, updateAt: p.updateAt || p.modified, tenants: p.tenants } };
    for (const id of Object.keys(pend)) {
      if (b.has(id)) { delete pend[id]; continue; }
      if (!clean) continue;
      pend[id].n += 1;
      if (pend[id].n >= 2) { ev.push({ type: 'withdrawn', sev: 'ok', issue: pend[id].issue }); delete pend[id]; }
    }
  }
  if (Object.keys(pend).length) state.pending = pend; else delete state.pending;
  for (const s of next.services || []) {
    const was = isDown(prev, s.id);
    const is = isDown(next, s.id);
    const key = `probe:${s.id}`;
    if (is && !was && cool(key, PROBE_COOLDOWN_MIN)) ev.push({ type: 'probe-down', sev: 'crit', probe: s });
    if (!is && was && s.last?.ok && sent[key] !== undefined) ev.push({ type: 'probe-up', sev: 'ok', probe: s });
  }
  const SIG = { atlas: 'Osiągalność www.office.com z sond RIPE Atlas', bgp: 'Trasy BGP sieci Microsoft (AS8075)', radar: 'Ruch sieci Microsoft w Cloudflare Radar' };
  for (const k of Object.keys(SIG)) {
    const p = prev.signals?.[k]?.state;
    const c = next.signals?.[k];
    if (c?.ok && c.state === 'crit' && p && p !== 'crit' && cool(`signal:${k}`, SIGNAL_COOLDOWN_MIN)) ev.push({ type: 'signal', sev: 'crit', name: SIG[k], signal: c });
  }
  for (const e of ev) if (e.issue) { const k = `mail:${e.issue.id}`; if (sent[k] !== undefined) e.lastMailMin = nowMin - sent[k]; sent[k] = nowMin; }
  state.sent = sent;
  return ev;
}

function warsaw(iso) {
  try { return new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch { return ''; }
}
const both = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? `${fdt(iso)} (${warsaw(iso)} czasu polskiego)` : 'brak danych');
const cut = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };

// Incidents that were withdrawn (prev.withdrawn) and are listed again as open incidents: kept while they stay open, at most `days`.
export function trackRestored(prev, next, now = Date.now(), days = 7) {
  const since = new Date(now - days * 86400000).toISOString();
  const openInc = new Set((next.health || []).flatMap((h) => (h.issues || []).filter((i) => isIncident(i) && !i.resolved).map((i) => i.id)));
  const kept = (Array.isArray(prev.restored) ? prev.restored : []).filter((r) => openInc.has(r.id) && String(r.back) > since);
  const fresh = (Array.isArray(prev.withdrawn) ? prev.withdrawn : []).filter((w) => openInc.has(w.id) && !kept.some((r) => r.id === w.id))
    .map((w) => ({ id: w.id, gone: w.gone || w.last || null, last: w.last || null, back: new Date(now).toISOString() }));
  return [...kept, ...fresh];
}

export function summary(st, now = Date.now()) {
  const back = new Map((Array.isArray(st.restored) ? st.restored : []).map((r) => [r.id, r]));
  const all = [...issuesById(st).values()].map((i) => (back.has(i.id) ? { ...i, restoredAt: back.get(i.id).back, goneAt: back.get(i.id).gone } : i));
  const open = all.filter((i) => !i.resolved).sort((x, y) => (isIncident(y) - isIncident(x)) || String(y.updateAt || '').localeCompare(String(x.updateAt || '')));
  const m = metrics(st, now);
  const probesAll = m.reduce((n, g) => n + g.probes, 0);
  const probesDown = m.reduce((n, g) => n + g.down, 0);
  const regions = st.regions?.list || [];
  return {
    open, incidents: open.filter(isIncident), advisories: open.filter((i) => !isIncident(i)),
    closed: all.filter((i) => i.resolved && isIncident(i)).sort((x, y) => String(y.updateAt || y.modified || '').localeCompare(String(x.updateAt || x.modified || ''))),
    m, probesAll, probesDown, regionsAll: regions.length, regionsDown: regions.filter((r) => !r.ok).length,
    healthRead: (st.health || []).some((h) => h.ok),
  };
}

const span = (min) => (min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} godz.${min % 60 ? ` ${min % 60} min` : ''}` : Math.floor(min / 1440) === 1 ? `1 dzień${Math.floor((min % 1440) / 60) ? ` ${Math.floor((min % 1440) / 60)} godz.` : ''}` : `${Math.floor(min / 1440)} dni${Math.floor(min / 1440) < 7 && Math.floor((min % 1440) / 60) ? ` ${Math.floor((min % 1440) / 60)} godz.` : ''}`);
const sameText = (a, b) => String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();

// Why a message is sent: one lead sentence and the list of things that differ from the previous reading.
export function whyEvent(e) {
  const out = { lead: '', items: [] };
  const i = e.issue;
  if (i) {
    const p = e.prev;
    if (e.type === 'new') {
      out.lead = e.reclass ? 'Microsoft zmienił klasyfikację zgłoszenia z porady na incydent.' : e.reopened ? 'Microsoft ponownie otworzył zamknięty incydent.' : isIncident(i) ? 'Microsoft otworzył nowy incydent.' : 'Microsoft opublikował nową poradę.';
      out.items.push(['Stan według Microsoft', hstWord(i.status)]);
      if (e.reclass && p && String(i.updateAt || '') > String(p.updateAt || '')) out.items.push(['Nowy wpis Microsoft', both(i.updateAt)]);
    } else if (e.type === 'restored') {
      out.lead = 'Microsoft przywrócił incydent w Service health. Zgłoszenie było wcześniej wycofane bez wpisu o zamknięciu.';
      out.items.push(['Stan według Microsoft', hstWord(i.status)]);
      if (e.gone) out.items.push(['Niewidoczne w odczycie od', both(e.gone)]);
      out.items.push(['Ostatni wpis Microsoft', both(i.updateAt)]);
      if (i.current) out.items.push(['Treść ostatniego wpisu', cut(i.current, 600)]);
    } else if (e.type === 'downgraded') {
      out.lead = 'Microsoft zmienił klasyfikację zgłoszenia z incydentu na poradę. Zgłoszenie pozostaje otwarte.';
      out.items.push(['Stan według Microsoft', hstWord(i.status)]);
      out.items.push(['Znaczenie', 'Według Microsoft problem ma ograniczony zasięg. Portal nie liczy go już jako incydentu.']);
    } else if (e.type === 'withdrawn') {
      out.lead = 'Microsoft usunął incydent z Service health tenantów bez wpisu o zamknięciu.';
      out.items.push(['Ostatni znany stan', hstWord(i.status)]);
      out.items.push(['Ostatni wpis Microsoft', both(i.updateAt)]);
      out.items.push(['Znaczenie', 'Zgłoszenie nie jest już widoczne w żadnym tenancie testowym. Microsoft nie opublikował komunikatu końcowego.']);
    } else if (e.type === 'closed') {
      out.lead = 'Microsoft zamknął incydent.';
      out.items.push(['Stan według Microsoft', hstWord(i.status)]);
      const a = Date.parse(i.start); const b = Date.parse(i.end || i.updateAt || i.modified);
      if (!Number.isNaN(a) && !Number.isNaN(b) && b > a) out.items.push(['Czas trwania', span(Math.round((b - a) / 60000))]);
    } else {
      const newer = p && String(i.updateAt || '') > String(p.updateAt || '');
      const text = p && !sameText(i.current, p.current);
      out.lead = e.prevStatus && !newer ? 'Microsoft zmienił stan zgłoszenia.' : text || !p ? 'Microsoft opublikował nowy wpis w zgłoszeniu.' : 'Microsoft odświeżył zgłoszenie; treść ostatniego wpisu jest taka sama.';
      if (e.prevStatus) out.items.push(['Stan według Microsoft', `${hstWord(e.prevStatus)} → ${hstWord(i.status)}`]);
      if (newer) out.items.push(['Czas wpisu', `${both(i.updateAt)}; poprzedni wpis: ${both(p.updateAt)}`]);
      if (p && !sameText(i.title, p.title)) out.items.push(['Nowy tytuł', cut(i.title, 160)]);
      if (p && String(i.next || '') !== String(p.next || '') && i.next && !Number.isNaN(Date.parse(i.next))) out.items.push(['Następna aktualizacja', both(i.next)]);
      if (p && !sameText(i.impact, p.impact) && i.impact) out.items.push(['Zmieniony opis wpływu', cut(i.impact, 300)]);
      if (p && (i.tenants || []).length !== (p.tenants || []).length) out.items.push(['Widoczne w', `${(i.tenants || []).join(', ')} (poprzednio: ${(p.tenants || []).join(', ') || 'brak'})`]);
      if (text && i.current) out.items.push(['Treść nowego wpisu', cut(i.current, 600)]);
    }
    if (e.lastMailMin !== undefined) out.items.push(['Poprzednia wiadomość o tym zgłoszeniu', `${span(e.lastMailMin)} temu`]);
    return out;
  }
  if (e.probe) {
    out.lead = e.type === 'probe-down' ? 'Sonda portalu nie otrzymała odpowiedzi w dwóch kolejnych pomiarach.' : 'Sonda portalu ponownie otrzymuje odpowiedź.';
    out.items.push(['Sonda', `${e.probe.name}: ${e.probe.what}`]);
    return out;
  }
  out.lead = 'Sygnał zewnętrzny przeszedł w stan dużego odchylenia.';
  out.items.push(['Sygnał', e.name]);
  return out;
}

const KIND = { new: 'Nowy incydent Microsoft', update: 'Aktualizacja Microsoft', closed: 'Incydent zamknięty przez Microsoft', withdrawn: 'Incydent wycofany przez Microsoft', restored: 'Incydent przywrócony przez Microsoft', downgraded: 'Incydent przeklasyfikowany na poradę', 'probe-down': 'Awaria wykryta przez sondę portalu', 'probe-up': 'Sonda portalu: odpowiedź przywrócona', signal: 'Sygnał zewnętrzny: duże odchylenie' };

function eventSubject(e) {
  if (e.issue) {
    const what = e.type === 'new' ? (isIncident(e.issue) ? (e.reclass ? 'Porada Microsoft przeklasyfikowana na incydent' : e.reopened ? 'Incydent Microsoft otwarty ponownie' : 'Nowy incydent Microsoft') : 'Nowa porada Microsoft') : e.type === 'closed' ? 'Incydent zamknięty' : e.type === 'withdrawn' ? 'Incydent wycofany z Service health' : e.type === 'restored' ? 'Incydent przywrócony w Service health' : e.type === 'downgraded' ? 'Incydent przeklasyfikowany na poradę' : 'Aktualizacja Microsoft';
    return `${what} ${e.issue.id}: ${cut(`${e.issue.service ? `${e.issue.service} – ` : ''}${e.issue.title}`, 90)}`;
  }
  if (e.probe) return e.type === 'probe-down' ? `Sonda portalu: ${e.probe.name} nie odpowiada` : `Sonda portalu: ${e.probe.name} odpowiada ponownie`;
  return `Sygnał zewnętrzny: ${e.name}, duże odchylenie`;
}

export function buildMail(st, events, daily, now = Date.now()) {
  const S = summary(st, now);
  const worst = events.some((e) => e.sev === 'crit') || S.probesDown || S.incidents.length ? 'crit' : S.advisories.length || events.some((e) => e.sev === 'warn') ? 'warn' : 'ok';
  const headline = S.incidents.length ? `Aktywne incydenty Microsoft: ${S.incidents.length}` : S.probesDown ? 'Sondy portalu wykrywają brak odpowiedzi' : S.advisories.length ? `Brak aktywnych incydentów. Aktywne porady: ${S.advisories.length}` : S.healthRead ? 'Brak aktywnych incydentów i porad' : 'Brak odczytu Microsoft Service health';
  const counts = `incydenty ${S.incidents.length}, porady ${S.advisories.length}, sondy ${S.probesAll - S.probesDown} z ${S.probesAll}`;
  const subject = events.length
    ? `[AzureMe Pulse] ${eventSubject(events[0])}${events.length > 1 ? ` (+${events.length - 1})` : ''}`
    : `[AzureMe Pulse] Raport dobowy ${daily.split('-').reverse().join('-')}: ${counts}`;
  const nowIso = new Date(now).toISOString();
  const F = 'font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif';
  const a = (href, text, extra = '') => `<a href="${esc(href)}" style="color:#0b63ce;text-decoration:underline;${extra}">${esc(text)}</a>`;
  const dot = (c) => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${COL[c]};margin-right:7px"></span>`;
  const chip = (text, c) => `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${BG[c]};color:${COL[c]};font-size:12px;font-weight:700;white-space:nowrap">${esc(text)}</span>`;
  // Section heading; a trailing "(N)" becomes a rounded counter tile on the left, as in the portal.
  const h2 = (t) => { const m = /^(.*) \((\d+)\)$/.exec(t); return `<tr><td style="padding:28px 24px 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${m ? `<td width="46" valign="middle"><div style="width:34px;height:34px;line-height:34px;border-radius:10px;text-align:center;font-size:17px;font-weight:700;background:#0b63ce;color:#ffffff">${m[2]}</div></td><td valign="middle" style="font-size:19px;font-weight:700;color:#0f1b2d;line-height:1.3">${esc(m[1])}</td>` : `<td valign="middle" style="border-left:5px solid #0b63ce;padding:4px 0 4px 12px;font-size:19px;font-weight:700;color:#0f1b2d;line-height:1.3">${esc(t)}</td>`}</tr></table></td></tr>`; };
  const tile = (v, k, c, href) => `<td width="50%" valign="top" style="padding:5px"><a href="${esc(href)}" style="text-decoration:none"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #b4bfce;border-top:3px solid ${COL[c]};border-radius:8px"><tr><td style="padding:11px 14px"><div style="font-size:24px;line-height:1.15;font-weight:700;color:${COL[c]};white-space:nowrap">${esc(v)}</div><div style="font-size:13px;color:#475569;margin-top:2px">${esc(k)}</div></td></tr></table></a></td>`;
  const links = (list) => `<div style="margin-top:10px;font-size:13px;line-height:1.9">${list.map(([href, text]) => a(href, text)).join(' &nbsp;·&nbsp; ')}</div>`;
  const fact = (k, v) => (v ? `<div style="font-size:13px;color:#334155;margin-top:3px;overflow-wrap:anywhere;word-break:break-word"><span style="color:#64748b">${esc(k)}:</span> ${v}</div>` : '');
  const issueLinks = (i) => links([[LINK.issues, 'Zgłoszenie w portalu'], ...(isIncident(i) ? [[LINK.analysis, 'Karta analizy incydentu']] : []), [LINK.admin(i.id), 'Centrum administracyjne Microsoft 365'], [LINK.m365, 'Publiczna strona stanu usług']]);
  // Report card: the same layout as the portal details (tiles, framed Microsoft text split into points, reach, buttons).
  const sents = (t) => { const m = String(t || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || []; const out = []; for (let x of m) { x = x.trim(); if (!x) continue; if (out.length && (/\b(e\.g|i\.e|etc|vs|approx|incl)\.$/i.test(out[out.length - 1]) || x.length < 12)) out[out.length - 1] += ` ${x}`; else out.push(x); } return out; };
  const points = (t) => { const l = sents(t); return l.length > 1 ? `<ul style="margin:0;padding:0 0 0 18px">${l.map((x) => `<li style="font-size:13.5px;line-height:1.5;color:#1f2937;margin:0 0 5px">${esc(x)}</li>`).join('')}</ul>` : `<div style="font-size:13.5px;line-height:1.5;color:#1f2937">${esc(l[0] || '')}</div>`; };
  const box = (title, sub, inner) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border:1px solid #b4bfce;border-radius:10px;background:#f8fafc"><tr><td style="padding:11px 14px 12px"><div style="font-size:13.5px;font-weight:700;color:#0f1b2d;margin-bottom:6px">${esc(title)}${sub ? ` <span style="font-weight:400;font-size:12px;color:#64748b">${esc(sub)}</span>` : ''}</div>${inner}</td></tr></table>`;
  const cell = (label, value, sub, c) => `<td width="50%" valign="top" style="padding:4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${c ? COL[c] : '#b4bfce'};border-radius:10px"><tr><td style="padding:9px 12px"><div style="font-size:12px;color:#64748b;line-height:1.3">${esc(label)}</div><div style="font-size:15px;font-weight:700;color:${c ? COL[c] : '#0f1b2d'};line-height:1.3;margin-top:2px">${esc(value)}</div>${sub ? `<div style="font-size:12px;color:#64748b;line-height:1.35;margin-top:2px">${esc(sub)}</div>` : ''}</td></tr></table></td>`;
  const sinceTxt = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 'brak danych' : `${span(Math.max(0, Math.round((now - t) / 60000)))} temu`; };
  const buttons = (list) => { let r = ''; for (let k = 0; k < list.length; k += 2) r += `<tr>${list.slice(k, k + 2).map(([href, text]) => `<td width="50%" valign="top" style="padding:4px"><a href="${esc(href)}" style="display:block;border:1px solid #b9cdf3;border-radius:9px;padding:10px 8px;text-align:center;font-size:13px;font-weight:700;color:#0b63ce;text-decoration:none;line-height:1.3">${esc(text)}</a></td>`).join('')}${list.length - k === 1 ? '<td width="50%"></td>' : ''}</tr>`; return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">${r}</table>`; };
  const issueCard = (i, kind, c, full, no) => {
    const upT = i.updateAt || i.modified; const t0 = Date.parse(i.start); const t1 = i.resolved ? Date.parse(i.end || upT) : now;
    const dur = !Number.isNaN(t0) && t1 > t0 ? span(Math.round((t1 - t0) / 60000)) : 'brak danych';
    const nx = !i.resolved && i.next && !Number.isNaN(Date.parse(i.next)) ? Date.parse(i.next) : NaN; const late = !Number.isNaN(nx) && nx < now;
    const stC = i.resolved ? 'ok' : statusClass(i.status) === 'crit' ? 'crit' : 'warn';
    return `<tr><td style="padding:6px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #b4bfce;border-left:5px solid ${COL[c]};border-radius:14px"><tr><td style="padding:14px 12px 12px 14px">`
      + (kind ? `<div style="font-size:12.5px;font-weight:700;color:${COL[c]};padding:0 4px 4px">${esc(kind)}</div>` : '')
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${no ? `<td width="40" valign="top" style="padding:0 0 0 4px"><div style="width:30px;height:30px;line-height:30px;border-radius:9px;text-align:center;font-size:15px;font-weight:700;background:${BG[c]};color:${COL[c]}">${no}</div></td>` : ''}<td valign="middle" style="font-size:16px;font-weight:700;color:#0f1b2d;line-height:1.35;padding:0 4px">${esc(i.title)}</td></tr></table>`
      + `<div style="padding:7px 4px 6px">${chip(isIncident(i) ? 'Incydent' : 'Porada', isIncident(i) ? 'crit' : 'warn')} &nbsp;<a href="${esc(LINK.admin(i.id))}" style="font-size:14px;font-weight:700;color:#0b63ce">${esc(i.id)}</a>${i.service ? ` &nbsp;<span style="font-size:13px;color:#64748b">${esc(i.service)}</span>` : ''}</div>`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cell('Stan według Microsoft', i.resolved ? 'Zamknięte' : hstWord(i.status), i.resolved ? hstWord(i.status) : '', stC)}${cell(i.resolved ? 'Czas trwania' : 'Trwa', dur, i.start ? `od ${both(i.start)}` : '', '')}</tr><tr>${cell(i.resolved ? 'Zamknięty przez Microsoft' : 'Ostatni wpis Microsoft', sinceTxt(upT), both(upT), '')}${i.resolved ? cell('Koniec wpływu na użytkowników', i.end ? both(i.end) : 'nie podano', '', '') : cell('Następna aktualizacja', Number.isNaN(nx) ? 'nie podano' : late ? 'termin minął' : `za ${span(Math.round((nx - now) / 60000))}`, Number.isNaN(nx) ? '' : both(i.next), late ? 'warn' : '')}</tr></table>`
      + `<div style="padding:0 4px">`
      + (full && i.impact ? box('Wpływ na użytkowników', '', points(cut(i.impact, 600))) : '')
      + (full && i.current ? box(i.resolved ? 'Komunikat końcowy Microsoft' : 'Bieżący stan', 'ostatni wpis Microsoft, w skrócie', points(cut(i.current, 900))) : '')
      + (full && i.scope ? box('Zakres', '', points(cut(i.scope, 500))) : '')
      + ((i.tenants || []).length || i.restoredAt ? box('Zasięg', '', ((i.tenants || []).length ? `<div style="font-size:12.5px;color:#64748b;margin-bottom:6px">Service health, wykryto w tenantach:</div><div>${(i.tenants || []).map((x) => `<span style="display:inline-block;border:1px solid #cbd5e1;border-radius:999px;padding:2px 10px;margin:0 5px 5px 0;font-size:12.5px;color:#0f1b2d;background:#ffffff;white-space:nowrap">${esc(x)}</span>`).join('')}</div>` : '') + (i.restoredAt ? `<div style="font-size:13px;color:#334155;line-height:1.5;margin-top:4px">Przywrócony przez Microsoft ${esc(both(i.restoredAt))}${i.goneAt ? `; wcześniej niewidoczny w odczycie od ${esc(both(i.goneAt))}` : ''}.</div>` : '')) : '')
      + (full && Array.isArray(i.affected) && i.affected.length ? box('Usługi objęte zgłoszeniem', `(${i.affected.length})`, `<div style="font-size:13px;color:#334155;line-height:1.5">${esc(i.affected.map((x) => x.n).filter(Boolean).slice(0, 14).join(', '))}</div>`) : '')
      + `</div>` + buttons([[LINK.issues, 'Zgłoszenie w portalu'], ...(isIncident(i) ? [[LINK.analysis, 'Karta analizy']] : []), [LINK.admin(i.id), 'Centrum administracyjne'], [LINK.m365, 'Publiczna strona stanu usług']])
      + `</td></tr></table></td></tr>`;
  };

  let h = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head><body style="margin:0;padding:0;background:#f1f4f9;${F};color:#1f2937">`;
  h += `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(`${headline}. Porady: ${S.advisories.length}. Sondy portalu: ${S.probesAll - S.probesDown} z ${S.probesAll} odpowiada.`)}</div>`;
  h += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f4f9"><tr><td align="center" style="padding:18px 10px"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;table-layout:fixed;background:#ffffff;border:1px solid #b4bfce;border-top:5px solid ${COL[worst]};border-radius:12px">`;
  h += `<tr><td style="padding:20px 24px 4px"><div style="font-size:12px;letter-spacing:.14em;font-weight:700;color:#0b63ce">AZUREME PULSE</div><div style="font-size:22px;font-weight:700;color:#0f1b2d;margin-top:4px;line-height:1.25">${esc(events.length ? KIND[events[0].type] : 'Raport dobowy')}</div><div style="font-size:13px;color:#64748b;margin-top:3px">${esc(both(nowIso))}</div></td></tr>`;
  let evNo = 0;
  let whyBox = '';
  if (events.length) {
    let w = '';
    for (const e of events.slice(0, 8)) {
      const y = whyEvent(e);
      const who = e.issue ? `${e.issue.id}${e.issue.service ? `, ${e.issue.service}` : ''}` : e.probe ? e.probe.name : e.name;
      w += `<div style="margin-top:10px"><div style="font-size:15px;font-weight:700;color:#0f1b2d;line-height:1.35">${esc(who)}: ${esc(y.lead)}</div>`
        + y.items.map(([k, v]) => `<div style="font-size:13.5px;color:#334155;margin-top:5px;line-height:1.45;overflow-wrap:anywhere;word-break:break-word"><span style="color:#64748b">${esc(k)}:</span> ${esc(v)}</div>`).join('') + `</div>`;
    }
    whyBox = `<tr><td style="padding:14px 24px 2px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4ff;border:1px solid #c7d7f5;border-radius:14px"><tr><td style="padding:14px 16px 16px"><div style="font-size:16px;font-weight:700;color:#1d4ed8">Powód powiadomienia${events.length > 1 ? ` (liczba zmian: ${events.length})` : ''}</div>${w}</td></tr></table></td></tr>`;
  }
  h += whyBox;
  // State at the moment of sending, one row per source: tenants (Service health), public status pages, Azure subscriptions, own probes.
  const few = (n, one, some, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? some : many);
  const tenantsRead = (st.health || []).filter((x) => x.ok).length;
  const reach = (i) => { const n = (i.tenants || []).length; return !tenantsRead || !n ? '' : n >= tenantsRead ? `wykryto we wszystkich tenantach (${tenantsRead})` : `wykryto w ${n} z ${tenantsRead} tenantów`; };
  const nI = S.incidents.length; const nA = S.advisories.length;
  const shTxt = !S.healthRead ? 'brak odczytu' : `${nI ? `${nI} ${few(nI, 'incydent', 'incydenty', 'incydentów')}${nI === 1 && reach(S.incidents[0]) ? `, ${reach(S.incidents[0])}` : ''}` : 'brak incydentów'}; ${nA ? `${nA} ${few(nA, 'porada', 'porady', 'porad')}` : 'brak porad'}`;
  const pubRead = !!(st.public && st.public.ok);
  const pubN = pubRead ? ((st.public.m365 && st.public.m365.status && st.public.m365.status !== 'Available' ? 1 : 0) + (st.azure && st.azure.ok && Array.isArray(st.azure.items) ? st.azure.items.length : 0)) : 0;
  const pubTxt = !pubRead ? 'brak odczytu' : pubN ? `${pubN} ${few(pubN, 'zgłoszenie', 'zgłoszenia', 'zgłoszeń')}` : 'brak incydentów';
  const azh = st.azureHealth || {}; const azN = (azh.items || []).filter((x) => x.active).length; const azSubs = azh.subs || 0;
  const azTxt = !azh.ok ? 'brak odczytu' : !azSubs ? 'brak subskrypcji w odczycie' : azN ? `${azN} ${few(azN, 'aktywny problem', 'aktywne problemy', 'aktywnych problemów')}` : `brak aktywnych problemów (subskrypcje: ${azSubs})`;
  const row = (label, note, value, c) => `<tr><td style="padding:0 24px 9px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #b4bfce;border-left:5px solid ${COL[c]};border-radius:12px;background:#f8fafc"><tr><td style="padding:11px 14px 12px"><div style="font-size:14px;font-weight:700;color:#0f1b2d;line-height:1.35">${esc(label)}</div>${note ? `<div style="font-size:12.5px;color:#64748b;line-height:1.35;margin-top:1px">${esc(note)}</div>` : ''}<div style="font-size:16px;font-weight:700;color:${COL[c]};line-height:1.4;margin-top:5px">${dot(c)}${esc(value)}</div></td></tr></table></td></tr>`;
  h += h2('Stan według źródeł w chwili wysyłki')
    + row('Service health w tenantach testowych', 'widok administratora tenanta', shTxt, !S.healthRead ? 'mute' : nI ? 'crit' : nA ? 'warn' : 'ok')
    + row('Publiczne strony stanu usług Microsoft', 'status.cloud.microsoft i azure.status.microsoft', pubTxt, !pubRead ? 'mute' : pubN ? 'crit' : 'ok')
    + row('Azure Service Health w subskrypcjach', '', azTxt, !azh.ok || !azSubs ? 'mute' : azN ? 'crit' : 'ok')
    + row('Sondy HTTP portalu', '', `${S.probesAll - S.probesDown} z ${S.probesAll} odpowiada`, S.probesDown ? 'crit' : 'ok')
    + row('Regiony Azure', 'pomiar własny', S.regionsAll ? `${S.regionsAll - S.regionsDown} z ${S.regionsAll} odpowiada` : 'brak odczytu', !S.regionsAll ? 'mute' : S.regionsDown ? 'warn' : 'ok')
    + (pubRead && !pubN && nI ? `<tr><td style="padding:0 24px;font-size:12.5px;color:#64748b;line-height:1.5">Publiczna strona stanu usług Microsoft 365 pokazuje tylko awarie, które odcinają dostęp do centrum administracyjnego. Dlatego incydent widoczny w Service health tenanta może na niej nie występować.</td></tr>` : '');

  if (events.length) {
    h += h2(events.length > 1 ? `Zgłoszenia, których dotyczy wiadomość (${events.length})` : 'Zgłoszenie, którego dotyczy wiadomość');
    for (const e of events.slice(0, 8)) {
      if (e.issue) {
        const kind = e.type === 'new' ? (isIncident(e.issue) ? (e.reclass ? 'Porada przeklasyfikowana na incydent' : e.reopened ? 'Incydent otwarty ponownie' : 'Nowy incydent') : 'Nowa porada') : e.type === 'closed' ? 'Incydent zamknięty' : e.type === 'withdrawn' ? 'Incydent wycofany z Service health' : e.type === 'restored' ? 'Incydent przywrócony w Service health' : e.type === 'downgraded' ? 'Incydent przeklasyfikowany na poradę' : `Aktualizacja Microsoft${e.prevStatus ? `: ${hstWord(e.prevStatus)} → ${hstWord(e.issue.status)}` : ''}`;
        h += issueCard(e.issue, kind, e.sev, true, events.filter((x) => x.issue).length > 1 ? ++evNo : 0);
      } else if (e.probe) {
        h += `<tr><td style="padding:6px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #b4bfce;border-left:4px solid ${COL[e.sev]};border-radius:8px"><tr><td style="padding:13px 16px"><div style="font-size:11px;font-weight:700;color:${COL[e.sev]}">${esc(KIND[e.type])}</div><div style="font-size:15px;font-weight:600;color:#0f1b2d;margin-top:5px">${esc(`${e.probe.name}: ${e.probe.what}`)}</div>${fact('Wynik', esc(e.type === 'probe-down' ? `dwa kolejne nieudane pomiary, ostatni kod odpowiedzi: ${e.probe.last?.code || 'brak odpowiedzi'}` : `ostatni pomiar poprawny, ${e.probe.last?.ms} ms`))}${fact('Sprawdzany adres', esc(e.probe.url || ''))}${fact('Zastrzeżenie', 'pomiar z jednej lokalizacji (GitHub Actions); brak odpowiedzi nie przesądza o awarii usługi')}${links([[LINK.probes, 'Sondy HTTP w portalu'], [`${SITE}#/sygnaly`, 'Panel sygnalizacyjny'], [LINK.m365, 'Publiczna strona stanu usług']])}</td></tr></table></td></tr>`;
      } else {
        h += `<tr><td style="padding:6px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #b4bfce;border-left:4px solid ${COL.crit};border-radius:8px"><tr><td style="padding:13px 16px"><div style="font-size:11px;font-weight:700;color:${COL.crit}">${esc(KIND.signal)}</div><div style="font-size:15px;font-weight:600;color:#0f1b2d;margin-top:5px">${esc(e.name)}</div>${fact('Źródło', esc(e.signal.source || ''))}${links([[LINK.analysis, 'Sygnały zewnętrzne w portalu']])}</td></tr></table></td></tr>`;
      }
    }
    if (events.length > 8) h += `<tr><td style="padding:6px 24px;font-size:13px;color:#475569">Pozostałe zmiany: ${events.length - 8}. Pełna lista: ${a(LINK.portal, 'dziennik zmian w portalu')}.</td></tr>`;
  }

  const shown = new Set(events.filter((e) => e.issue).map((e) => e.issue.id));
  const rest = S.open.filter((i) => !shown.has(i.id));
  if (rest.length) {
    h += h2(shown.size ? `Pozostałe otwarte zgłoszenia Microsoft (${rest.length})` : `Otwarte zgłoszenia Microsoft (${rest.length})`);
    rest.slice(0, 10).forEach((i, k) => { h += issueCard(i, '', isIncident(i) ? 'crit' : 'warn', false, k + 1); });
    if (rest.length > 10) h += `<tr><td style="padding:6px 24px;font-size:13px;color:#475569">Pozostałe zgłoszenia: ${rest.length - 10}. ${a(LINK.issues, 'Pełna lista w portalu')}.</td></tr>`;
  } else if (!events.length && S.healthRead) h += `<tr><td style="padding:14px 24px 0;font-size:14px;color:#334155">${dot('ok')}Microsoft nie zgłasza otwartych incydentów ani porad w tenantach testowych.</td></tr>`;

  const wd = (Array.isArray(st.withdrawn) ? st.withdrawn : []).filter((w) => !shown.has(w.id));
  if (wd.length) {
    h += h2(`Incydenty wycofane przez Microsoft w ostatnich 7 dniach (${wd.length})`);
    h += `<tr><td style="padding:0 24px 4px;font-size:13px;color:#475569;line-height:1.5">Microsoft usunął te zgłoszenia z Service health bez oznaczenia zamknięcia i bez komunikatu końcowego.</td></tr>`;
    for (const w of wd.slice(0, 6)) h += `<tr><td style="padding:6px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #b4bfce;border-left:4px solid #64748b;border-radius:12px"><tr><td style="padding:13px 16px"><div style="font-size:15px;font-weight:600;color:#0f1b2d;line-height:1.35">${esc(w.title)}</div><div style="margin-top:6px"><span style="display:inline-block;padding:2px 9px;border-radius:999px;background:#eef2f7;color:#475569;font-size:12px;font-weight:700;white-space:nowrap">Wycofany incydent</span> &nbsp;<span style="font-size:14px;font-weight:700;color:#0f1b2d">${esc(w.id)}</span></div>${fact('Usługa', esc(w.service || 'brak danych'))}${fact('Ostatni znany stan', esc(hstWord(w.status)))}${fact('Początek', esc(both(w.start)))}${fact('Ostatnia zmiana po stronie Microsoft', esc(both(w.last)))}${w.gone ? fact('Ostatnio widoczny w odczycie', esc(both(w.gone))) : ''}${links([[LINK.analysis, 'Karta analizy incydentu']])}</td></tr></table></td></tr>`;
  }

  const closedAll = S.closed.filter((i) => !shown.has(i.id));
  if (closedAll.length) {
    h += h2(`Incydenty zamknięte przez Microsoft w ostatnich 7 dniach (${closedAll.length})`);
    closedAll.slice(0, 3).forEach((i, k) => { h += issueCard(i, '', 'ok', false, k + 1); });
    h += `<tr><td style="padding:6px 24px;font-size:13px;color:#475569;line-height:1.5">${closedAll.length > 3 ? `Pozostałe zamknięte incydenty: ${closedAll.length - 3}. ` : ''}${a(LINK.analysis, 'Karty analizy zamkniętych incydentów')} &nbsp;·&nbsp; ${a(LINK.issues, 'Rejestr incydentów')}</td></tr>`;
  }

  const bad = S.m.filter((g) => g.down || (g.avail !== null && g.avail < 100));
  const avAll = S.m.filter((g) => g.avail !== null);
  const avg = avAll.length ? avAll.reduce((n, g) => n + g.avail, 0) / avAll.length : null;
  const sg = st.signals || {};
  const SW = { ok: 'bez odchyleń', warn: 'odchylenie', crit: 'duże odchylenie' };
  const sc = (k) => (['ok', 'warn', 'crit'].includes(sg[k]?.state) ? sg[k].state : 'mute');
  const meas = [];
  if (avg !== null) meas.push(['Sondy HTTP', 'średnia dostępność z 24 godzin', `${avg.toFixed(2).replace('.', ',')}%`, S.probesDown ? 'crit' : avg < 100 ? 'warn' : 'ok']);
  if (sg.atlas?.n) meas.push(['Sondy RIPE Atlas', 'osiągalność sieci Microsoft', `${String(sg.atlas.reach).replace('.', ',')}%, ${SW[sg.atlas.state] || 'brak oceny'}`, sc('atlas')]);
  if (sg.bgp?.v4) meas.push(['Trasy BGP', 'ogłoszenia sieci Microsoft', SW[sg.bgp.state] || 'brak oceny', sc('bgp')]);
  if (sg.radar?.configured && sg.radar.values) meas.push(['Cloudflare Radar', 'ruch do sieci Microsoft', SW[sg.radar.state] || 'brak oceny', sc('radar')]);
  const rows = daily ? S.m : bad;
  if (meas.length || rows.length) h += h2('Pomiary własne i sygnały zewnętrzne');
  if (meas.length) {
    const mt = 'padding:10px 14px;font-size:12.5px;font-weight:700;color:#64748b;text-align:left;border-bottom:2px solid #b4bfce';
    h += `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #b4bfce;border-radius:12px;background:#f8fafc"><tr><th style="${mt}">Pomiar</th><th style="${mt};text-align:right">Wynik</th></tr>`
      + meas.map(([k, sub, v, c], x) => { const bb = x === meas.length - 1 ? '' : 'border-bottom:1px solid #cdd5e0;'; return `<tr><td valign="middle" style="padding:10px 14px;${bb}"><div style="font-size:14px;font-weight:700;color:#0f1b2d;line-height:1.3">${esc(k)}</div><div style="font-size:12.5px;color:#64748b;line-height:1.35">${esc(sub)}</div></td><td valign="middle" style="padding:10px 14px;${bb}text-align:right;font-size:14.5px;font-weight:700;color:${COL[c]};line-height:1.35">${dot(c)}${esc(v)}</td></tr>`; }).join('')
      + `</table></td></tr>`;
  }
  if (rows.length) {
    const td = 'padding:8px 6px;border-bottom:1px solid #e5e9f0;font-size:13px;color:#1f2937';
    const th = 'padding:7px 6px;border-bottom:2px solid #d5dbe5;font-size:11px;color:#64748b;text-align:left';
    h += `<tr><td style="padding:14px 24px 0"><div style="font-size:14px;font-weight:700;color:#0f1b2d;margin-bottom:4px">${daily ? 'Sondy HTTP według usług' : 'Usługi z nieudanymi pomiarami lub dostępnością poniżej 100%'}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><th style="${th}">Usługa</th><th style="${th};white-space:nowrap">Sondy</th><th style="${th};text-align:right">Dostępność 24&nbsp;h</th><th style="${th};text-align:right">Mediana</th></tr>`;
    for (const g of rows) {
      const c = g.down === g.probes ? 'crit' : g.down ? 'warn' : 'ok';
      h += `<tr><td style="${td}">${esc(g.name)}</td><td style="${td};color:${COL[c]};font-weight:700;white-space:nowrap">${g.probes - g.down}&nbsp;z&nbsp;${g.probes}</td><td style="${td};text-align:right;white-space:nowrap">${g.avail === null ? 'brak' : `${g.avail.toFixed(2).replace('.', ',')}%`}</td><td style="${td};text-align:right;white-space:nowrap">${g.median === null ? 'brak' : `${g.median}&nbsp;ms`}</td></tr>`;
    }
    h += `</table></td></tr>`;
  }

  if (daily) {
    const seen = new Set();
    const dayAgo = new Date(now - 86400000).toISOString();
    const mc = (st.health || []).flatMap((x) => (x.ok ? x.messages || [] : [])).filter((x) => x && x.id && !seen.has(x.id) && seen.add(x.id) && String(x.modified || '') > dayAgo).sort((x, y) => (Number(!!y.major) - Number(!!x.major)) || String(y.modified).localeCompare(String(x.modified)));
    if (mc.length) {
      h += h2(`Centrum wiadomości Microsoft 365: zmiany z 24 godzin (${mc.length})`);
      h += `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">`;
      for (const x of mc.slice(0, 6)) h += `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e9f0;font-size:13px;color:#1f2937;line-height:1.45"><a href="${esc(LINK.mc(x.id))}" style="font-family:Consolas,Menlo,monospace;font-weight:700;color:#0b63ce">${esc(x.id)}</a>${x.major ? ` &nbsp;${chip('Istotna zmiana', 'warn')}` : ''}${x.actionBy ? ` &nbsp;${chip(`Termin działania: ${fdt(x.actionBy).slice(0, 10)}`, 'info')}` : ''}<br>${esc(cut(x.title, 150))}</td></tr>`;
      h += `</table>${mc.length > 6 ? `<div style="font-size:13px;color:#475569;margin-top:8px">Pozostałe wiadomości: ${mc.length - 6}. ${a(LINK.messages, 'Pełna lista w portalu')}.</div>` : ''}</td></tr>`;
    }
  }

  h += `<tr><td style="padding:22px 24px 6px"><a href="${esc(events.some((e) => e.issue) ? LINK.issues : LINK.portal)}" style="display:inline-block;background:#0b63ce;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px">${esc(events.some((e) => e.issue) ? 'Otwórz incydenty w portalu' : 'Otwórz portal AzureMe Pulse')}</a></td></tr>`;
  h += `<tr><td style="padding:6px 24px 20px">${links([[LINK.portal, 'Przegląd'], [LINK.issues, 'Incydenty'], [LINK.analysis, 'Analiza incydentów'], [LINK.services, 'Stan usług'], [LINK.messages, 'Komunikaty Microsoft'], [LINK.adminHealth, 'Service health w centrum administracyjnym'], [LINK.m365, 'status.cloud.microsoft'], [LINK.azure, 'Azure Status']])}</td></tr>`;
  h += `<tr><td style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e5e9f0;border-radius:0 0 12px 12px;font-size:12px;line-height:1.55;color:#64748b">Wiadomość wygenerowana automatycznie przez AzureMe Pulse. Portal wysyła wiadomość, gdy Microsoft otworzy, zaktualizuje lub zamknie incydent, gdy własna sonda wykryje brak odpowiedzi usługi oraz raz na dobę jako raport. Stan Service health pochodzi z tenantów testowych; treść zgłoszeń jest cytowana w brzmieniu Microsoft, w skrócie. Odnośniki do centrum administracyjnego wymagają konta administratora tenanta, w którym zgłoszenie jest widoczne.</td></tr></table></td></tr></table></body></html>`;
  return { subject, html: h };
}

// Returns the notify state to store in the data file: the date of the last daily report and cooldown keys (no addresses).
export async function notify(prev, next, now = Date.now(), fetchImpl = fetch) {
  const state = { ...(prev.notify || {}) };
  let cfg;
  try { cfg = JSON.parse(process.env.PULSE_NOTIFY || 'null'); } catch { console.log('notify: PULSE_NOTIFY nie jest poprawnym JSON'); return state; }
  const to = [].concat(cfg?.to || []).filter((a) => /^[^@\s]+@[^@\s]+$/.test(a));
  if (!cfg || !to.length || !cfg.from || !cfg.tenant) { console.log('notify: brak konfiguracji, pomijam'); return state; }
  const hasPrev = Array.isArray(prev.samples) && prev.samples.length > 0;
  const events = hasPrev ? mailEvents(prev, next, state, now, cfg) : [];
  const daily = dailyDue(prev, now);
  if (!events.length && !daily) { console.log('notify: brak zmian wymagających wiadomości'); return state; }
  try {
    const tenant = JSON.parse(process.env.PULSE_TENANTS || '[]').find((t) => t.label === cfg.tenant);
    if (!tenant) throw new Error('tenant nadawcy nie występuje w PULSE_TENANTS');
    const token = await graphToken(tenant, await githubOidcToken());
    const mail = buildMail(next, events, daily, now);
    const r = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.from)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { subject: mail.subject, body: { contentType: 'HTML', content: mail.html }, toRecipients: to.map((address) => ({ emailAddress: { address } })) }, saveToSentItems: false }),
    });
    if (r.status !== 202) throw new Error(`sendMail: HTTP ${r.status}`);
    console.log(`notify: wysłano (${events.map((e) => e.type).join(', ') || 'bez zdarzeń'}${daily ? ', raport dobowy' : ''})`);
    if (daily) state.lastDaily = daily;
  } catch (e) {
    // The address must not reach the log, so only the message of the error is printed.
    console.log(`notify: błąd wysyłki: ${String(e.message || e).slice(0, 160)}`);
  }
  return state;
}
// Sender for notifications must be an existing mailbox (user or shared) in the tenant named in PULSE_NOTIFY.
