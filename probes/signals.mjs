// External signals about the Microsoft network, read from public services.
// - RIPEstat (no key): BGP visibility and announced prefixes of AS8075, as seen by the RIS route collectors.
// - Cloudflare Radar (token in the PULSE_CF_TOKEN secret): traffic from AS8075 observed at Cloudflare's edge.
// Both are indirect indicators. They do not measure user traffic to Microsoft 365.

const UA = 'azureme-pulse-probe/0.1 (+https://pulse.azureme.pl)';
export const ASN = 8075;
const EVERY_MIN = 14; // both sources change slowly; read them every third run
const MAX_HIST = 96;

const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fresh = (prev, now) => prev && prev.ok && prev.fetched && now - Date.parse(prev.fetched) < EVERY_MIN * 60000;

async function getJson(url, headers = {}, timeoutMs = 25000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: ctl.signal });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: r.status, body };
  } finally { clearTimeout(timer); }
}

export function bgpState(cur, hist) {
  const base = median(hist.map((h) => h[1]).filter(Boolean));
  const ratio = cur.total ? cur.seen / cur.total : 1;
  const drop = base ? cur.prefixes / base : 1;
  if (ratio < 0.5 || drop < 0.5) return 'crit';
  if (ratio < 0.9 || drop < 0.9) return 'warn';
  return 'ok';
}

export async function readBgp(prev, now = Date.now(), get = getJson) {
  if (fresh(prev, now)) return prev;
  const out = { ok: false, source: 'RIPEstat', asn: ASN, fetched: new Date(now).toISOString(), hist: Array.isArray(prev?.hist) ? prev.hist.slice(-MAX_HIST) : [] };
  const t0 = Date.now();
  try {
    const r = await get(`https://stat.ripe.net/data/routing-status/data.json?resource=AS${ASN}&sourceapp=azureme-pulse`);
    const d = r.body?.data;
    const v4 = d?.visibility?.v4;
    if (r.status !== 200 || !v4) throw new Error(`HTTP ${r.status}`);
    out.v4 = { seen: Number(v4.ris_peers_seeing) || 0, total: Number(v4.total_ris_peers) || 0, prefixes: Number(d.announced_space?.v4?.prefixes) || 0 };
    const v6 = d.visibility?.v6;
    if (v6) out.v6 = { seen: Number(v6.ris_peers_seeing) || 0, total: Number(v6.total_ris_peers) || 0, prefixes: Number(d.announced_space?.v6?.prefixes) || 0 };
    out.state = bgpState(out.v4, out.hist);
    out.hist.push([Math.floor(now / 60000), out.v4.prefixes, out.v4.total ? Math.round((out.v4.seen / out.v4.total) * 1000) / 10 : 0]);
    out.hist = out.hist.slice(-MAX_HIST);
    out.ok = true;
  } catch (e) {
    out.error = `${String(e.message || e).slice(0, 120)} (${Date.now() - t0} ms)`;
    if (prev?.v4) { out.v4 = prev.v4; out.v6 = prev.v6; out.state = prev.state; out.staleSince = prev.staleSince || prev.fetched; }
  }
  return out;
}

// Latest complete value compared with the lowest value of the preceding day: robust against the daily cycle.
export function radarState(values) {
  if (values.length < 12) return { state: 'ok', dev: null };
  const cur = values[values.length - 2];
  const before = values.slice(0, -2);
  const min = Math.min(...before);
  const med = median(before);
  const dev = med ? Math.round((cur / med - 1) * 100) : null;
  const state = min > 0 && cur < min * 0.4 ? 'crit' : min > 0 && cur < min * 0.7 ? 'warn' : 'ok';
  return { state, dev };
}

