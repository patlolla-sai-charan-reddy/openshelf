// admin.js — owner-only dashboard logic. Dependency-free. Talks only to the GitHub REST API (Contents, Commits, Actions).
// Reuses validate.js (validateProducts, agentFor) and app.js (esc, money, cell → the exact public grid).
const LS = { token: 'as_token', owner: 'as_owner', repo: 'as_repo', branch: 'as_branch', api: 'as_api' };
const el = id => document.getElementById(id);
const log = m => { el('log').innerHTML = `<small>${esc(new Date().toLocaleTimeString())} — ${m}</small>`; };
const conn = () => ({ token: localStorage.getItem(LS.token) || '', owner: el('owner').value.trim(), repo: el('repo').value.trim(), branch: el('branch').value.trim() || 'main', api: (el('api').value.trim() || 'https://api.github.com').replace(/\/$/, '') });
const b64 = s => { const bytes = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const unb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));

async function gh(path, opts = {}) {
  const c = conn(), headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) };
  if (c.token) headers.Authorization = 'Bearer ' + c.token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${c.api}/repos/${c.owner}/${c.repo}${path}`, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${j.message || r.statusText} (${path})`);
  return j;
}
const getFile = async path => { try { const j = await gh(`/contents/${path}?ref=${conn().branch}`); return { sha: j.sha, text: unb64(j.content) }; } catch (e) { if (/^404/.test(e.message)) return { sha: undefined, text: null }; throw e; } };
const putFile = (path, text, message, sha) => gh(`/contents/${path}`, { method: 'PUT', body: { message, content: b64(text), branch: conn().branch, ...(sha ? { sha } : {}) } });

// ---------- 1. Connection ----------
function loadConn() {
  for (const k of ['owner', 'repo', 'branch', 'api']) { const v = localStorage.getItem(LS[k]); if (v) el(k).value = v; }
  const t = localStorage.getItem(LS.token);
  el('conn-status').innerHTML = t ? `<small>Token stored (…${esc(t.slice(-4))}). Repo: <code>${esc(el('owner').value)}/${esc(el('repo').value)}@${esc(el('branch').value)}</code></small>` : '<small>Not connected — paste a token and Save. Read-only status still works for public repos.</small>';
}
el('conn').addEventListener('submit', e => {
  e.preventDefault();
  for (const k of ['owner', 'repo', 'branch', 'api']) localStorage.setItem(LS[k], el(k).value.trim());
  if (el('token').value.trim()) localStorage.setItem(LS.token, el('token').value.trim());
  el('token').value = ''; loadConn(); log('Connection saved.'); board();
});
el('forget').addEventListener('click', () => { localStorage.removeItem(LS.token); el('token').value = ''; loadConn(); log('Token forgotten.'); });

