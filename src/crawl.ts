// src/crawl.ts
import * as zlib from 'node:zlib';
import { parseStringPromise } from 'xml2js';
import cheerio from 'cheerio';

function sameOrigin(a: string, b: string) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
function isBinary(u: string) {
  return /\.(pdf|png|jpe?g|gif|webp|svg|ico|css|js|mp3|mp4|mov|zip|gz|tgz|rar|woff2?|ttf)(\?.*)?$/i.test(u);
}
function norm(u: string) {
  try { const x = new URL(u); x.hash = ''; return x.toString(); } catch { return u; }
}

export async function fetchGzAware(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip, br' } as any });
  if (!res.ok) throw new Error(`fetch ${url} ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const enc = (res.headers.get('content-encoding') || '').toLowerCase();
  if (enc.includes('gzip')) return zlib.gunzipSync(buf).toString('utf8');
  if (enc.includes('br'))   return zlib.brotliDecompressSync(buf).toString('utf8');
  return buf.toString('utf8');
}

export async function fromSitemap(sitemapUrl: string): Promise<string[]> {
  const xml = await fetchGzAware(sitemapUrl);
  const parsed = await parseStringPromise(xml);
  const urls: string[] = [];
  if (parsed?.urlset?.url) {
    for (const u of parsed.urlset.url) if (u.loc?.[0]) urls.push(u.loc[0]);
  }
  if (parsed?.sitemapindex?.sitemap) {
    for (const s of parsed.sitemapindex.sitemap) if (s.loc?.[0]) {
      const inner = await fromSitemap(s.loc[0]);
      urls.push(...inner);
    }
  }
  return Array.from(new Set(urls));
}

export async function extractReadableText(html: string, baseUrl: string): Promise<{ text: string, links: string[] }> {
  const $ = cheerio.load(html);

  // Remove boilerplate
  $('script,noscript,style,svg,nav,footer,header,form,iframe').remove();

  // Prefer main/article content
  const root = $('main,article').first().length ? $('main,article').first() : $.root();

  // Gather headings/paragraph-like blocks
  const blocks: string[] = [];
  root.find('h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  });
  const text = blocks.join('\n\n');

  // Same-origin links for crawling
  const links = new Set<string>();
  root.find('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    try {
      const abs = new URL(href, baseUrl).toString();
      if (sameOrigin(abs, baseUrl) && !isBinary(abs)) links.add(norm(abs));
    } catch {}
  });

  return { text, links: Array.from(links) };
}

export async function crawlSite(opts: {
  baseUrl: string;
  sitemapUrl?: string;
  include?: RegExp;
  exclude?: RegExp;
  maxPages?: number;
}): Promise<Array<{ url: string, text: string }>> {
  const { baseUrl } = opts;
  const max = Math.max(1, opts.maxPages ?? 50);

  const queue: string[] = [];
  const seen = new Set<string>();
  const out: Array<{ url: string, text: string }> = [];

  async function add(u: string) {
    const n = norm(u);
    if (seen.has(n)) return;
    if (opts.include && !opts.include.test(n)) return;
    if (opts.exclude && opts.exclude.test(n)) return;
    seen.add(n); queue.push(n);
  }

  // Seed from sitemap if available; fallback to baseUrl
  try {
    if (opts.sitemapUrl) {
      const urls = await fromSitemap(opts.sitemapUrl);
      for (const u of urls) if (sameOrigin(u, baseUrl) && !isBinary(u)) await add(u);
    } else {
      await add(baseUrl);
    }
  } catch {
    await add(baseUrl);
  }

  while (queue.length && out.length < max) {
    const u = queue.shift()!;
    try {
      const html = await fetchGzAware(u);
      const { text, links } = await extractReadableText(html, u);
      if (text && text.length > 200) out.push({ url: u, text });
      for (const link of links) {
        if (out.length + queue.length >= max) break;
        await add(link);
      }
    } catch {
      // skip fetch/parse issues
    }
  }

  return out;
}
