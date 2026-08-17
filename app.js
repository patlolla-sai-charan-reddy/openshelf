// OpenShelf — client-side product search for AI agents. Zero CSS, zero backend. Shared by index.html and search.html.
const CFG = {
  loader: 'spin',            // 'spin' | 'dots' | 'orbit'  (see LOADERS below)
  pageSize: 24,              // products per "Load more" batch
  plausible: location.hostname, // Plausible data-domain; '' disables. Localhost is skipped automatically.
  ga4: '',                   // e.g. 'G-XXXXXXX' to enable GA4 instead of / alongside Plausible
  skimlinks: '',             // e.g. '123456X1234567' → loads s.skimresources.com/js/<id>.skimlinks.js
  allowLoaderStyle: false    // OPTIONAL shimmer on loader text; the ONLY place CSS may ever appear
};
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = p => new Intl.NumberFormat('en', { style: 'currency', currency: p.currency || 'USD', minimumFractionDigits: Number.isInteger(p.price) ? 0 : 2 }).format(p.price);
const trunc = (s, n = 40) => s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
const stem = t => t.replace(/([^s])s$/, '$1');

// ---------- Analytics (all client-side; events: search, outbound_click, zero_results, agent_view) ----------
const inject = (src, data = {}) => { const s = document.createElement('script'); s.defer = true; s.src = src; Object.assign(s.dataset, data); document.head.append(s); };
window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments); };
const track = (name, props) => { window.plausible(name, { props }); window.gtag && gtag('event', name, props); };
if (CFG.plausible && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname)) inject('https://plausible.io/js/script.js', { domain: CFG.plausible });
if (CFG.ga4) { window.dataLayer = []; window.gtag = function () { dataLayer.push(arguments); }; gtag('js', new Date()); gtag('config', CFG.ga4); inject('https://www.googletagmanager.com/gtag/js?id=' + CFG.ga4); }
if (CFG.skimlinks) inject('https://s.skimresources.com/js/' + CFG.skimlinks + '.skimlinks.js');

