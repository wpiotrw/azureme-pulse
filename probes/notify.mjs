// AzureMe Pulse: e-mail notifications about state changes and a daily report.
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

const COL = { ok: '#15803d', warn: '#b45309', crit: '#b91c1c' };
const BG = { ok: '#ecfdf3', warn: '#fff7e6', crit: '#fef0f0' };

export function buildMail(st, events, daily, now = Date.now()) {
  const m = metrics(st, now);
  const hm = healthMap(st);
  const notOk = [...hm].filter(([, c]) => c !== 'ok');
  const open = [...openIssues(st).values()];
  const probesDown = m.reduce((a, g) => a + g.down, 0);
  const probesAll = m.reduce((a, g) => a + g.probes, 0);
  const worst = probesDown || notOk.some(([, c]) => c === 'crit') || events.some((e) => e.sev === 'crit') ? 'crit' : notOk.length || events.some((e) => e.sev === 'warn') ? 'warn' : 'ok';
  const headline = worst === 'crit' ? 'Wykryto przerwę w świadczeniu usług' : worst === 'warn' ? 'Usługi z obniżoną wydajnością' : 'Wszystkie usługi dostępne';
  const first = events[0];
  const subject = daily && !events.length
    ? `[AzureMe Pulse] Raport dobowy ${daily.split('-').reverse().join('-')}: ${headline.toLowerCase()}`
    : `[AzureMe Pulse] ${first.title.slice(0, 110)}${events.length > 1 ? ` (+${events.length - 1})` : ''}`;
  const td = 'padding:9px 12px;border-bottom:1px solid #e5e9f0;font-size:14px;color:#1f2937';
  const th = 'padding:8px 12px;border-bottom:2px solid #d5dbe5;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;text-align:left';
  const tile = (v, k, c) => `<td width="33%" style="padding:6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e9f0;border-radius:8px"><tr><td style="padding:12px 14px"><div style="font-size:24px;font-weight:700;color:${c};font-family:Segoe UI,Arial,sans-serif">${esc(v)}</div><div style="font-size:12px;color:#64748b">${esc(k)}</div></td></tr></table></td>`;
  const dot = (c) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${COL[c]};margin-right:8px"></span>`;
  let h = `<!doctype html><html lang="pl"><body style="margin:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif;color:#1f2937"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e9f0">`;
  h += `<tr><td style="background:#07111f;padding:18px 24px;border-bottom:4px solid ${COL[worst]}"><div style="font-size:12px;letter-spacing:.12em;color:#8fb7e8">AZUREME PULSE</div><div style="font-size:20px;font-weight:600;color:#ffffff;margin-top:4px">${esc(daily && !events.length ? 'Raport dobowy' : 'Zmiana stanu usług')}</div><div style="font-size:13px;color:#b6c4d8;margin-top:2px">${esc(fdt(new Date(now).toISOString()))}</div></td></tr>`;
  h += `<tr><td style="padding:18px 24px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG[worst]};border-radius:8px"><tr><td style="padding:12px 16px;font-size:16px;font-weight:600;color:${COL[worst]}">${dot(worst)}${esc(headline)}</td></tr></table></td></tr>`;
  h += `<tr><td style="padding:6px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tile(`${probesAll - probesDown} z ${probesAll}`, 'punkty końcowe odpowiadają', probesDown ? COL.crit : COL.ok)}${tile(String(notOk.length), 'usługi z obniżoną wydajnością według Microsoft', notOk.length ? COL.warn : COL.ok)}${tile(String(open.length), 'otwarte zgłoszenia Service health', open.length ? COL.warn : COL.ok)}</tr></table></td></tr>`;
  if (events.length) {
    h += `<tr><td style="padding:14px 24px 0"><div style="font-size:15px;font-weight:600">Zdarzenia od poprzedniego pomiaru</div></td></tr><tr><td style="padding:8px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">`;
    for (const e of events.slice(0, 15)) h += `<tr><td style="${td};border-left:4px solid ${COL[e.sev]}"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">${esc(e.kind)}</div><div style="font-weight:600;margin:2px 0">${esc(e.title)}</div><div style="font-size:13px;color:#475569">${esc(String(e.text || '').slice(0, 500))}</div></td></tr>`;
    if (events.length > 15) h += `<tr><td style="${td}">Pozostałe zdarzenia: ${events.length - 15}. Pełna lista jest dostępna w portalu.</td></tr>`;
    h += `</table></td></tr>`;
  }
  h += `<tr><td style="padding:14px 24px 0"><div style="font-size:15px;font-weight:600">Sondy HTTP, ostatnie 24 godziny</div></td></tr><tr><td style="padding:8px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><th style="${th}">Usługa</th><th style="${th}">Stan</th><th style="${th};text-align:right">Dostępność</th><th style="${th};text-align:right">Mediana</th></tr>`;
  for (const g of m) {
    const c = g.down === g.probes ? 'crit' : g.down ? 'warn' : 'ok';
    h += `<tr><td style="${td}">${esc(g.name)}</td><td style="${td};color:${COL[c]};font-weight:600">${dot(c)}${g.probes - g.down} z ${g.probes}</td><td style="${td};text-align:right;font-family:Consolas,monospace">${g.avail === null ? 'brak' : `${g.avail.toFixed(2).replace('.', ',')}%`}</td><td style="${td};text-align:right;font-family:Consolas,monospace">${g.median === null ? 'brak' : `${g.median} ms`}</td></tr>`;
  }
  h += `</table></td></tr>`;
  if (notOk.length || open.length) {
    h += `<tr><td style="padding:14px 24px 0"><div style="font-size:15px;font-weight:600">Microsoft Service health</div></td></tr><tr><td style="padding:8px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">`;
    for (const [name, c] of notOk) h += `<tr><td style="${td}">${dot(c)}${esc(name)}</td><td style="${td};text-align:right;color:${COL[c]};font-weight:600">${esc(WORD[c])}</td></tr>`;
    for (const i of open.slice(0, 8)) h += `<tr><td colspan="2" style="${td}"><span style="font-family:Consolas,monospace;font-size:12px;color:#64748b">${esc(i.id)}</span> ${esc(i.title)}</td></tr>`;
    if (open.length > 8) h += `<tr><td colspan="2" style="${td}">Pozostałe otwarte zgłoszenia: ${open.length - 8}.</td></tr>`;
    h += `</table></td></tr>`;
  }
  if (st.azure?.ok) h += `<tr><td style="padding:10px 24px 0;font-size:14px">${dot(st.azure.items.length ? 'warn' : 'ok')}Azure Status: ${st.azure.items.length ? `aktywne zdarzenia: ${st.azure.items.length}` : 'brak aktywnych zdarzeń'}</td></tr>`;
  h += `<tr><td style="padding:20px 24px"><a href="${SITE}" style="display:inline-block;background:#0b63ce;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">Otwórz portal AzureMe Pulse</a></td></tr>`;
  h += `<tr><td style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e5e9f0;font-size:12px;color:#64748b">Wiadomość wygenerowana automatycznie. Sondy HTTP działają z jednej lokalizacji (GitHub Actions); stan Service health pochodzi z tenantów testowych. Tytuły zgłoszeń są cytowane w brzmieniu Microsoft.</td></tr></table></td></tr></table></body></html>`;
  return { subject, html: h };
}

