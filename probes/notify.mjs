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
    for (const [id, i] of no) if (!pa.has(id)) ev.push({ sev: statusClass(i.status) === 'crit' ? 'crit' : 'warn', kind: 'Nowe zgłoszenie', title: `${id}: ${i.title}`, text: `${i.service || ''}${i.current ? `. ${i.current}` : ''}` });
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

const COL = { ok: '#15803d', warn: '#b45309', crit: '#b91c1c', info: '#1d4ed8' };
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
      if (!inc && !(cfg.advisories === true && !p && !i.resolved)) continue;
      if (!p) { if (!i.resolved) ev.push({ type: 'new', sev: inc ? 'crit' : 'warn', issue: i }); continue; }
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

export function summary(st, now = Date.now()) {
  const all = [...issuesById(st).values()];
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

const span = (min) => (min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} godz. ${min % 60} min` : `${Math.floor(min / 1440)} dni`);
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
    } else if (e.type === 'withdrawn') {
      out.lead = 'Microsoft usunął incydent z Service health tenantów bez wpisu o zamknięciu.';
      out.items.push(['Ostatni znany stan', hstWord(i.status)]);
      out.items.push(['Ostatni wpis Microsoft', both(i.updateAt)]);
      out.items.push(['Co to oznacza', 'Zgłoszenie nie jest już widoczne w żadnym tenancie testowym. Microsoft nie opublikował komunikatu końcowego.']);
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

const KIND = { new: 'Nowy incydent Microsoft', update: 'Aktualizacja Microsoft', closed: 'Incydent zamknięty przez Microsoft', withdrawn: 'Incydent wycofany przez Microsoft', 'probe-down': 'Awaria wykryta przez sondę portalu', 'probe-up': 'Sonda portalu: odpowiedź przywrócona', signal: 'Sygnał zewnętrzny: duże odchylenie' };

function eventSubject(e) {
  if (e.issue) {
    const what = e.type === 'new' ? (isIncident(e.issue) ? (e.reclass ? 'Porada Microsoft przeklasyfikowana na incydent' : e.reopened ? 'Incydent Microsoft otwarty ponownie' : 'Nowy incydent Microsoft') : 'Nowa porada Microsoft') : e.type === 'closed' ? 'Incydent zamknięty' : e.type === 'withdrawn' ? 'Incydent wycofany z Service health' : 'Aktualizacja Microsoft';
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
  const h2 = (t) => `<tr><td style="padding:22px 24px 8px;font-size:16px;font-weight:700;color:#0f1b2d">${esc(t)}</td></tr>`;
  const tile = (v, k, c, href) => `<td width="50%" valign="top" style="padding:5px"><a href="${esc(href)}" style="text-decoration:none"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dfe5ee;border-top:3px solid ${COL[c]};border-radius:8px"><tr><td style="padding:11px 14px"><div style="font-size:24px;line-height:1.15;font-weight:700;color:${COL[c]};white-space:nowrap">${esc(v)}</div><div style="font-size:13px;color:#475569;margin-top:2px">${esc(k)}</div></td></tr></table></a></td>`;
  const links = (list) => `<div style="margin-top:10px;font-size:13px;line-height:1.9">${list.map(([href, text]) => a(href, text)).join(' &nbsp;·&nbsp; ')}</div>`;
  const fact = (k, v) => (v ? `<div style="font-size:13px;color:#334155;margin-top:3px;overflow-wrap:anywhere;word-break:break-word"><span style="color:#64748b">${esc(k)}:</span> ${v}</div>` : '');
  const issueLinks = (i) => links([[LINK.issues, 'Zgłoszenie w portalu'], ...(isIncident(i) ? [[LINK.analysis, 'Karta analizy incydentu']] : []), [LINK.admin(i.id), 'Centrum administracyjne Microsoft 365'], [LINK.m365, 'Publiczna strona stanu']]);
  const issueCard = (i, kind, c, full) => `<tr><td style="padding:6px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dfe5ee;border-left:4px solid ${COL[c]};border-radius:8px"><tr><td style="padding:13px 16px">`
    + (kind ? `<div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;color:${COL[c]}">${esc(kind)}</div>` : '')
    + `<div style="margin-top:5px">${chip(isIncident(i) ? 'Incydent' : 'Porada', isIncident(i) ? 'crit' : 'warn')} &nbsp;<a href="${esc(LINK.admin(i.id))}" style="font-family:Consolas,Menlo,monospace;font-size:14px;font-weight:700;color:#0b63ce">${esc(i.id)}</a></div>`
    + `<div style="font-size:15px;font-weight:600;color:#0f1b2d;margin-top:6px;line-height:1.35">${esc(i.title)}</div>`
    + fact('Usługa', esc(i.service || 'brak danych'))
    + fact('Stan według Microsoft', `<b>${esc(hstWord(i.status))}</b>`)
    + fact('Początek', esc(both(i.start)))
    + (i.resolved ? fact('Koniec', esc(both(i.end || i.modified))) : '')
    + fact('Ostatnia aktualizacja Microsoft', esc(both(i.updateAt || i.modified)))
    + (!i.resolved && i.next && !Number.isNaN(Date.parse(i.next)) ? fact('Następna aktualizacja', esc(both(i.next))) : '')
    + fact('Widoczne w', esc((i.tenants || []).join(', ')))
    + (full && i.impact ? `<div style="font-size:13px;color:#334155;margin-top:9px"><b>Wpływ na użytkowników:</b> ${esc(cut(i.impact, 420))}</div>` : '')
    + (full && i.current ? `<div style="font-size:13px;color:#334155;margin-top:6px"><b>Aktualny stan:</b> ${esc(cut(i.current, 700))}</div>` : '')
    + (full && Array.isArray(i.affected) && i.affected.length ? `<div style="font-size:13px;color:#334155;margin-top:6px"><b>Usługi objęte zgłoszeniem:</b> ${esc(i.affected.map((x) => x.n).filter(Boolean).slice(0, 14).join(', '))}</div>` : '')
    + issueLinks(i) + `</td></tr></table></td></tr>`;

  let h = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head><body style="margin:0;padding:0;background:#f1f4f9;${F};color:#1f2937">`;
  h += `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(`${headline}. Porady: ${S.advisories.length}. Sondy portalu: ${S.probesAll - S.probesDown} z ${S.probesAll} odpowiada.`)}</div>`;
  h += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f4f9"><tr><td align="center" style="padding:18px 10px"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;table-layout:fixed;background:#ffffff;border:1px solid #dfe5ee;border-top:5px solid ${COL[worst]};border-radius:12px">`;
  h += `<tr><td style="padding:20px 24px 4px"><div style="font-size:12px;letter-spacing:.14em;font-weight:700;color:#0b63ce">AZUREME PULSE</div><div style="font-size:22px;font-weight:700;color:#0f1b2d;margin-top:4px;line-height:1.25">${esc(events.length ? KIND[events[0].type] : 'Raport dobowy')}</div><div style="font-size:13px;color:#64748b;margin-top:3px">${esc(both(nowIso))}</div></td></tr>`;
  let whyBox = '';
  if (events.length) {
    let w = '';
    for (const e of events.slice(0, 8)) {
      const y = whyEvent(e);
      const who = e.issue ? `${e.issue.id}${e.issue.service ? `, ${e.issue.service}` : ''}` : e.probe ? e.probe.name : e.name;
      w += `<div style="margin-top:10px"><div style="font-size:15px;font-weight:700;color:#0f1b2d;line-height:1.35">${esc(who)}: ${esc(y.lead)}</div>`
        + y.items.map(([k, v]) => `<div style="font-size:13.5px;color:#334155;margin-top:5px;line-height:1.45;overflow-wrap:anywhere;word-break:break-word"><span style="color:#64748b">${esc(k)}:</span> ${esc(v)}</div>`).join('') + `</div>`;
    }
    whyBox = `<tr><td style="padding:14px 24px 2px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4ff;border:1px solid #c7d7f5;border-radius:14px"><tr><td style="padding:14px 16px 16px"><div style="font-size:13px;font-weight:700;color:#1d4ed8">Dlaczego ta wiadomość${events.length > 1 ? ` (zmiany: ${events.length})` : ''}</div>${w}</td></tr></table></td></tr>`;
  }
  h += whyBox;
  h += `<tr><td style="padding:14px 24px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG[worst]};border-radius:8px"><tr><td style="padding:12px 16px;font-size:16px;font-weight:700;color:${COL[worst]}">${dot(worst)}${esc(headline)}</td></tr></table></td></tr>`;
  h += `<tr><td style="padding:8px 19px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tile(String(S.incidents.length), 'aktywne incydenty Microsoft', S.incidents.length ? 'crit' : 'ok', LINK.issues)}${tile(String(S.advisories.length), 'aktywne porady Microsoft', S.advisories.length ? 'warn' : 'ok', LINK.issues)}</tr><tr>${tile(`${S.probesAll - S.probesDown} z ${S.probesAll}`, 'sondy HTTP portalu odpowiadają', S.probesDown ? 'crit' : 'ok', LINK.probes)}${tile(S.regionsAll ? `${S.regionsAll - S.regionsDown} z ${S.regionsAll}` : 'brak', 'regiony Azure odpowiadają', S.regionsDown ? 'warn' : 'ok', `${SITE}#/regiony`)}</tr></table></td></tr>`;

  if (events.length) {
    h += h2(events.length > 1 ? `Zgłoszenia, których dotyczy wiadomość (${events.length})` : 'Zgłoszenie, którego dotyczy wiadomość');
    for (const e of events.slice(0, 8)) {
      if (e.issue) {
        const kind = e.type === 'new' ? (isIncident(e.issue) ? (e.reclass ? 'Porada przeklasyfikowana na incydent' : e.reopened ? 'Incydent otwarty ponownie' : 'Nowy incydent') : 'Nowa porada') : e.type === 'closed' ? 'Incydent zamknięty' : e.type === 'withdrawn' ? 'Incydent wycofany z Service health' : `Aktualizacja Microsoft${e.prevStatus ? `: ${hstWord(e.prevStatus)} → ${hstWord(e.issue.status)}` : ''}`;
        h += issueCard(e.issue, kind, e.sev, true);
      } else if (e.probe) {
        h += `<tr><td style="padding:6px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dfe5ee;border-left:4px solid ${COL[e.sev]};border-radius:8px"><tr><td style="padding:13px 16px"><div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;color:${COL[e.sev]}">${esc(KIND[e.type])}</div><div style="font-size:15px;font-weight:600;color:#0f1b2d;margin-top:5px">${esc(`${e.probe.name}: ${e.probe.what}`)}</div>${fact('Wynik', esc(e.type === 'probe-down' ? `dwa kolejne nieudane pomiary, ostatni kod odpowiedzi: ${e.probe.last?.code || 'brak odpowiedzi'}` : `ostatni pomiar poprawny, ${e.probe.last?.ms} ms`))}${fact('Sprawdzany adres', esc(e.probe.url || ''))}${fact('Zastrzeżenie', 'pomiar z jednej lokalizacji (GitHub Actions); brak odpowiedzi nie przesądza o awarii usługi')}${links([[LINK.probes, 'Sondy HTTP w portalu'], [`${SITE}#/sygnaly`, 'Panel sygnalizacyjny'], [LINK.m365, 'Publiczna strona stanu']])}</td></tr></table></td></tr>`;
      } else {
        h += `<tr><td style="padding:6px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dfe5ee;border-left:4px solid ${COL.crit};border-radius:8px"><tr><td style="padding:13px 16px"><div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;color:${COL.crit}">${esc(KIND.signal)}</div><div style="font-size:15px;font-weight:600;color:#0f1b2d;margin-top:5px">${esc(e.name)}</div>${fact('Źródło', esc(e.signal.source || ''))}${links([[LINK.analysis, 'Sygnały zewnętrzne w portalu']])}</td></tr></table></td></tr>`;
      }
    }
    if (events.length > 8) h += `<tr><td style="padding:6px 24px;font-size:13px;color:#475569">Pozostałe zmiany: ${events.length - 8}. Pełna lista: ${a(LINK.portal, 'dziennik zmian w portalu')}.</td></tr>`;
  }

  const shown = new Set(events.filter((e) => e.issue).map((e) => e.issue.id));
  const rest = S.open.filter((i) => !shown.has(i.id));
  if (rest.length) {
    h += h2(shown.size ? `Pozostałe otwarte zgłoszenia Microsoft (${rest.length})` : `Otwarte zgłoszenia Microsoft (${rest.length})`);
    for (const i of rest.slice(0, 10)) h += issueCard(i, '', isIncident(i) ? 'crit' : 'warn', false);
    if (rest.length > 10) h += `<tr><td style="padding:6px 24px;font-size:13px;color:#475569">Pozostałe zgłoszenia: ${rest.length - 10}. ${a(LINK.issues, 'Pełna lista w portalu')}.</td></tr>`;
  } else if (!events.length && S.healthRead) h += `<tr><td style="padding:14px 24px 0;font-size:14px;color:#334155">${dot('ok')}Microsoft nie zgłasza otwartych incydentów ani porad w tenantach testowych.</td></tr>`;

  const closedList = S.closed.filter((i) => !shown.has(i.id)).slice(0, 3);
  if (closedList.length) {
    h += `<tr><td style="padding:18px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG.ok};border:1px solid #bfe5cd;border-left:4px solid ${COL.ok};border-radius:8px"><tr><td style="padding:13px 16px"><div style="font-size:15px;font-weight:700;color:${COL.ok}">${esc(closedList.length === 1 ? 'Ostatnio zamknięty incydent Microsoft' : `Ostatnio zamknięte incydenty Microsoft (${S.closed.filter((i) => !shown.has(i.id)).length} z ostatnich 7 dni)`)}</div>`;
    for (const i of closedList) {
      const cl = i.updateAt || i.modified;
      const st = Date.parse(i.start);
      const en = Date.parse(i.end || cl);
      const mins = !Number.isNaN(st) && !Number.isNaN(en) && en > st ? Math.round((en - st) / 60000) : null;
      const dur = mins === null ? '' : mins >= 1440 ? `${Math.floor(mins / 1440)} d ${Math.floor((mins % 1440) / 60)} h` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
      h += `<div style="margin-top:9px;font-size:13px;line-height:1.5;color:#1f2937;overflow-wrap:anywhere"><a href="${esc(LINK.admin(i.id))}" style="font-family:Consolas,Menlo,monospace;font-weight:700;color:#0b63ce">${esc(i.id)}</a> ${esc(cut(i.title, 130))}<br><span style="color:#475569">Zamknięty przez Microsoft: ${esc(both(cl))}.${i.end ? ` Koniec wpływu na użytkowników według Microsoft: ${esc(fdt(i.end))}.` : ''}${dur ? ` Czas trwania: ${dur}.` : ''} Stan: ${esc(hstWord(i.status))}.</span></div>`;
    }
    h += links([[LINK.analysis, 'Karty analizy zamkniętych incydentów'], [LINK.issues, 'Rejestr incydentów']]) + `</td></tr></table></td></tr>`;
  }

  h += h2('Pomiary własne portalu');
  const bad = S.m.filter((g) => g.down || (g.avail !== null && g.avail < 100));
  const avAll = S.m.filter((g) => g.avail !== null);
  const avg = avAll.length ? avAll.reduce((n, g) => n + g.avail, 0) / avAll.length : null;
  h += `<tr><td style="padding:0 24px;font-size:14px;color:#334155;line-height:1.6">${dot(S.probesDown ? 'crit' : 'ok')}Sondy HTTP: odpowiada ${S.probesAll - S.probesDown} z ${S.probesAll}${avg === null ? '' : `, średnia dostępność z 24 godzin ${avg.toFixed(2).replace('.', ',')}%`}.<br>${dot(S.regionsDown ? 'warn' : 'ok')}Regiony Azure: odpowiada ${S.regionsAll - S.regionsDown} z ${S.regionsAll}.`;
  const sg = st.signals || {};
  const SW = { ok: 'bez odchyleń', warn: 'odchylenie', crit: 'duże odchylenie' };
  const sig = [];
  if (sg.atlas?.n) sig.push(`sondy RIPE Atlas ${String(sg.atlas.reach).replace('.', ',')}% (${SW[sg.atlas.state] || 'brak oceny'})`);
  if (sg.bgp?.v4) sig.push(`trasy BGP ${SW[sg.bgp.state] || 'brak oceny'}`);
  if (sg.radar?.configured && sg.radar.values) sig.push(`ruch w Cloudflare Radar ${SW[sg.radar.state] || 'brak oceny'}`);
  if (sig.length) { const sw = ['atlas', 'bgp', 'radar'].map((k) => sg[k]?.state).includes('crit') ? 'crit' : ['atlas', 'bgp', 'radar'].map((k) => sg[k]?.state).includes('warn') ? 'warn' : 'ok'; h += `<br>${dot(sw)}Sygnały zewnętrzne o sieci Microsoft: ${esc(sig.join(', '))}.`; }
  if (st.azure?.ok) h += `<br>${dot(st.azure.items.length ? 'warn' : 'ok')}Azure Status: ${st.azure.items.length ? `aktywne zdarzenia: ${st.azure.items.length}` : 'brak aktywnych zdarzeń o szerokim zasięgu'}.`;
  h += `</td></tr>`;
  const rows = daily ? S.m : bad;
  if (rows.length) {
    const td = 'padding:8px 6px;border-bottom:1px solid #e5e9f0;font-size:13px;color:#1f2937';
    const th = 'padding:7px 6px;border-bottom:2px solid #d5dbe5;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#64748b;text-align:left';
    h += `<tr><td style="padding:10px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><th style="${th}">Usługa</th><th style="${th};white-space:nowrap">Sondy</th><th style="${th};text-align:right">Dostępność 24&nbsp;h</th><th style="${th};text-align:right">Mediana</th></tr>`;
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