// ---------- 2. Upload → validate → preview → publish ----------
const pending = {};   // category → validated products
el('files').addEventListener('change', async e => {
  const box = el('uploads'); box.innerHTML = '';
  for (const file of e.target.files) {
    const category = file.name.replace(/\.json$/i, '').toLowerCase(), text = await file.text();
    const r = validateProducts(text, category);
    const sec = document.createElement('section'); sec.setAttribute('aria-label', `Upload ${file.name}`);
    let html = `<h3>${esc(file.name)} → <code>data/${esc(category)}.json</code></h3>`
      + `<p>${r.ok ? 'OK' : 'REJECTED'} — ${r.stats.input} records read · <strong>${r.stats.count}</strong> valid · ${r.stats.merchants} merchants · ${r.errors.length} errors · ${r.warnings.length} warnings${r.stats.dropped ? ` · ${r.stats.dropped} dropped` : ''}</p>`;
    if (r.errors.length || r.warnings.length) {
      html += `<details${r.errors.length ? ' open' : ''}><summary>Row-by-row report</summary><table><thead><tr><th>Row</th><th>Field</th><th>Problem</th></tr></thead><tbody>`
        + r.errors.map(x => `<tr><td>${x.row}</td><td><code>${esc(x.field)}</code></td><td>Error: ${esc(x.message)}</td></tr>`).join('')
        + r.warnings.map(x => `<tr><td>${x.row}</td><td>—</td><td>Warning: ${esc(x.message)}</td></tr>`).join('') + '</tbody></table></details>';
    }
    if (r.ok) {
      pending[category] = r.products;
      html += `<p><button type="button" data-publish="${esc(category)}">Publish data/${esc(category)}.json (${r.products.length} products)</button> <span id="pub-${esc(category)}"></span></p>`
        + `<details open><summary>Preview — first ${Math.min(10, r.products.length)} as shoppers will see them</summary><table width="100%" cellpadding="6" cellspacing="0">`;
      const first = r.products.slice(0, 10);
      for (let i = 0; i < first.length; i += 2) html += '<tr>' + cell(first[i]) + (first[i + 1] ? cell(first[i + 1]) : '<td></td>') + '</tr>';
      html += '</table></details>';
    } else html += `<p><strong>Nothing from this file will be published until every error is fixed.</strong></p>`;
    sec.innerHTML = html; box.append(sec, document.createElement('hr'));
  }
});
el('uploads').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-publish]'); if (!btn) return;
  const category = btn.dataset.publish, products = pending[category], out = el('pub-' + category);
  if (!conn().token) return out.innerHTML = '<small>Save a token first.</small>';
  btn.disabled = true; out.innerHTML = 'Publishing… <progress></progress>';
  try {
    const path = `data/${category}.json`, cur = await getFile(path);
    const res = await putFile(path, JSON.stringify(products, null, 1) + '\n', `admin: update ${category}.json (${products.length} products)`, cur.sha);
    // Auto-register / refresh the agent entry so landing + search know about it.
    const ag = await getFile('agents.json'), manifest = ag.text ? JSON.parse(ag.text) : { agents: [] };
    const merchants = new Set(products.map(p => p.merchant)).size, i = manifest.agents.findIndex(a => a.category === category);
    if (i < 0) manifest.agents.push(agentFor(category, products)); else Object.assign(manifest.agents[i], { stores: merchants, products: products.length });
    const ares = await putFile('agents.json', JSON.stringify(manifest, null, 1) + '\n', `admin: ${i < 0 ? 'register' : 'refresh'} agent for ${category} (${merchants} stores)`, ag.sha);
    const idx = await getFile('index.html');   // keep the landing page's static agent list in sync
    if (idx.text) { const patched = patchIndex(idx.text, manifest.agents); if (patched !== idx.text) await putFile('index.html', patched, `admin: sync agent list on landing (${category})`, idx.sha); }
    out.innerHTML = `Committed <a href="${esc(res.commit.html_url)}" target="_blank" rel="noopener">${esc(res.commit.sha.slice(0, 7))}</a>${i < 0 ? ` · new agent registered <a href="${esc(ares.commit.html_url)}" target="_blank" rel="noopener">${esc(ares.commit.sha.slice(0, 7))}</a>` : ''}. Live after the host redeploys (~1 min).`;
    log(`Published ${path}.`); board();
  } catch (err) { out.innerHTML = `Failed: ${esc(err.message)}`; btn.disabled = false; }
});

// ---------- 3. Status board + Run bot ----------
async function board() {
  const tb = el('board').querySelector('tbody'), c = conn();
  el('plausible').href = 'https://plausible.io/' + location.hostname;
  // Source of truth = the repo (via API) when a repo is configured; otherwise this deployed site's own files.
  const useRepo = !!(c.owner && c.repo);
  const readJSON = async path => useRepo ? JSON.parse((await getFile(path)).text) : (await fetch(path, { cache: 'no-store' })).json();
  let agents = [];
  try { agents = (await readJSON('agents.json')).agents; } catch (e) { tb.innerHTML = `<tr><td colspan="6">Could not load agents.json${useRepo ? ' from ' + esc(c.owner + '/' + c.repo) : ''}: ${esc(e.message)}</td></tr>`; return; }
  const rows = await Promise.all(agents.map(async a => {
    let count = '?', merchants = '?', when = '—', link = '';
    try { const d = await readJSON(`data/${a.category}.json`); count = d.length; merchants = new Set(d.map(p => p.merchant)).size; } catch { }
    if (useRepo) try {
      const cs = await gh(`/commits?path=data/${a.category}.json&sha=${c.branch}&per_page=1`);
      if (cs[0]) { when = new Date(cs[0].commit.committer.date).toLocaleString(); link = `<a href="${esc(cs[0].html_url)}" target="_blank" rel="noopener">${esc(cs[0].sha.slice(0, 7))}</a>`; }
    } catch (e) { when = `<small>${esc(e.message.slice(0, 40))}</small>`; }
    return `<tr><td>${esc(a.name)}</td><td><a href="search.html?q=${esc(a.category)}" target="_blank">${esc(a.category)}</a></td><td>${count}</td><td>${merchants}</td><td>${when}</td><td>${link}</td></tr>`;
  }));
  tb.innerHTML = rows.join('') || '<tr><td colspan="6">No agents yet — upload a category file.</td></tr>';
}
el('refresh').addEventListener('click', board);
el('runbot').addEventListener('click', async () => {
  const s = el('bot-status');
  if (!conn().token) return s.innerHTML = '<small>Save a token with Actions: read/write first.</small>';
  s.innerHTML = 'Dispatching… <progress></progress>';
  try { await gh('/actions/workflows/feed.yml/dispatches', { method: 'POST', body: { ref: conn().branch } });
    const c = conn(); s.innerHTML = `Bot dispatched — <a href="https://github.com/${esc(c.owner)}/${esc(c.repo)}/actions/workflows/feed.yml" target="_blank" rel="noopener">watch the run</a>.`; }
  catch (e) { s.innerHTML = `Failed: ${esc(e.message)}`; }
});

loadConn(); board();
