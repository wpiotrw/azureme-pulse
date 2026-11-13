// AzureMe Pulse: public Azure status feed (no authentication). An empty feed means no active platform-wide events.
const FEED = 'https://azure.status.microsoft/en-us/status/feed/';

export function htmlToText(html, max = 600) {
  const t = String(html || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function parseFeed(xml) {
  const tag = (s, n) => (new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(s)?.[1] || '').trim();
  const build = tag(xml.split(/<item[\s>]/i)[0], 'lastBuildDate');
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].slice(0, 10).map((m) => {
    const published = Date.parse(tag(m[0], 'pubDate'));
    const link = htmlToText(tag(m[0], 'link'), 300);
    return {
      title: htmlToText(tag(m[0], 'title'), 200),
      published: Number.isNaN(published) ? null : new Date(published).toISOString(),
      link: /^https:\/\//.test(link) ? link : '',
      summary: htmlToText(tag(m[0], 'description'), 500),
    };
  });
  const b = Date.parse(build);
  return { build: Number.isNaN(b) ? null : new Date(b).toISOString(), items };
}

export async function readAzureStatus(fetchImpl = fetch) {
  const out = { ok: false, fetched: new Date().toISOString(), build: null, items: [], error: '' };
  try {
    const r = await fetchImpl(FEED, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/rss+xml, application/xml' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    if (!/<rss[\s>]/i.test(xml)) throw new Error('odpowiedź nie jest kanałem RSS');
    Object.assign(out, parseFeed(xml), { ok: true });
  } catch (e) {
    out.error = String(e.message || e).slice(0, 120);
  }
  return out;
}