// Weekly baseline: the last complete hour compared with the same hour one week earlier (traffic follows
// a daily and weekly cycle). Falls back to the same hour on previous days when the series is shorter.
export function radarWeekly(timestamps, values) {
  const pts = timestamps.map((t, i) => [Date.parse(t), Number(values[i])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 26) return null;
  const [ct, cur] = pts[pts.length - 2];
  const H = 3600000;
  const near = (t) => pts.filter((p) => Math.abs(p[0] - t) <= H).map((p) => p[1]);
  let ref = near(ct - 168 * H);
  let basis = 'week';
  if (!ref.length) {
    basis = 'days';
    ref = [];
    for (let d = 1; d <= 13; d += 1) { const v = pts.find((p) => p[0] === ct - d * 24 * H); if (v) ref.push(v[1]); }
    if (ref.length < 2) return null;
  }
  const base = basis === 'week' ? ref.reduce((a, b) => a + b, 0) / ref.length : median(ref);
  if (!(base > 0)) return null;
  const ratio = Math.round((cur / base) * 100);
  return { ratio, basis, at: new Date(ct).toISOString(), state: ratio < 40 ? 'crit' : ratio < 70 ? 'warn' : 'ok' };
}

export async function readRadar(prev, now = Date.now(), get = getJson, token = process.env.PULSE_CF_TOKEN) {
  if (!token) return { configured: false };
  if (fresh(prev, now) && prev.configured) return prev;
  const out = { configured: true, ok: false, source: 'Cloudflare Radar', asn: ASN, fetched: new Date(now).toISOString() };
  try {
    const r = await get(`https://api.cloudflare.com/client/v4/radar/netflows/timeseries?asn=${ASN}&dateRange=1d&aggInterval=15m&format=json`, { authorization: `Bearer ${token}` });
    const res = r.body?.result;
    const serie = res && Object.values(res).find((v) => v && Array.isArray(v.timestamps) && Array.isArray(v.values));
    if (r.status !== 200 || !serie) throw new Error(`HTTP ${r.status}${r.body?.errors?.[0]?.message ? ` ${String(r.body.errors[0].message).slice(0, 80)}` : ''}`);
    const values = serie.values.map(Number).filter((v) => Number.isFinite(v));
    out.values = values.slice(-MAX_HIST).map((v) => Math.round(v * 10000) / 10000);
    out.from = serie.timestamps[Math.max(0, serie.timestamps.length - out.values.length)];
    out.to = serie.timestamps[serie.timestamps.length - 1];
    Object.assign(out, radarState(values));
    out.ok = true;
    try {
      const w = await get(`https://api.cloudflare.com/client/v4/radar/netflows/timeseries?asn=${ASN}&dateRange=14d&aggInterval=1h&format=json`, { authorization: `Bearer ${token}` });
      const ws = w.body?.result && Object.values(w.body.result).find((v) => v && Array.isArray(v.timestamps) && Array.isArray(v.values));
      if (w.status !== 200 || !ws) throw new Error(`HTTP ${w.status}`);
      const wk = radarWeekly(ws.timestamps, ws.values);
      if (wk) {
        out.week = wk;
        const rank = { ok: 0, warn: 1, crit: 2 };
        if (rank[wk.state] > rank[out.state]) out.state = wk.state;
      }
    } catch (e) {
      out.weekError = String(e.message || e).slice(0, 80);
    }
  } catch (e) {
    out.error = String(e.message || e).slice(0, 160);
    if (prev?.values) { out.values = prev.values; out.from = prev.from; out.to = prev.to; out.state = prev.state; out.dev = prev.dev; out.staleSince = prev.staleSince || prev.fetched; }
  }
  return out;
}

// RIPE Atlas (no key): the public "well-known target" ping to www.office.com, measured every 4 minutes by
// thousands of probes. Only the anchors (about a thousand stable probes in many countries) are read.
export const ATLAS_MSM = 177421582;
const ATLAS = 'https://atlas.ripe.net/api/v2';

export function atlasState(reach, hist) {
  const base = median(hist.map((h) => h[1]).filter((v) => v > 0));
  if (!base) return 'ok';
  if (reach < base - 20) return 'crit';
  if (reach < base - 5) return 'warn';
  return 'ok';
}

export function atlasSummary(results, cc, nowSec) {
  const by = new Map();
  for (const r of results) {
    if (!r || typeof r.prb_id !== 'number' || !(nowSec - r.timestamp < 1800)) continue;
    const prevR = by.get(r.prb_id);
    if (!prevR || prevR.timestamp < r.timestamp) by.set(r.prb_id, r);
  }
  const countries = new Map();
  const rtts = [];
  let ok = 0;
  for (const [id, r] of by) {
    const up = Number(r.rcvd) > 0;
    if (up) { ok += 1; if (r.avg > 0) rtts.push(r.avg); }
    const c = cc.get(id) || '??';
    const e = countries.get(c) || { n: 0, ok: 0, ms: [] };
    e.n += 1; if (up) { e.ok += 1; if (r.avg > 0) e.ms.push(r.avg); }
    countries.set(c, e);
  }
  const n = by.size;
  const pl = countries.get('PL');
  const bad = [...countries].filter(([c, e]) => c !== '??' && e.n >= 3 && e.ok / e.n < 0.6).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n).slice(0, 8).map(([c, e]) => [c, e.n, e.ok]);
  return { n, okCount: ok, reach: n ? Math.round((ok / n) * 1000) / 10 : 0, med: Math.round(median(rtts) * 10) / 10, countries: countries.size, pl: pl ? { n: pl.n, ok: pl.ok, med: Math.round(median(pl.ms) * 10) / 10 } : null, bad };
}

