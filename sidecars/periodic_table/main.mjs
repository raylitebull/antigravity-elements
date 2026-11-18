/**
 * Elements sidecar backend.
 *
 * Serves the periodic-table UI and three small routes:
 *   GET  /api/models  live model list from the language server
 *                     (GetCascadeModelConfigData, read-only) plus the
 *                     model the app last used for new chats.
 *   POST /api/start   starts a new conversation pinned to a model through
 *                     the official agentapi (`new-conversation --model`).
 *   POST /api/aa-key  saves or clears the user's Artificial Analysis key.
 *
 * It never writes the app's state or config. The only file it writes is its
 * own data dir (ANTIGRAVITY_EXECUTABLE_DATA_DIR): the AA key and a cache.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'application/javascript'],
  '/elements.js': ['elements.js', 'application/javascript'],
  '/pricing.json': ['pricing.json', 'application/json'],
  '/styles.css': ['styles.css', 'text/css'],
};

function lsBase() {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS || 'localhost:5387';
  return /^https?:\/\//.test(addr) ? addr.replace(/\/$/, '') : `http://${addr}`;
}

async function lsCall(method, body = {}) {
  const res = await fetch(`${lsBase()}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': process.env.ANTIGRAVITY_CSRF_TOKEN || '',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// ---------- pricing ----------
// Live list prices come from OpenRouter's public, keyless model list. If it
// can't be reached, the bundled pricing.json is used instead.
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';
const PRICE_TTL_MS = 6 * 60 * 60 * 1000;
let priceCache = null; // { at, source, entries: [{ key, input, output, id }] }

const normName = (s) => String(s).toLowerCase().replace(/^[a-z ]+:\s*/, '').replace(/[^a-z0-9.]+/g, ' ').trim();

function fallbackPrices() {
  try {
    const f = JSON.parse(readFileSync(join(__dirname, 'pricing.json'), 'utf-8'));
    return {
      at: Date.now(),
      source: `bundled pricing.json (${f.asOf})`,
      entries: (f.models || []).map((m) => ({ key: normName(m.match), input: m.input, output: m.output, id: null })),
    };
  } catch {
    return { at: Date.now(), source: 'none', entries: [] };
  }
}

async function prices() {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache;
  try {
    const res = await fetch(OPENROUTER_MODELS, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = await res.json();
    const entries = [];
    for (const m of data || []) {
      if (!m?.id || m.id.includes(':')) continue; // skip :batch, :free, ... variants
      const input = Number(m.pricing?.prompt) * 1e6;
      const output = Number(m.pricing?.completion) * 1e6;
      if (!(output > 0)) continue;
      entries.push({ key: normName(m.name || m.id), input: +input.toFixed(4), output: +output.toFixed(4), id: m.id });
    }
    if (!entries.length) throw new Error('empty list');
    priceCache = { at: Date.now(), source: 'OpenRouter', entries };
  } catch {
    // Keep the last good live list if there is one; retry in 10 minutes.
    priceCache = priceCache && priceCache.source === 'OpenRouter'
      ? { ...priceCache, at: Date.now() - PRICE_TTL_MS + 10 * 60 * 1000 }
      : { ...fallbackPrices(), at: Date.now() - PRICE_TTL_MS + 10 * 60 * 1000 };
  }
  return priceCache;
}

// ---------- benchmarks (Artificial Analysis) ----------
// Free-tier endpoint; needs the user's own key. 100 requests/day, so results
// are cached on disk for 12 h and survive sidecar restarts.
// ELEMENTS_AA_URL lets development point this at a local fixture server.
const AA_URL = process.env.ELEMENTS_AA_URL || 'https://artificialanalysis.ai/api/v2/language/models/free';
const AA_TTL_MS = 12 * 60 * 60 * 1000;
const AA_RETRY_MS = 30 * 60 * 1000;

function dataDir() {
  const d = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(__dirname, '.data');
  try { mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
const keyFile = () => join(dataDir(), 'aa_key.txt');
const aaCacheFile = () => join(dataDir(), 'aa_cache.json');

function aaKey() {
  if (process.env.AA_API_KEY) return process.env.AA_API_KEY.trim();
  try { return readFileSync(keyFile(), 'utf-8').trim() || null; } catch { return null; }
}

let aaMem = null; // { at, ok, error, version, entries: [{ name, key, family, effort, index, tps }] }
try { aaMem = JSON.parse(readFileSync(aaCacheFile(), 'utf-8')); } catch {}

function aaEntries(rows) {
  return rows.map((m) => {
    const name = String(m.name || '');
    const effort = (/\(([^)]*)\)\s*$/.exec(name)?.[1] || '').toLowerCase();
    return {
      name,
      key: normName(name),
      family: normName(name.replace(/\s*\([^)]*\)\s*$/, '')),
      effort,
      index: typeof m.evaluations?.artificial_analysis_intelligence_index === 'number' ? m.evaluations.artificial_analysis_intelligence_index : null,
      tps: m.performance_v3?.mean_output_tokens_per_second ?? null,
    };
  }).filter((e) => e.index !== null);
}

async function aaFetch(key) {
  const rows = [];
  let version = null;
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${AA_URL}?page=${page}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) throw new Error('Artificial Analysis rejected the key.');
    if (res.status === 429) throw new Error('Artificial Analysis daily limit reached; cached scores are shown.');
    if (!res.ok) throw new Error(`Artificial Analysis error ${res.status}.`);
    const body = await res.json();
    version = body.intelligence_index_version ?? version;
    rows.push(...(body.data || []));
    if (!body.pagination?.has_more) break;
  }
  return { version, entries: aaEntries(rows) };
}

