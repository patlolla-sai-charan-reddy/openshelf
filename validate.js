// validate.js — the ONE product-schema validator, shared by admin.html (browser) and the GitHub Action (Node).
// Browser: <script src="validate.js"> exposes window.validateProducts. Node: require('./validate.js').validateProducts.
// Anything this rejects can never be published, by a human or by the bot.
(function (root) {
  const FIELDS = { brand: 'string', title: 'string', price: 'number', currency: 'string', image: 'string', url: 'string', merchant: 'string', category: 'string', keywords: 'array' };
  const isHttp = s => { try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
  const clean = s => String(s).replace(/\s+/g, ' ').trim();

  // validateProducts(input, category) → { ok, products, errors:[{row,field,message}], warnings:[{row,message}], stats }
  // `input` may be a JSON string or an already-parsed array. `category` is the target file name (e.g. "shoes").
  function validateProducts(input, category) {
    const errors = [], warnings = [], products = [], seen = new Map();
    let list = input;
    if (typeof input === 'string') { try { list = JSON.parse(input); } catch (e) { return fail(`Not valid JSON: ${e.message}`); } }
    if (list && !Array.isArray(list) && Array.isArray(list.products)) list = list.products;   // tolerate {products:[...]}
    if (!Array.isArray(list)) return fail('Top level must be a JSON array of products');
    if (!/^[a-z0-9-]+$/.test(category || '')) return fail(`Category "${category}" must be lowercase letters, digits or dashes (it becomes data/<category>.json)`);
    list.forEach((raw, i) => {
      const row = i + 1, err = (field, message) => errors.push({ row, field, message });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return err('*', 'Record is not an object');
      const p = {};
      for (const [f, type] of Object.entries(FIELDS)) {
        const v = raw[f];
        if (type === 'array') { if (v == null) p[f] = []; else if (Array.isArray(v) && v.every(k => typeof k === 'string')) p[f] = v; else err(f, 'must be an array of strings'); }
        else if (type === 'number') { const n = typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : v; if (typeof n !== 'number' || !isFinite(n) || n <= 0) err(f, 'missing or not a positive number'); else p[f] = Math.round(n * 100) / 100; }
        else if (typeof v !== 'string' || !clean(v)) { if (f === 'category') p[f] = category; else err(f, 'missing or empty'); }
        else p[f] = clean(v);
      }
      if (p.currency && !/^[A-Z]{3}$/.test(p.currency)) err('currency', 'must be a 3-letter ISO code like USD');
      if (p.url && !isHttp(p.url)) err('url', 'must be an absolute http(s) URL');
      if (p.image && !isHttp(p.image)) err('image', 'must be an absolute http(s) URL');
      if (p.category && p.category !== category) err('category', `is "${p.category}" but this file is "${category}"`);
      if (p.title && p.title.length > 120) warnings.push({ row, message: 'title longer than 120 chars will be truncated in the grid' });
      if (p.keywords && !p.keywords.length) { p.keywords = clean(p.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2); warnings.push({ row, message: 'no keywords — derived from title' }); }
      if (p.url && seen.has(p.url)) { warnings.push({ row, message: `duplicate url of row ${seen.get(p.url)} — dropped` }); return; }
      if (errors.some(e => e.row === row)) return;
      seen.set(p.url, row);
      products.push({ brand: p.brand, title: p.title, price: p.price, currency: p.currency, image: p.image, url: p.url, merchant: p.merchant, category: p.category, keywords: [...new Set(p.keywords.map(k => k.toLowerCase()))] });
    });
    if (!list.length) errors.push({ row: 0, field: '*', message: 'File contains zero products' });
    const merchants = new Set(products.map(p => p.merchant)).size;
    return { ok: errors.length === 0, products, errors, warnings, stats: { input: list.length, count: products.length, merchants, dropped: list.length - products.length } };
    function fail(message) { return { ok: false, products: [], errors: [{ row: 0, field: '*', message }], warnings: [], stats: { input: 0, count: 0, merchants: 0, dropped: 0 } }; }
  }

  // Display name for a brand-new category so agents.json can auto-register it.
  function agentFor(category, products) {
    const name = category.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const kw = [...new Set([category, category.replace(/s$/, ''), ...products.flatMap(p => p.keywords)])].filter(k => k.length > 2).slice(0, 25);
    return { id: category, name: `${name} Index`, category, products: products.length, stores: new Set(products.map(p => p.merchant)).size, keywords: kw };
  }

  // Landing-page <li> for one agent + the JSON-LD DataCatalog block; used by the feed agent and admin.html to keep index.html in sync with agents.json.
  const agentLI = a => `<li data-a="${a.id}:${a.products || 0}:${a.stores}"><strong>${a.category}</strong> — ${a.name}: ${a.products || 0} products across ${a.stores} stores · <a href="data/${a.category}.json">JSON</a> · <a href="search.html?q=${a.category}">search</a> <progress value="1" max="1">ready</progress></li>`;
  const jsonLD = agents => '<script type="application/ld+json">\n' + JSON.stringify({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebSite', name: 'OpenShelf', alternateName: 'OpenShelf product index for AI agents', url: './', description: 'Product search index built for AI agents: one query returns brand, title, price, image and retailer URL across dozens of stores, as HTML or JSON.', audience: { '@type': 'Audience', audienceType: 'AI agents, shopping bots, LLM assistants' }, potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: 'search.html?q={search_term_string}' }, 'query-input': 'required name=search_term_string' } },
    { '@type': 'DataCatalog', name: 'OpenShelf catalog', url: 'agents.json', description: 'One JSON file per category, each an array of {brand,title,price,currency,image,url,merchant,category,keywords}.', isAccessibleForFree: true,
      dataset: agents.map(a => ({ '@type': 'Dataset', name: a.category, description: `${a.products || 0} products from ${a.stores} stores`, isAccessibleForFree: true, distribution: { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `data/${a.category}.json` } })) } ] }) + '\n</script>';
  const patchIndex = (html, agents) => html
    .replace(/(<!-- agents:start -->)[\s\S]*?(<!-- agents:end -->)/, `$1\n${agents.map(agentLI).join('\n')}\n$2`)
    .replace(/(<!-- jsonld:start -->)[\s\S]*?(<!-- jsonld:end -->)/, `$1\n${jsonLD(agents)}\n$2`);

  const api = { validateProducts, agentFor, agentLI, jsonLD, patchIndex, FIELDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this);