// ---------- Loaders (Beautiful UI "Loading State" behaviour, zero CSS: JS text updates + native <progress>) ----------
const LOADERS = { spin: [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'], dots: ['Searching', 'Searching.', 'Searching..', 'Searching...'], orbit: [...'◐◓◑◒'] };
function showLoader(el, working, ready) {   // returns stop(); only ever called around real network work
  const f = LOADERS[CFG.loader] || LOADERS.spin, t0 = performance.now(); let i = 0;
  const stores = working.reduce((n, a) => n + a.stores, 0);
  el.innerHTML = `<p><span id="spin">${f[0]}</span> <strong>${working.map(a => esc(a.name)).join(', ')}</strong> searching ${stores} stores… <span id="t">0.0s</span></p>`
    + ready.map(a => `<p><strong>${esc(a.name)}</strong> ready <progress></progress></p>`).join('');
  if (CFG.allowLoaderStyle && !$('#shim')) { const st = document.createElement('style'); st.id = 'shim'; st.textContent = '#spin,#t{opacity:.6}'; document.head.append(st); }
  const a = setInterval(() => { const e = $('#spin'); e && (e.textContent = f[++i % f.length]); }, 80);
  const b = setInterval(() => { const e = $('#t'); e && (e.textContent = ((performance.now() - t0) / 1e3).toFixed(1) + 's'); }, 100);
  return () => { clearInterval(a); clearInterval(b); };
}

// ---------- Intent matcher: keywords → agents, price extraction, brand/title tokens ----------
const STOP = new Set('a an the for me i my want need buy cheap best good great nice some new with and or of to in on under below over above less than more max min between from up cost price'.split(' '));
function intent(q, agents) {
  const s = q.toLowerCase(); let min = 0, max = Infinity, m;
  if ((m = s.match(/(under|below|less than|max|up to|<)\s*\$?(\d+(?:\.\d+)?)/))) max = +m[2];
  if ((m = s.match(/(over|above|more than|min|at least|>)\s*\$?(\d+(?:\.\d+)?)/))) min = +m[2];
  if ((m = s.match(/\$?(\d+)\s*(?:-|to)\s*\$?(\d+)/))) { min = +m[1]; max = +m[2]; }
  const tokens = [...new Set(s.replace(/\$?\d+(\.\d+)?/g, ' ').split(/[^a-z0-9'&+]+/).filter(t => t && !STOP.has(t)).map(stem))];
  const hit = agents.filter(a => tokens.some(t => a.keywords.includes(t) || t === a.category || t === a.id || (a.brands || []).some(b => b.replace(/[^a-z0-9]/g, '') === t.replace(/[^a-z0-9]/g, ''))));
  const kw = Object.fromEntries(agents.map(a => [a.category, [a.category, a.id, ...a.keywords.slice(0, 2)]]));   // generic words ("shoes", "kids", "skincare") match every product of that agent
  return { q, tokens, min, max, kw, agents: hit.length ? hit : agents, targeted: hit.length > 0 };
}
function score(p, it) {
  const hay = (p.brand + ' ' + p.title + ' ' + p.keywords.join(' ')).toLowerCase(), brand = p.brand.toLowerCase();
  return it.tokens.reduce((n, t) => n + (brand === t || brand.replace(/[^a-z0-9]/g, '') === t ? 4 : p.title.toLowerCase().includes(t) ? 2 : hay.includes(t) ? 1 : 0) + (it.kw[p.category].includes(t) ? 1 : 0), 0);
}
const agentsJSON = () => fetch('agents.json').then(r => r.json()).then(j => j.agents);

// ---------- Landing ----------
async function landing() {
  const agents = await agentsJSON(), ul = $('#agents'), fp = a => `${a.id}:${a.products || 0}:${a.stores}`;   // list is pre-rendered at build; only redraw if agents.json changed
  if ([...ul.children].map(li => li.dataset.a).join() !== agents.map(fp).join())
    ul.innerHTML = agents.map(a => `<li data-a="${fp(a)}"><strong>${a.category}</strong> — ${esc(a.name)}: ${a.products || 0} products across ${a.stores} stores · <a href="data/${a.category}.json">JSON</a> · <a href="search.html?q=${a.category}">search</a> <progress value="1" max="1">ready</progress></li>`).join('');
  track('agent_view', { agents: agents.map(a => a.id).join(',') });
}

// ---------- Search ----------
// One product card: image on top, brand / title / price centred beneath. Layout via HTML attributes only (width/align/valign), zero CSS.
const cell = p => `<td width="50%" align="center" valign="top"><a href="${esc(p.url)}" rel="sponsored noopener" target="_blank" data-m="${esc(p.merchant)}" data-b="${esc(p.brand)}" data-p="${p.price}" data-c="${p.category}">`
  + `<img src="${esc(p.image)}" width="160" height="160" loading="lazy" alt="${esc(p.brand + ' ' + p.title)}"><br><strong>${esc(p.brand)}</strong><br><small>${esc(trunc(p.title))}</small><br><b>${money(p)}</b></a></td>`;
const grid = () => { const t = document.createElement('table'); t.width = '100%'; t.cellPadding = '6'; t.cellSpacing = '0'; return t; };
async function search() {
  const q = (new URLSearchParams(location.search).get('q') || '').trim(), status = $('#status'), out = $('#results');
  $('#q').value = q; document.title = (q || 'Search') + ' — OpenShelf';
  const agents = await agentsJSON(), it = intent(q, agents);
  if (!q) {   // no query → don't fetch every category file; list the indexes instead
    status.innerHTML = `<p>${agents.reduce((n, a) => n + (a.products || 0), 0)} products in ${agents.length} indexes. Type a query, or open an index:</p>`;
    out.innerHTML = '<ul>' + agents.map(a => `<li><a href="search.html?q=${a.category}">${a.category}</a> — ${a.products || 0} products, ${a.stores} stores · <a href="data/${a.category}.json">JSON</a></li>`).join('') + '</ul>'; return;
  }
  const stop = showLoader(status, it.agents, agents.filter(a => !it.agents.includes(a)));   // real work starts…
  const lists = await Promise.all(it.agents.map(a => fetch(`data/${a.category}.json`).then(r => r.json()).catch(() => [])));
  stop();                                                                                    // …and ends here.
  const all = lists.flat(), stores = new Set(all.map(p => p.merchant)).size, n = it.agents.length;
  const hits = all.map(p => [score(p, it), p]).filter(([s, p]) => p.price >= it.min && p.price <= it.max && (s > 0 || !it.tokens.length))
    .sort((a, b) => b[0] - a[0] || a[1].price - b[1].price).map(x => x[1]);
  status.innerHTML = `<p>${n} index${n > 1 ? 'es' : ''} searched, ${stores} stores, ${all.length} products — <strong>${hits.length}</strong> match${hits.length === 1 ? '' : 'es'}${q ? ` for “${esc(q)}”` : ''}. <small>Raw JSON: ${it.agents.map(a => `<a href="data/${a.category}.json">${a.category}</a>`).join(', ')}</small></p>`;
  track(hits.length ? 'search' : 'zero_results', { query: q, category: it.agents.map(a => a.category).join(','), results: hits.length });
  if (!hits.length) {
    out.innerHTML = `<p>No matches${it.max < Infinity || it.min ? ' in that price range' : ''}. Try a category index instead:</p><ul>`
      + agents.map(a => `<li><a href="search.html?q=${a.category}">${a.category}</a> — ${esc(a.name)}, ${a.products || 0} products</li>`).join('') + '</ul>';
    return;
  }
  const table = grid(), more = document.createElement('p'); let shown = 0;
  out.replaceChildren(table, more);
  const page = () => {
    let html = '';
    for (const end = Math.min(shown + CFG.pageSize, hits.length); shown < end; shown += 2) html += '<tr>' + cell(hits[shown]) + (hits[shown + 1] && shown + 1 < end ? cell(hits[shown + 1]) : '<td></td>') + '</tr>';
    table.insertAdjacentHTML('beforeend', html); shown = Math.min(shown, hits.length);
    more.innerHTML = shown < hits.length ? `<a href="#more" id="more">Load ${Math.min(CFG.pageSize, hits.length - shown)} more (${hits.length - shown} left)</a>` : `<small>Showing all ${hits.length}.</small>`; more.align = 'center';
  };
  more.addEventListener('click', e => { e.preventDefault(); page(); });
  page();
  // Per-click asid + UTM stamping. mousedown fires before affiliate scripts rewrite the href; click covers keyboard.
  const stamp = a => { if (!a.dataset.asid) { a.dataset.asid = crypto.randomUUID(); const u = new URL(a.href); u.searchParams.set('utm_source', 'openshelf'); u.searchParams.set('utm_medium', 'referral'); u.searchParams.set('asid', a.dataset.asid); a.href = u; } return a.dataset.asid; };
  out.addEventListener('mousedown', e => { const a = e.target.closest('a[rel]'); a && stamp(a); });
  out.addEventListener('click', e => { const a = e.target.closest('a[rel]'); if (!a) return; const asid = stamp(a);
    track('outbound_click', { merchant: a.dataset.m, brand: a.dataset.b, price: +a.dataset.p, category: a.dataset.c, asid }); delete a.dataset.asid; });
}

// ---------- Boot ----------
if ($('#agents')) landing(); else if ($('#results')) search();
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
