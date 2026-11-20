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
const m = N.buildMail(live, ev, null, T); assert.match(m.subject, /przeklasyfikowana na incydent/); assert.ok(m.html.indexOf('Dlaczego ta wiadomość') < m.html.indexOf('aktywne incydenty Microsoft'));
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
console.log('WHY TESTS PASSED');