export async function readAtlas(prev, now = Date.now(), get = getJson) {
  if (fresh(prev, now)) return prev;
  const out = { ok: false, source: 'RIPE Atlas', msm: ATLAS_MSM, target: 'www.office.com', fetched: new Date(now).toISOString(), hist: Array.isArray(prev?.hist) ? prev.hist.slice(-MAX_HIST) : [] };
  const t0 = Date.now();
  try {
    const cc = new Map();
    let url = `${ATLAS}/probes/?is_anchor=true&status=1&fields=id,country_code&page_size=500`;
    for (let page = 0; url && page < 4; page += 1) {
      const r = await get(url);
      if (r.status !== 200 || !Array.isArray(r.body?.results)) throw new Error(`probes HTTP ${r.status}`);
      for (const p of r.body.results) cc.set(p.id, p.country_code || '??');
      url = r.body.next || null;
    }
    const ids = [...cc.keys()];
    if (ids.length < 50) throw new Error(`only ${ids.length} anchors listed`);
    const chunks = [];
    for (let k = 0; k < ids.length; k += 350) chunks.push(ids.slice(k, k + 350));
    const parts = await Promise.all(chunks.map((c) => get(`${ATLAS}/measurements/${ATLAS_MSM}/latest/?probe_ids=${c.join(',')}`)));
    const results = [];
    for (const r of parts) {
      if (r.status !== 200) throw new Error(`latest HTTP ${r.status}`);
      const list = Array.isArray(r.body) ? r.body : Array.isArray(r.body?.results) ? r.body.results : [];
      for (const x of list) results.push(Array.isArray(x) ? x[0] : x);
    }
    const sum = atlasSummary(results, cc, Math.floor(now / 1000));
    if (sum.n < 50) throw new Error(`only ${sum.n} recent results`);
    Object.assign(out, sum);
    out.state = atlasState(sum.reach, out.hist);
    out.hist.push([Math.floor(now / 60000), sum.reach, sum.med]);
    out.hist = out.hist.slice(-MAX_HIST);
    out.ok = true;
  } catch (e) {
    out.error = `${String(e.message || e).slice(0, 120)} (${Date.now() - t0} ms)`;
    if (prev?.n) { for (const k of ['n', 'okCount', 'reach', 'med', 'countries', 'pl', 'bad', 'state']) out[k] = prev[k]; out.staleSince = prev.staleSince || prev.fetched; }
  }
  return out;
}

const WORD = { ok: 'bez odchyleń', warn: 'odchylenie', crit: 'duże odchylenie' };
export function signalEvents(prev, next) {
  const ev = [];
  for (const [key, name] of [['bgp', `Trasy BGP sieci Microsoft (AS${ASN})`], ['radar', `Ruch sieci Microsoft w Cloudflare Radar (AS${ASN})`], ['atlas', 'Osiągalność www.office.com z sond RIPE Atlas']]) {
    const p = prev?.[key]?.state;
    const c = next?.[key]?.state;
    if (p && c && p !== c && next[key].ok) ev.push({ sev: c, kind: 'Sygnał zewnętrzny', title: `${name}: ${WORD[c]}`, text: `Zmiana oceny: ${WORD[p]} → ${WORD[c]}. Źródło: ${next[key].source}.` });
  }
  return ev;
}

export async function readSignals(prev, now = Date.now()) {
  const [bgp, radar, atlas] = await Promise.all([readBgp(prev?.bgp, now), readRadar(prev?.radar, now), readAtlas(prev?.atlas, now)]);
  return { bgp, radar, atlas };
}
