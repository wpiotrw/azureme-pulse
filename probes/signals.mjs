// External signals about the Microsoft network, read from public services.
// - RIPEstat (no key): BGP visibility and announced prefixes of AS8075, as seen by the RIS route collectors.
// - Cloudflare Radar (token in the PULSE_CF_TOKEN secret): traffic from AS8075 observed at Cloudflare's edge.
// Both are indirect indicators. They do not measure user traffic to Microsoft 365.

const UA = 'azureme-pulse-probe/0.1 (+https://pulse.azureme.pl)';
export const ASN = 8075;
const EVERY_MIN = 14; // both sources change slowly; read them every third run
const MAX_HIST = 96;

const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fresh = (prev, now) => prev && prev.fetched && now - Date.parse(prev.fetched) < EVERY_MIN * 60000;

async function getJson(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
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
    out.error = String(e.message || e).slice(0, 120);
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
  } catch (e) {
    out.error = String(e.message || e).slice(0, 160);
    if (prev?.values) { out.values = prev.values; out.from = prev.from; out.to = prev.to; out.state = prev.state; out.dev = prev.dev; out.staleSince = prev.staleSince || prev.fetched; }
  }
  return out;
}

const WORD = { ok: 'bez odchyleń', warn: 'odchylenie', crit: 'duże odchylenie' };
export function signalEvents(prev, next) {
  const ev = [];
  for (const [key, name] of [['bgp', `Trasy BGP sieci Microsoft (AS${ASN})`], ['radar', `Ruch sieci Microsoft w Cloudflare Radar (AS${ASN})`]]) {
    const p = prev?.[key]?.state;
    const c = next?.[key]?.state;
    if (p && c && p !== c && next[key].ok) ev.push({ sev: c, kind: 'Sygnał zewnętrzny', title: `${name}: ${WORD[c]}`, text: `Zmiana oceny: ${WORD[p]} → ${WORD[c]}. Źródło: ${next[key].source}.` });
  }
  return ev;
}

export async function readSignals(prev, now = Date.now()) {
  const [bgp, radar] = await Promise.all([readBgp(prev?.bgp, now), readRadar(prev?.radar, now)]);
  return { bgp, radar };
}