// Returns the notify state to store in the data file (only the date of the last daily report).
export async function notify(prev, next, now = Date.now(), fetchImpl = fetch) {
  const state = { ...(prev.notify || {}) };
  let cfg;
  try { cfg = JSON.parse(process.env.PULSE_NOTIFY || 'null'); } catch { console.log('notify: PULSE_NOTIFY nie jest poprawnym JSON'); return state; }
  const to = [].concat(cfg?.to || []).filter((a) => /^[^@\s]+@[^@\s]+$/.test(a));
  if (!cfg || !to.length || !cfg.from || !cfg.tenant) { console.log('notify: brak konfiguracji, pomijam'); return state; }
  const hasPrev = Array.isArray(prev.samples) && prev.samples.length > 0;
  const events = hasPrev ? diffEvents(prev, next) : [];
  const daily = dailyDue(prev, now);
  if (!events.length && !daily) { console.log('notify: brak zmian'); return state; }
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
    console.log(`notify: wysłano (${events.length} zdarzeń${daily ? ', raport dobowy' : ''})`);
    if (daily) state.lastDaily = daily;
  } catch (e) {
    // The address must not reach the log, so only the message of the error is printed.
    console.log(`notify: błąd wysyłki: ${String(e.message || e).slice(0, 160)}`);
  }
  return state;
}
// Sender for notifications must be an existing mailbox (user or shared) in the tenant named in PULSE_NOTIFY.
