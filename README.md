# OpenShelf — the product index for AI agents

**Live:** https://patlolla-sai-charan-reddy.github.io/openshelf/ · **Repo:** https://github.com/patlolla-sai-charan-reddy/openshelf

## Project description

OpenShelf is a **self-updating product index built for AI agents, shopping bots and LLM assistants**. Instead of an agent crawling hundreds of retailer sites to answer "find me white sneakers under $100", it queries OpenShelf once and receives, for every match, `brand · title · price · currency · image · merchant · category · keywords` and the **retailer's own product URL**. The retailer handles sizes, colours, cart and checkout — OpenShelf never does.

It is a **100 % static site**: no backend, no server, no database, no accounts, **zero CSS** (layout uses only semantic HTML and HTML attributes), one ~100-line JavaScript file for the human-facing search page, and plain JSON files for machines. It deploys unchanged to GitHub Pages / Cloudflare Pages / Netlify, installs as a PWA, and can be wrapped with Capacitor.

**How it stays fresh — the daily collector.** Every morning (06:17 UTC) a GitHub Actions workflow runs two Node scripts:

1. `scripts/build-catalog.mjs` — the collector. It pulls **real products from retailers' public endpoints**: Shopify stores' `/products.json` (Everlane, Glossier, Casper, Kith, Manduka, Radio Flyer, Skullcandy, Keychron, …) and product pages' JSON-LD / og metadata (Nike, Puma, Converse, IKEA, KitchenAid, Le Creuset, Garmin, Peloton, …). A curated spec says which stores/categories to collect from; per store it takes the curated picks plus the newest matching products (`T()` entries, `COLLECT_TOP` per entry). Every image is fetched and verified (browser UA, pixel dimensions) and requested as a square from each CDN so it never distorts; colour/size variants and duplicate URLs are collapsed; if a run comes back thin for a category the previous file is kept.
2. `scripts/build-feed.mjs` — validation and publishing. Runs the same `validate.js` schema check, refreshes `agents.json` (product/store counts), rewrites the static category list + JSON-LD `DataCatalog` in `index.html`, regenerates `sitemap.xml`, `robots.txt`, `opensearch.xml`, `openapi.json`, and (optionally, if `SKIMLINKS_API_KEY` is set) merges a Skimlinks/Sovrn product feed.

The workflow commits `data/*.json` + regenerated files (`bot: daily catalog 2026-08-17 — 153 products`), GitHub Pages redeploys in ~1 minute, and every agent's next fetch sees the new catalog. Nothing to click, no dashboard.

**How agents use it.** `llms.txt` spells it out: `GET agents.json` (categories + routing keywords) → `GET data/{category}.json` → filter/rank locally → send the shopper to `url` with `utm_source=openshelf&utm_medium=referral`. There's an OpenAPI 3.1 description (`openapi.json`, `.well-known/ai-plugin.json`), an OpenSearch descriptor, JSON-LD `WebSite`/`SearchAction` + `DataCatalog`, `<link rel=alternate>`s, and a `robots.txt` that explicitly allows GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Amazonbot, Applebot-Extended, meta-externalagent and others. Humans get the same data at `search.html?q=` — a client-side intent matcher (price bounds, brands, category words) ranks the JSON in a few milliseconds and renders a 2-column card grid.

**Monetisation & tracking (client-side only).** Every outbound link carries `rel="sponsored"` and gets `utm_source=openshelf&utm_medium=referral&asid=<uuid>` per click; Plausible events `search`, `outbound_click`, `zero_results`, `agent_view` (GA4 optional); a Skimlinks/Sovrn snippet can rewrite links to affiliate links at click time.

```
index.html          landing for agents: query box, category indexes (static, generated), endpoint table, JSON-LD
search.html         human results view (JS-rendered card grid); <noscript> points agents to the JSON path
app.js              intent matcher, ranking, grid, loaders, analytics, asid stamping (~104 lines) · sw.js  service worker (15 lines)
validate.js         the one product-schema validator (Node + browser)
agents.json         category index {id,name,category,products,stores,keywords}
data/*.json         one array per category — the product catalog (real, refreshed daily)
llms.txt · openapi.json · .well-known/ai-plugin.json · opensearch.xml · robots.txt · sitemap.xml   agent-discovery layer
scripts/build-catalog.mjs   daily collector (retailer public endpoints → validated products)
scripts/build-feed.mjs      validation + agents.json/index.html/discovery regeneration (+ optional Skimlinks feed)
.github/workflows/feed.yml  daily cron + manual run
manifest.json, icon.*       PWA
```

