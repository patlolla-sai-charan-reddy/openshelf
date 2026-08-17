#!/usr/bin/env node
// Build-time feed agent. Runs daily in GitHub Actions (see .github/workflows/feed.yml) or locally: `node scripts/build-feed.mjs`.
//   • Real source: Skimlinks / Sovrn Commerce Product API   (set SKIMLINKS_API_KEY; endpoint via SKIMLINKS_PRODUCT_API)
//   • Fallback:    the committed fixtures in /data/*.json    (no keys → demo mode; nothing is fetched)
// Runs AFTER scripts/build-catalog.mjs (the daily collector). Every candidate list goes through validate.js; invalid data is never written.
// Also refreshes agents.json (store counts, auto-registers agents for new data files) and stamps Amazon Associates tags.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { validateProducts, agentFor, patchIndex } = createRequire(import.meta.url)(join(ROOT, 'validate.js'));
const env = process.env;
const KEY = env.SKIMLINKS_API_KEY || '';
const API = env.SKIMLINKS_PRODUCT_API || 'https://api-products.skimlinks.com/query';
const AMAZON_TAG = env.AMAZON_ASSOCIATE_TAG || '';
const LIMIT = +(env.FEED_LIMIT || 100);
const DRY = process.argv.includes('--dry-run');
const MIN = +(env.FEED_MIN || 5);   // fewer valid products than this → keep the existing file instead

const readJSON = p => JSON.parse(readFileSync(p, 'utf8'));
const manifest = readJSON(join(ROOT, 'agents.json'));
const stampAmazon = url => { if (!AMAZON_TAG || !/amazon\./.test(url)) return url; const u = new URL(url); u.searchParams.set('tag', AMAZON_TAG); return u.toString(); };

// ---- Real source: Skimlinks Product API. Field names differ slightly across API versions, so map tolerantly. ----
async function fetchSkimlinks(agent) {
  const out = [];
  const q = [agent.category, ...agent.keywords.slice(0, 3)].join(' ');
  const url = `${API}?apikey=${encodeURIComponent(KEY)}&query=${encodeURIComponent(q)}&limit=${LIMIT}&location=${env.FEED_COUNTRY || 'US'}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Skimlinks ${r.status} for ${agent.category}`);
  const j = await r.json(), list = j.products || j.results || j.data || (Array.isArray(j) ? j : []);
  for (const p of list) {
    const merchant = (p.merchant && (p.merchant.name || p.merchant)) || p.merchantName || p.advertiser || '';
    out.push({
      brand: p.brand || p.manufacturer || merchant, title: p.title || p.name || '',
      price: Number(p.price?.amount ?? p.price ?? p.salePrice ?? 0), currency: (p.currency || p.price?.currency || 'USD').toUpperCase(),
      image: p.imageUrl || p.image_url || p.image || p.thumbnail || '', url: stampAmazon(p.url || p.productUrl || p.link || ''),
      merchant, category: agent.category,
      keywords: [...new Set([...(p.categories || []).map(String), ...(p.keywords || []), ...String(p.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2)])],
    });
  }
  return out;
}

