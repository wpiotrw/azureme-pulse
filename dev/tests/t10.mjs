import fs from 'node:fs'; import assert from 'node:assert/strict';
const N = await import('../../probes/notify.mjs');
const live = JSON.parse(fs.readFileSync(new URL('./data/live18.json', import.meta.url),'utf8')); const T = Date.parse(live.generated);
const clone = (x) => JSON.parse(JSON.stringify(x));
const set = (d, f) => { for (const h of d.health) for (const i of h.issues || []) if (i.id === 'EX1561765') f(i, h); return d; };
// 1. nowy wpis: wcześniejszy czas i inna treść
let prev = set(clone(live), (i) => { i.updateAt = '2026-11-20T15:20:00Z'; i.current = 'Older text.'; i.next = '2026-11-20T16:00:00Z'; });
let st = {}; let ev = N.mailEvents(prev, live, st, T); assert.equal(ev.length, 1); assert.equal(ev[0].type, 'update');
let y = N.whyEvent(ev[0]); console.log(y.lead); console.log(y.items.map((x) => x[0]).join(' | '));
assert.match(y.lead, /nowy wpis/); assert.ok(y.items.some((x) => x[0] === 'Treść nowego wpisu')); assert.ok(y.items.some((x) => x[0] === 'Czas wpisu'));
// 2. druga wiadomość po 10 minutach: podaje odstęp
let next2 = set(clone(live), (i) => { i.updateAt = '2026-11-20T17:05:00Z'; });
ev = N.mailEvents(live, next2, st, T + 600000); y = N.whyEvent(ev[0]); console.log(y.lead, '|', y.items.at(-1).join(': '));
assert.match(y.lead, /odświeżył/); assert.deepEqual(y.items.at(-1), ['Poprzednia wiadomość o tym zgłoszeniu', '10 min temu']);
// 3. zmiana stanu bez nowego wpisu
let next3 = set(clone(live), (i) => { i.status = 'restoringService'; }); ev = N.mailEvents(live, next3, {}, T); y = N.whyEvent(ev[0]); console.log(y.lead, '|', y.items[0].join(': ')); assert.match(y.lead, /zmienił stan/);
// 4. porada przeklasyfikowana na incydent
prev = set(clone(live), (i) => { i.classification = 'advisory'; }); ev = N.mailEvents(prev, live, {}, T); assert.equal(ev[0].type, 'new'); assert.equal(ev[0].reclass, true); y = N.whyEvent(ev[0]); console.log(y.lead);
const m = N.buildMail(live, ev, null, T); assert.match(m.subject, /przeklasyfikowana na incydent/); assert.ok(m.html.indexOf('Powód powiadomienia') > 0 && m.html.indexOf('Powód powiadomienia') < m.html.indexOf('Stan według źródeł w chwili wysyłki'));
assert.ok(!m.html.includes('Dlaczego ta wiadomość')); assert.equal(m.html.split('Aktywne incydenty Microsoft: 1').length - 1, 1, 'liczba incydentów tylko w ukrytym nagłówku podglądu');
assert.ok(m.html.includes('1 incydent, wykryto we wszystkich tenantach (2); 3 porady')); assert.ok(m.html.includes('Publiczne strony stanu Microsoft')); assert.ok(m.html.includes('brak aktywnych problemów (subskrypcje: 1)'));
{ const one = clone(live); one.health[1].issues = one.health[1].issues.filter((i) => i.id !== 'EX1561765'); assert.ok(N.buildMail(one, [], '2026-11-21', T).html.includes('1 incydent, wykryto w 1 z 2 tenantów')); const np = clone(live); np.public = { ok: false }; assert.ok(N.buildMail(np, [], '2026-11-21', T).html.includes('brak odczytu')); const pb = clone(live); pb.public.m365.status = 'Degraded'; assert.ok(N.buildMail(pb, [], '2026-11-21', T).html.includes('1 zgłoszenie')); }
// 5. zamknięcie, sonda
let next5 = set(clone(live), (i) => { i.resolved = true; i.status = 'serviceRestored'; i.end = '2026-11-20T17:00:00Z'; }); ev = N.mailEvents(live, next5, {}, T); y = N.whyEvent(ev[0]); console.log(ev[0].type, y.lead, y.items.map((x) => x.join(': ')).join(' | '));
// zapis wiadomości do podglądu
prev = set(clone(live), (i) => { i.updateAt = '2026-11-20T15:20:00Z'; i.current = 'Older text.'; i.next = '2026-11-20T16:00:00Z'; });
ev = N.mailEvents(prev, live, { sent: { 'mail:EX1561765': Math.floor(T / 60000) - 10 } }, T); fs.writeFileSync(process.env.MAIL_OUT || '/tmp/mail_preview.html', N.buildMail(live, ev, null, T).html);
assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(N.buildMail(live, ev, null, T).html), 'brak identyfikatorów');
// 6. incydent znika z odczytu bez zamknięcia: wiadomość po dwóch pełnych odczytach
const gone = clone(live); for (const h of gone.health) h.issues = h.issues.filter((i) => i.id !== 'EX1561765');
st = {}; ev = N.mailEvents(live, gone, st, T); assert.equal(ev.filter((e) => e.type === 'withdrawn').length, 0, 'pierwszy odczyt: jeszcze bez wiadomości'); assert.ok(st.pending.EX1561765);
const part = clone(gone); part.health[0].lastError = 'HTTP 429'; ev = N.mailEvents(gone, part, st, T + 300000); assert.equal(ev.length, 0, 'niepełny odczyt nie liczy się');
ev = N.mailEvents(gone, gone, st, T + 600000); assert.deepEqual(ev.map((e) => e.type), ['withdrawn']); assert.equal(st.pending, undefined);
y = N.whyEvent(ev[0]); console.log(y.lead); const mw = N.buildMail(gone, ev, null, T + 600000); assert.match(mw.subject, /Incydent wycofany z Service health EX1561765/); assert.ok(mw.html.includes('bez wpisu o zamknięciu'));
st = {}; N.mailEvents(live, gone, st, T); ev = N.mailEvents(gone, live, st, T + 300000); assert.equal(st.pending, undefined, 'powrót zgłoszenia kasuje oczekiwanie'); assert.ok(!ev.some((e) => e.type === 'withdrawn'));
assert.ok(N.diffEvents(live, gone).some((e) => e.kind === 'Zgłoszenie wycofane'));
// 7. sekcja wycofanych incydentów w wiadomości
const wdl = JSON.parse(fs.readFileSync(new URL('./data/live19.json', import.meta.url), 'utf8'));
const md = N.buildMail(wdl, [], '2026-11-21', Date.parse(wdl.generated)); assert.ok(md.html.includes('Incydenty wycofane przez Microsoft w ostatnich 7 dniach (1)')); assert.ok(md.html.includes('EX1561765'));
if (process.env.MAIL_OUT) fs.writeFileSync(process.env.MAIL_OUT + '.daily.html', md.html);
// 8. przywrócenie wycofanego incydentu i obniżenie klasyfikacji
{
  const goneSt = clone(gone); goneSt.withdrawn = [{ id: 'EX1561765', title: 'x', service: 'Exchange Online', status: 'serviceDegradation', last: '2026-11-20T17:03:28Z', gone: '2026-11-20T17:40:00Z' }];
  const backSt = clone(live); backSt.restored = N.trackRestored(goneSt, backSt, T + 3600000);
  assert.deepEqual(backSt.restored.map((r) => [r.id, r.gone]), [['EX1561765', '2026-11-20T17:40:00Z']]);
  let e2 = N.mailEvents(goneSt, backSt, {}, T + 3600000); assert.deepEqual(e2.map((e) => e.type), ['restored']);
  const y2 = N.whyEvent(e2[0]); console.log(y2.lead); assert.match(y2.lead, /przywrócił incydent/); assert.ok(y2.items.some((x) => x[0] === 'Niewidoczne w odczycie od'));
  const m2 = N.buildMail(backSt, e2, null, T + 3600000); assert.match(m2.subject, /Incydent przywrócony w Service health EX1561765/);
  assert.ok(N.diffEvents(goneSt, backSt).some((e) => e.kind === 'Zgłoszenie przywrócone')); assert.ok(!N.diffEvents(goneSt, backSt).some((e) => e.kind === 'Nowe zgłoszenie' && e.title.startsWith('EX1561765')));
  const later = clone(backSt); assert.equal(N.mailEvents(backSt, later, {}, T + 3900000).length, 0, 'przywrócenie zgłaszane raz');
  assert.deepEqual(N.trackRestored(backSt, later, T + 3900000).map((r) => r.id), ['EX1561765']);
  assert.ok(N.buildMail(later, [], '2026-11-21', T + 3900000).html.includes('Przywrócony przez Microsoft'));
  const closedSt = clone(later); for (const h of closedSt.health) for (const i of h.issues) if (i.id === 'EX1561765') i.resolved = true; assert.deepEqual(N.trackRestored(later, closedSt, T + 4200000), []);
  const down = clone(live); for (const h of down.health) for (const i of h.issues) if (i.id === 'EX1561765') i.classification = 'advisory';
  e2 = N.mailEvents(live, down, {}, T); assert.deepEqual(e2.map((e) => e.type), ['downgraded']); assert.match(N.buildMail(down, e2, null, T).subject, /Incydent przeklasyfikowany na poradę EX1561765/);
  assert.ok(N.diffEvents(live, down).some((e) => e.kind === 'Zmiana klasyfikacji' && /z incydentu na poradę/.test(e.text)));
}
console.log('WHY TESTS PASSED');