async function benchmarks({ force = false } = {}) {
  const key = aaKey();
  if (!key) return { configured: false };
  const fresh = aaMem && aaMem.ok && Date.now() - aaMem.at < AA_TTL_MS;
  const backoff = aaMem && !aaMem.ok && Date.now() - aaMem.at < AA_RETRY_MS;
  if (!force && (fresh || backoff)) return { configured: true, ...aaMem };
  try {
    const { version, entries } = await aaFetch(key);
    aaMem = { at: Date.now(), ok: true, error: null, version, entries };
  } catch (err) {
    // Keep the last good scores; remember the error so we don't hammer the API.
    aaMem = { ...(aaMem || { entries: [], version: null }), at: Date.now(), ok: false, error: String(err.message || err) };
  }
  try { writeFileSync(aaCacheFile(), JSON.stringify(aaMem)); } catch {}
  return { configured: true, ...aaMem };
}

const EFFORT_ALIASES = { xhigh: ['xhigh', 'max', 'extra high'], high: ['high'], medium: ['medium'], low: ['low', 'minimal'] };

// Best Artificial Analysis entry for an Antigravity label: same family and
// effort if AA lists one, else the family's best score.
function benchFor(label, table) {
  if (!table?.entries?.length) return null;
  const family = normName(String(label).replace(/\s*\([^)]*\)\s*$/, ''));
  const effort = (/\(([^)]*)\)\s*$/.exec(label)?.[1] || '').toLowerCase();
  const fam = table.entries.filter((e) => e.family === family);
  if (!fam.length) return null;
  const aliases = EFFORT_ALIASES[effort] || (effort ? [effort] : []);
  // Compare whole words so "High" never matches an "XHigh" entry.
  const words = (s) => s.split(/[^a-z]+/).filter(Boolean);
  const exact = (!effort && fam.find((e) => !e.effort))
    || fam.find((e) => aliases.includes(e.effort))
    || fam.find((e) => aliases.some((a) => words(e.effort).includes(a)));
  const best = fam.reduce((a, b) => (b.index > a.index ? b : a));
  return { exact: exact || null, best };
}

// "Gemini 4 Argon (High)" -> the price of "Gemini 4 Argon".
function priceFor(label, table) {
  const family = normName(String(label).replace(/\s*\([^)]*\)\s*$/, ''));
  return table.entries.find((e) => e.key === family) || null;
}

