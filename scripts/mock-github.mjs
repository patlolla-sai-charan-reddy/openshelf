#!/usr/bin/env node
// Mock of the GitHub REST endpoints admin.html uses (Contents GET/PUT, Commits list, workflow_dispatch).
// Dev/test only — never deployed. Usage: node scripts/mock-github.mjs [port=8766] [stateDir=<scratch>]
// Then in admin.html set "API base" to http://127.0.0.1:8766 and any non-empty token.
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.argv[2] || 8766);
const STATE = process.argv[3] || join(ROOT, '.mock-github');
if (!existsSync(STATE)) { mkdirSync(join(STATE, 'data'), { recursive: true }); cpSync(join(ROOT, 'data'), join(STATE, 'data'), { recursive: true }); cpSync(join(ROOT, 'agents.json'), join(STATE, 'agents.json')); cpSync(join(ROOT, 'index.html'), join(STATE, 'index.html')); }
const commits = [];   // {sha, path, message, date}
const sha = s => 'mock' + Buffer.from(s).toString('hex').slice(0, 36);
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS' }); res.end(body == null ? '' : JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(.*)$/);
  if (req.method === 'OPTIONS') return send(res, 204);
  if (!m) return send(res, 404, { message: 'Not Found' });
  const [, owner, repo, rest] = m, auth = req.headers.authorization;
  let body = ''; for await (const c of req) body += c; body = body ? JSON.parse(body) : {};
  console.log(req.method, u.pathname + u.search, auth ? '(auth)' : '(anon)');
  if (rest.startsWith('contents/')) {
    const path = rest.slice(9), file = join(STATE, path);
    if (req.method === 'GET') {
      if (!existsSync(file)) return send(res, 404, { message: 'Not Found' });
      const text = readFileSync(file, 'utf8');
      return send(res, 200, { path, sha: sha(text), content: Buffer.from(text).toString('base64'), encoding: 'base64' });
    }
    if (req.method === 'PUT') {
      if (!auth) return send(res, 401, { message: 'Requires authentication' });
      if (!body.message || !body.content) return send(res, 422, { message: 'Invalid request: message and content required' });
      const cur = existsSync(file) ? sha(readFileSync(file, 'utf8')) : undefined;
      if (cur && body.sha !== cur) return send(res, 409, { message: 'sha does not match' });
      mkdirSync(dirname(file), { recursive: true });
      const text = Buffer.from(body.content, 'base64').toString('utf8'); writeFileSync(file, text);
      const c = { sha: sha(text + body.message + commits.length), path, message: body.message, date: new Date().toISOString() }; commits.unshift(c);
      return send(res, cur ? 200 : 201, { content: { path, sha: sha(text) }, commit: { sha: c.sha, html_url: `https://github.com/${owner}/${repo}/commit/${c.sha}`, message: c.message } });
    }
  }
  if (rest === 'commits' && req.method === 'GET') {
    const p = u.searchParams.get('path'), list = commits.filter(c => !p || c.path === p).slice(0, +(u.searchParams.get('per_page') || 30));
    return send(res, 200, list.map(c => ({ sha: c.sha, html_url: `https://github.com/${owner}/${repo}/commit/${c.sha}`, commit: { message: c.message, committer: { date: c.date } } })));
  }
  if (rest === 'actions/workflows/feed.yml/dispatches' && req.method === 'POST') {
    if (!auth) return send(res, 401, { message: 'Requires authentication' });
    if (!body.ref) return send(res, 422, { message: 'ref required' });
    console.log('  → workflow_dispatch on', body.ref); return send(res, 204);
  }
  send(res, 404, { message: 'Not Found' });
}).listen(PORT, '127.0.0.1', () => console.log(`mock GitHub API on http://127.0.0.1:${PORT}  state=${STATE}`));