## Run locally

```bash
python3 -m http.server 8765        # open http://localhost:8765
```
```bash
npm run daily                      # = node scripts/build-catalog.mjs && node scripts/build-feed.mjs  (what the bot does)
```
`npm run collect:dry` previews a collection without writing. No dependencies to install.

## Deploy / configure

Already deployed to GitHub Pages from `main` (root). For a fresh deploy: push the repo, Settings → Pages → Deploy from branch `main` `/`, Settings → Actions → Workflow permissions → *Read and write*. Optional repo **variables**: `SITE_URL` (deployed origin; otherwise the origin already in `sitemap.xml` is reused), `COLLECT_TOP` (extra newest products per collector entry, default 4), `AMAZON_ASSOCIATE_TAG`, `FEED_COUNTRY`; **secret** `SKIMLINKS_API_KEY` (+ variable `SKIMLINKS_PRODUCT_API`) to add a Skimlinks/Sovrn feed. To collect from more stores, add `S(...)`/`T(...)`/`O(...)` lines to the `SPEC` in `scripts/build-catalog.mjs`; new categories auto-register.

Cloudflare Pages / Netlify: connect the repo, no build command, output dir `/`. The site is path-relative so it works at a domain root or under `/openshelf/`. **Do not** enable Cloudflare's "Block AI bots"/Bot Fight Mode in front of it — the whole point is to let agents in.

After deploy, three config lines in `app.js`: `plausible` (data-domain, default = hostname; '' disables), `ga4` (`G-…`), `skimlinks` (publisher id).

## For agents (discovery layer)

* `llms.txt` — plain-text instructions; `openapi.json` + `.well-known/ai-plugin.json` — machine-readable endpoints, no auth.
* `robots.txt` — AI crawlers explicitly allowed; points at `sitemap.xml`, `llms.txt`, `openapi.json`.
* `opensearch.xml` (`<link rel=search>`), JSON-LD `WebSite`+`SearchAction` and `DataCatalog` (one `Dataset` per category), `<link rel=alternate>` to JSON/OpenAPI/llms.txt, meta `audience`/OG tags. `search.html` is indexable.
* Get discovered: submit `sitemap.xml` to Google Search Console and Bing Webmaster Tools; link `llms.txt` from anywhere agents read.

## Analytics & affiliate setup

* Plausible: create the site (domain = your host), add custom-event goals `search`, `outbound_click`, `zero_results`, `agent_view`, custom props `query`, `category`, `merchant`, `brand`, `results`, `asid`.
* Sovrn Commerce (Skimlinks): sign up, add the domain, put the publisher id in `CFG.skimlinks`; ask for Product API access → `SKIMLINKS_API_KEY`.
* Amazon Associates: tag → `AMAZON_ASSOCIATE_TAG` (stamped on any Amazon URL the bot writes).
* Keep the FTC disclosure (footer of `index.html`, header of `search.html`) and `rel="sponsored"` (generated).

## PWA & Capacitor

`manifest.json` + `sw.js` (shell precache, stale-while-revalidate with `no-cache` revalidation for all same-origin GETs incl. `data/*.json`; cross-origin always network).

```bash
mkdir openshelf-app && cd openshelf-app && npm init -y && npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npx cap init "OpenShelf" com.yourco.openshelf --web-dir www && mkdir www && echo '<meta http-equiv="refresh" content="0;url=https://patlolla-sai-charan-reddy.github.io/openshelf/">' > www/index.html
```
`capacitor.config.json` → `"server": { "url": "https://patlolla-sai-charan-reddy.github.io/openshelf/" }`, then `npx cap add ios && npx cap add android`, `npx cap open ios` (Xcode → Archive) / `npx cap open android` (Android Studio → signed bundle). Store checklist: name/description (agents search stores; purchases happen at the retailer; affiliate disclosure), 1024²/512² icons, screenshots, privacy policy URL (no accounts, cookieless analytics), App Store guideline 3.1.1 note (purchases in browser at retailer), category Shopping.

## Constraints kept

Zero CSS · zero backend · public JS = 104 + 15 lines ≤ 150 · first load ≈ 20 KB (no images) · Lighthouse mobile Performance 100 / Accessibility 100 on landing and search · rank + render 850 products ≈ 7 ms.