// The app data dir holds antigravity_state.pbtxt. A sidecar's data dir sits
// a few levels below it (<appData>/sidecar_data/<plugin>/<sidecar>/data).
function appDataDir() {
  let d = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  for (let i = 0; d && i < 6; i++) {
    if (existsSync(join(d, 'antigravity_state.pbtxt'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  const fallback = join(homedir(), '.gemini', 'antigravity');
  return existsSync(fallback) ? fallback : null;
}

function lastSelectedModel() {
  const dir = appDataDir();
  if (!dir) return null;
  try {
    const txt = readFileSync(join(dir, 'antigravity_state.pbtxt'), 'utf-8');
    const m = /last_selected_agent_model:\s*([A-Z0-9_]+)/.exec(txt);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// agentapi takes model ids shaped like its own example,
// "Gemini 3.8 Flash (High)" -> "gemini-3.8-flash-high".
export function modelIdFromLabel(label) {
  return String(label)
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .trim()
    .split(/\s+/)
    .join('-');
}

function findConversationId(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^(conversation_?id|cascade_?id|id)$/i.test(k) && /^[0-9a-f-]{8,}$/i.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    const hit = findConversationId(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const app = new SidecarApp();

for (const [route, [file, type]] of Object.entries(STATIC)) {
  app.page(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type }));
}

app.api('/api/models', async () => {
  try {
    const [data, avail, priceTable, bench] = await Promise.all([
      lsCall('GetCascadeModelConfigData'),
      // Extra per-model facts (thinking level, token limits). Optional.
      lsCall('GetAvailableModels').catch(() => null),
      prices(),
      benchmarks().catch((err) => ({ configured: true, ok: false, error: String(err.message || err), entries: [] })),
    ]);
    const facts = new Map();
    for (const m of Object.values(avail?.response?.models || {})) {
      if (m?.model && !facts.has(m.model)) facts.set(m.model, m);
    }
    const models = (data.clientModelConfigs || []).map((m) => {
      const model = m.modelOrAlias?.model || m.modelOrAlias?.alias || null;
      const f = facts.get(model) || {};
      const price = priceFor(m.label, priceTable);
      const b = benchFor(m.label, bench);
      return {
      // Score for this exact tier (if AA lists it) and the family's best.
      aaIndex: b?.exact ? b.exact.index : null,
      aaName: b?.exact ? b.exact.name : null,
      aaFamilyIndex: b ? b.best.index : null,
      aaFamilyName: b ? b.best.name : null,
      priceIn: price ? price.input : null,
      priceOut: price ? price.output : null,
      label: m.label,
      model,
      modelId: m.modelId || modelIdFromLabel(m.label),
      thinkingLevel: typeof f.thinkingLevel === 'number' ? f.thinkingLevel : null,
      maxTokens: f.maxTokens || null,
      maxOutputTokens: f.maxOutputTokens || null,
      disabled: !!m.disabled,
      tag: m.tagTitle || null,
      tagDescription: m.tagDescription || null,
      remaining: typeof m.quotaInfo?.remainingFraction === 'number' ? m.quotaInfo.remainingFraction : null,
      resetTime: m.quotaInfo?.resetTime || null,
      };
    });
    return {
      models,
      lastSelected: lastSelectedModel(),
      priceSource: priceTable.source,
      benchmarks: {
        configured: !!bench.configured,
        ok: !!bench.ok,
        error: bench.error || null,
        version: bench.version ?? null,
        updatedAt: bench.at ? new Date(bench.at).toISOString() : null,
        fromEnv: !!process.env.AA_API_KEY,
      },
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502,
      contentType: 'application/json',
    });
  }
}, 'GET');

// Projects for the "start in" picker: ListProjects gives ids, ReadProjects
// gives names and folders. Cached for a minute.
let projectCache = null;
app.api('/api/projects', async () => {
  if (projectCache && Date.now() - projectCache.at < 60000) return projectCache.body;
  try {
    const { projectIds = [] } = await lsCall('ListProjects');
    const ids = projectIds.filter((id) => id && id !== 'default-cli-project');
    const { projects = [] } = ids.length ? await lsCall('ReadProjects', { ids }) : {};
    const list = projects
      .filter((p) => p?.id && p.name)
      .map((p) => {
        const uri = p.projectResources?.resources?.find((r) => r.folderUri)?.folderUri || '';
        let folder = '';
        try { folder = uri ? decodeURIComponent(new URL(uri).pathname).replace(/^\/([a-z]:)/i, '$1') : ''; } catch {}
        return { id: p.id, name: p.name, folder };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const body = { projects: list };
    projectCache = { at: Date.now(), body };
    return body;
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err), projects: [] }), { status: 502, contentType: 'application/json' });
  }
}, 'GET');

app.api('/api/start', async (data) => {
  const prompt = String(data.prompt || '').trim();
  const modelId = String(data.modelId || '').trim();
  if (!prompt) return new Response(JSON.stringify({ error: 'Type what the new chat should do first.' }), { status: 400, contentType: 'application/json' });
  if (!/^[a-z0-9.-]{2,80}$/.test(modelId)) return new Response(JSON.stringify({ error: 'Bad model id.' }), { status: 400, contentType: 'application/json' });
  if (data.projectId && !/^[A-Za-z0-9-]{1,80}$/.test(String(data.projectId))) return new Response(JSON.stringify({ error: 'Bad project id.' }), { status: 400, contentType: 'application/json' });
  try {
    const result = app.startConversation(prompt, { model: modelId, projectId: data.projectId || undefined });
    return { ok: true, modelId, conversationId: findConversationId(result), result };
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || err).trim();
    return new Response(JSON.stringify({ error: detail.slice(0, 600) }), { status: 500, contentType: 'application/json' });
  }
});

// Saves (or with an empty key, clears) the Artificial Analysis key in the
// sidecar's own data dir, then fetches once to check it.
app.api('/api/aa-key', async (data) => {
  const key = String(data.key || '').trim();
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, contentType: 'application/json' });
  if (!key) {
    try { unlinkSync(keyFile()); } catch {}
    try { unlinkSync(aaCacheFile()); } catch {}
    aaMem = null;
    return json({ ok: true, cleared: true });
  }
  if (!/^[A-Za-z0-9_\-.]{8,200}$/.test(key)) return json({ error: "That doesn't look like an API key." }, 400);
  try {
    const { version, entries } = await aaFetch(key);
    writeFileSync(keyFile(), key, { mode: 0o600 });
    aaMem = { at: Date.now(), ok: true, error: null, version, entries };
    try { writeFileSync(aaCacheFile(), JSON.stringify(aaMem)); } catch {}
    return json({ ok: true, models: entries.length });
  } catch (err) {
    return json({ error: String(err.message || err) }, 400);
  }
});

app.run();
