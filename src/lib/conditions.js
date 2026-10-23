'use strict';
// Condition autocomplete + reference summaries.
// Suggestions: curated list (instant) then Wikipedia search. Summaries: Wikipedia
// REST summary endpoint, cached in condition_summaries for 30 days.
const db = require('../db');
const LIST = require('./conditions-list');

const UA = 'FairyHaleKennel/1.0 (kennel management app; contact: admin)';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const CACHE_DAYS = 30;
const TIMEOUT_MS = 4000;

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const fold = (s) => norm(s).toLowerCase().replace(/[’']/g, "'");

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.json() };
  } finally { clearTimeout(t); }
}

// In-memory cache for search results (short-lived; these are cheap and transient).
const searchCache = new Map();
function remember(key, value) {
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(key, { value, at: Date.now() });
  return value;
}

/** Suggestions for an autocomplete query. */
async function suggest(q) {
  const query = fold(q);
  if (query.length < 2) return [];
  const starts = [], contains = [];
  for (const c of LIST) {
    const f = fold(c.name);
    if (f.startsWith(query)) starts.push(c);
    else if (f.includes(query) || fold(c.wiki).includes(query)) contains.push(c);
  }
  const local = [...starts, ...contains].slice(0, 8).map((c) => ({ name: c.name, wiki: c.wiki, source: 'list' }));
  if (local.length >= 6 || query.length < 3) return local;

  // Fill remaining slots from Wikipedia, excluding things we already have.
  const hit = searchCache.get(query);
  let remote = hit && Date.now() - hit.at < 10 * 60 * 1000 ? hit.value : null;
  if (!remote) {
    try {
      const url = `${WIKI_API}?action=opensearch&namespace=0&limit=8&format=json&search=${encodeURIComponent(norm(q))}`;
      const { body } = await fetchJson(url);
      remote = remember(query, Array.isArray(body) && Array.isArray(body[1]) ? body[1] : []);
    } catch { remote = []; }
  }
  const seen = new Set(local.map((c) => fold(c.wiki)).concat(local.map((c) => fold(c.name))));
  const extra = remote.filter((t) => !seen.has(fold(t))).map((t) => ({ name: t, wiki: t, source: 'wikipedia' }));
  return [...local, ...extra].slice(0, 10);
}

/** Resolve the best Wikipedia title for a free-text condition name. */
function resolveTitle(name) {
  const f = fold(name);
  const exact = LIST.find((c) => fold(c.name) === f);
  if (exact) return exact.wiki;
  const partial = LIST.find((c) => fold(c.name).startsWith(f) || f.startsWith(fold(c.name)));
  return partial ? partial.wiki : norm(name);
}

/** Summary for a condition: from cache, else Wikipedia; never throws. */
async function summary(name, wikiTitle) {
  const title = norm(wikiTitle || resolveTitle(name));
  const cached = (await db.query('SELECT * FROM condition_summaries WHERE title=$1', [title])).rows[0];
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_DAYS * 86400000 && cached.kind !== 'error') return shape(cached);

  let row = { title, display: title, extract: null, url: null, kind: 'error' };
  try {
    const { status, body } = await fetchJson(WIKI_SUMMARY + encodeURIComponent(title.replace(/ /g, '_')) + '?redirect=true');
    if (status === 404) row = { title, display: title, extract: null, url: null, kind: 'missing' };
    else if (body) {
      row = {
        title,
        display: body.title || title,
        extract: body.type === 'disambiguation' ? null : (body.extract || null),
        url: body.content_urls && body.content_urls.desktop ? body.content_urls.desktop.page : `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        kind: body.type === 'disambiguation' ? 'disambiguation' : 'standard',
      };
    }
  } catch { /* keep 'error' */ }

  if (row.kind !== 'error') {
    await db.query(
      `INSERT INTO condition_summaries (title, display, extract, url, kind, fetched_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (title) DO UPDATE SET display=EXCLUDED.display, extract=EXCLUDED.extract, url=EXCLUDED.url, kind=EXCLUDED.kind, fetched_at=now()`,
      [row.title, row.display, row.extract, row.url, row.kind]
    );
  } else if (cached) {
    return shape(cached); // stale beats nothing when Wikipedia is unreachable
  }
  return shape(row);
}

function shape(r) {
  return { title: r.display || r.title, extract: r.extract, url: r.url, kind: r.kind, source: r.extract ? 'Wikipedia' : null };
}

module.exports = { suggest, summary, resolveTitle, norm };