// ---- Agent-discovery files that need absolute URLs (set repo variable SITE_URL, e.g. https://openshelf.example) ----
// SITE_URL env → else the origin already baked into sitemap.xml (so a bot run without the variable never regresses to the placeholder).
const prevSite = existsSync(join(ROOT, 'sitemap.xml')) ? (readFileSync(join(ROOT, 'sitemap.xml'), 'utf8').match(/<loc>(https?:\/\/[^<]*?)(?:index\.html)?<\/loc>/) || [])[1] : '';
const SITE = (env.SITE_URL || prevSite || 'https://openshelf.example').replace(/\/$/, '') + '/';
const today = new Date().toISOString().slice(0, 10);
function writeDiscovery(agents) {
  const urls = ['', 'index.html', 'search.html', 'agents.json', 'llms.txt', 'openapi.json', ...agents.map(a => `data/${a.category}.json`)];
  writeFileSync(join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` + urls.map(u => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>`).join('\n') + '\n</urlset>\n');
  writeFileSync(join(ROOT, 'robots.txt'), `# OpenShelf — the product index for AI agents. Crawling by AI agents and LLM crawlers is welcome.
User-agent: *
Allow: /

# Explicitly welcome (no special rules, listed for clarity)
User-agent: GPTBot
User-agent: ChatGPT-User
User-agent: OAI-SearchBot
User-agent: ClaudeBot
User-agent: Claude-User
User-agent: Claude-SearchBot
User-agent: anthropic-ai
User-agent: PerplexityBot
User-agent: Perplexity-User
User-agent: Google-Extended
User-agent: Googlebot
User-agent: Bingbot
User-agent: Applebot
User-agent: Applebot-Extended
User-agent: CCBot
User-agent: Amazonbot
User-agent: meta-externalagent
User-agent: DuckAssistBot
User-agent: YouBot
User-agent: cohere-ai
User-agent: Bytespider
Allow: /

Sitemap: ${SITE}sitemap.xml
# Machine-readable entry points: ${SITE}llms.txt · ${SITE}openapi.json · ${SITE}agents.json
`);
  writeFileSync(join(ROOT, 'opensearch.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>OpenShelf</ShortName>
  <LongName>OpenShelf — the product index for AI agents</LongName>
  <Description>One query, every store: products with brand, title, price, image and direct retailer URL.</Description>
  <Tags>shopping products agents AI JSON</Tags>
  <Url type="text/html" method="get" template="${SITE}search.html?q={searchTerms}"/>
  <Url type="application/json" rel="collection" template="${SITE}agents.json"/>
  <Image height="64" width="64" type="image/svg+xml">${SITE}icon.svg</Image>
  <InputEncoding>UTF-8</InputEncoding>
</OpenSearchDescription>
`);
  const product = { type: 'object', required: ['brand', 'title', 'price', 'currency', 'image', 'url', 'merchant', 'category', 'keywords'], properties: { brand: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string', example: 'USD' }, image: { type: 'string', format: 'uri' }, url: { type: 'string', format: 'uri', description: "Retailer's own product page. Append utm_source=openshelf&utm_medium=referral." }, merchant: { type: 'string' }, category: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } } };
  const openapi = { openapi: '3.1.0', info: { title: 'OpenShelf', version: today, summary: 'The product index for AI agents', description: 'Static JSON product index. Fetch agents.json for categories, then data/{category}.json for products; filter and rank locally. No authentication.' }, servers: [{ url: SITE }],
    paths: {
      '/agents.json': { get: { operationId: 'listCategories', summary: 'Category index with routing keywords', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { agents: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' }, products: { type: 'integer' }, stores: { type: 'integer' }, keywords: { type: 'array', items: { type: 'string' } } } } } } } } } } } } },
      '/data/{category}.json': { get: { operationId: 'listProducts', summary: 'All products of one category', parameters: [{ name: 'category', in: 'path', required: true, schema: { type: 'string', enum: agents.map(a => a.category) } }], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: product } } } } } } },
      '/search.html': { get: { operationId: 'searchHtml', summary: 'Ranked search rendered client-side (needs a JS runtime)', parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: 'Free text; supports "under $100", "over 50", "50-100", brand and category words' }], responses: { 200: { description: 'HTML page', content: { 'text/html': {} } } } } }
    }, components: { schemas: { Product: product } } };
  writeFileSync(join(ROOT, 'openapi.json'), JSON.stringify(openapi, null, 1) + '\n');
}

// ---- Main ----
const dataDir = join(ROOT, 'data');
const report = [];
let failures = 0;
for (const agent of manifest.agents) {
  const file = join(dataDir, `${agent.category}.json`);
  const current = existsSync(file) ? readJSON(file) : [];
  let candidate = current, source = 'fixture';
  if (KEY) {
    try { candidate = await fetchSkimlinks(agent); source = 'skimlinks'; }
    catch (e) { console.error(`FAIL ${agent.category}: ${e.message} — keeping existing file`); failures++; candidate = current; source = 'fixture(kept)'; }
  } else candidate = current.map(p => ({ ...p, url: stampAmazon(p.url) }));
  let v = validateProducts(candidate, agent.category);
  if (source === 'skimlinks' && !v.ok && v.products.length >= MIN) {   // bot can't fix rows like a human can → publish only the valid ones
    console.warn(`! ${agent.category}: dropping ${v.errors.length} invalid feed rows, keeping ${v.products.length} valid`);
    v = validateProducts(v.products, agent.category);
  }
  if (!v.ok || v.products.length < MIN) {
    console.error(`FAIL ${agent.category}: ${v.errors.length} validation errors from ${source} — NOT written`);
    v.errors.slice(0, 5).forEach(e => console.error(`    row ${e.row} ${e.field}: ${e.message}`));
    failures++; report.push({ category: agent.category, source, ok: false, written: false, errors: v.errors.length }); continue;
  }
  if (!DRY) writeFileSync(file, JSON.stringify(v.products, null, 1) + '\n');
  agent.stores = v.stats.merchants; agent.products = v.products.length;
  report.push({ category: agent.category, source, ok: true, written: !DRY, products: v.products.length, merchants: v.stats.merchants, warnings: v.warnings.length });
}
// Auto-register agents for data files that have no agent yet (e.g. a new category added to the collector spec).
for (const f of readdirSync(dataDir).filter(f => f.endsWith('.json'))) {
  const category = f.replace(/\.json$/, '');
  if (manifest.agents.some(a => a.category === category)) continue;
  const v = validateProducts(readJSON(join(dataDir, f)), category);
  if (v.ok) { manifest.agents.push(agentFor(category, v.products)); report.push({ category, source: 'auto-registered', products: v.products.length, merchants: v.stats.merchants }); }
  else { console.error(`FAIL ${f}: invalid, not registered`); failures++; }
}
if (!DRY) {
  writeFileSync(join(ROOT, 'agents.json'), JSON.stringify(manifest, null, 1) + '\n');
  const idx = join(ROOT, 'index.html');   // static category list + JSON-LD DataCatalog → no fetch, no layout shift on the landing page
  writeFileSync(idx, patchIndex(readFileSync(idx, 'utf8'), manifest.agents));
  writeDiscovery(manifest.agents);
}
console.table(report);
console.log(`${KEY ? 'source: skimlinks' : 'source: fixtures (no SKIMLINKS_API_KEY → demo mode)'}${AMAZON_TAG ? `, amazon tag ${AMAZON_TAG}` : ''}${DRY ? ', dry-run' : ''}`);
if (failures && KEY && !report.some(r => r.ok)) process.exit(1);   // every live category failed → red run
