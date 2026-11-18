(function () {
  const { ELEMENTS, BY_NAME } = window.PERIODIC;

  const REFRESH_MS = 15000;
  const VARIANT_ORDER = ['low', 'medium', 'standard', 'high', 'xhigh', 'max'];
  const VENDOR_WORDS = new Set(['gemini', 'claude', 'google', 'anthropic', 'openai']);

  const $ = (sel) => document.querySelector(sel);
  const state = {
    models: [],
    lastSelected: null,
    families: new Map(), // key -> family
    selectedKey: null,
    selectedVariant: null,
    error: null,
    busy: false,
    weigh: 'price', // 'price' | 'intel'
    bench: null,
  };
  try { if (localStorage.getItem('elements.weigh') === 'intel') state.weigh = 'intel'; } catch {}
  const weighParam = new URLSearchParams(location.search).get('weigh');
  if (weighParam === 'intel' || weighParam === 'price') state.weigh = weighParam;

  // ---------- model -> element mapping ----------

  function findElement(text) {
    for (const word of String(text).split(/[^A-Za-z]+/)) {
      const el = BY_NAME.get(word.toLowerCase());
      if (el) return el;
    }
    return null;
  }

  function parseModel(m) {
    const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(m.label);
    const base = (match ? match[1] : m.label).trim();
    const paren = match ? match[2].trim() : '';
    let el = findElement(base);
    if (el) return { element: el, family: base, variant: paren || 'Standard' };
    el = findElement(paren);
    if (el) return { element: el, family: base, variant: m.label };
    return { element: null, family: base, variant: paren || 'Standard' };
  }

  function variantRank(v) {
    const i = VARIANT_ORDER.indexOf(v.toLowerCase());
    return i === -1 ? 50 : i;
  }

  function syntheticSymbol(family, taken) {
    const words = family.split(/\s+/).filter((w) => !VENDOR_WORDS.has(w.toLowerCase()) && /[A-Za-z]/.test(w));
    const letters = (words[0] || family).replace(/[^A-Za-z]/g, '');
    const first = letters[0] ? letters[0].toUpperCase() : 'X';
    for (const c of letters.slice(1)) {
      const sym = first + c.toLowerCase();
      if (!taken.has(sym)) return sym;
    }
    for (let i = 0; i < 26; i++) {
      const sym = first + String.fromCharCode(97 + i);
      if (!taken.has(sym)) return sym;
    }
    return first;
  }

  function buildFamilies(models) {
    const families = new Map();
    for (const m of models) {
      const p = parseModel(m);
      const key = p.element ? `el:${p.element.z}` : `syn:${p.family}`;
      if (!families.has(key)) {
        families.set(key, {
          key,
          element: p.element,
          name: p.element ? p.element.name : p.family,
          families: new Set(),
          variants: [],
        });
      }
      const fam = families.get(key);
      fam.families.add(p.family);
      fam.variants.push({ ...m, variant: p.variant, family: p.family });
    }
    const taken = new Set(ELEMENTS.map((e) => e.symbol));
    let n = 119;
    for (const fam of families.values()) {
      fam.variants.sort((a, b) => a.family.localeCompare(b.family) || variantRank(a.variant) - variantRank(b.variant));
      fam.available = fam.variants.filter((v) => !v.disabled);
      const quotas = fam.available.map((v) => v.remaining).filter((r) => typeof r === 'number');
      fam.remaining = quotas.length ? Math.min(...quotas) : null;
      fam.isNew = fam.variants.some((v) => v.tag === 'New');
      const outs = fam.variants.map((v) => v.priceOut).filter((p) => typeof p === 'number');
      const ins = fam.variants.map((v) => v.priceIn).filter((p) => typeof p === 'number');
      fam.priceOut = outs.length ? Math.max(...outs) : null;
      fam.priceIn = ins.length ? Math.max(...ins) : null;
      const iqs = fam.variants.map((v) => v.aaFamilyIndex).filter((p) => typeof p === 'number');
      fam.aaIndex = iqs.length ? Math.max(...iqs) : null;
      fam.isDefault = fam.variants.some((v) => v.model && v.model === state.lastSelected);
      if (!fam.element) {
        fam.symbol = syntheticSymbol(fam.name, taken);
        taken.add(fam.symbol);
        fam.z = n++;
      }
    }
    rankFamilies(families);
    return families;
  }

  // What "atomic mass" means right now: API price, or the Artificial
  // Analysis Intelligence Index.
  const weighByIntel = () => state.weigh === 'intel' && hasIntel();
  const hasIntel = () => [...state.families.values()].some((f) => f.aaIndex !== null);
  const metricOf = (f) => (weighByIntel() ? f.aaIndex : f.priceOut);

  // Heaviest first; ties broken by the other metric.
  function rankFamilies(families = state.families) {
    for (const f of families.values()) { f.rank = null; f.isHeaviest = false; }
    const intel = state.weigh === 'intel' && [...families.values()].some((f) => f.aaIndex !== null);
    const m = (f) => (intel ? f.aaIndex : f.priceOut);
    const ranked = [...families.values()]
      .filter((f) => m(f) !== null)
      .sort((a, b) => m(b) - m(a) || (b.priceOut || 0) - (a.priceOut || 0) || (b.aaIndex || 0) - (a.aaIndex || 0));
    ranked.forEach((f, i) => { f.rank = i + 1; });
    const top = ranked.find((f) => f.available.length > 0);
    if (top) top.isHeaviest = true;
    state.ranked = ranked;
  }

  const fmtIQ = (n) => (n === null || n === undefined ? '' : (Math.round(n * 10) / 10).toFixed(1));

  // ---------- rendering ----------

  function quotaClass(r) {
    if (r === null) return '';
    if (r <= 0.1) return 'q-low';
    if (r <= 0.4) return 'q-mid';
    return 'q-ok';
  }

  function tileHTML({ symbol, name, z, cls, fam, style }) {
    const q = fam && fam.remaining !== null
      ? `<span class="quota ${quotaClass(fam.remaining)}" style="--q:${Math.round(fam.remaining * 100)}%"></span>`
      : '';
    const count = fam ? `<span class="count" title="${fam.variants.length} tier${fam.variants.length === 1 ? '' : 's'}">×${fam.variants.length}</span>` : '';
    const mass = !fam ? ''
      : weighByIntel()
        ? (fam.aaIndex !== null ? `<span class="mass" title="Artificial Analysis Intelligence Index">${fmtIQ(fam.aaIndex)}</span>` : '<span class="mass muted-mass" title="No Artificial Analysis score">–</span>')
        : (fam.priceOut !== null ? `<span class="mass" title="API output price per 1M tokens">${fmtPrice(fam.priceOut)}</span>` : '');
    const flag = !fam ? ''
      : fam.isHeaviest ? `<span class="flag heavy" title="Heaviest available model: ${weighByIntel() ? 'highest intelligence score' : 'highest API price'}">★</span>`
      : fam.isNew ? '<span class="flag new">NEW</span>' : '';
    const interactive = !!fam;
    const tag = interactive ? 'button' : 'div';
    const attrs = interactive
      ? `type="button" data-key="${fam.key}" aria-label="${name}: ${fam.variants.length} model${fam.variants.length === 1 ? '' : 's'}" aria-pressed="${state.selectedKey === fam.key}"`
      : 'aria-hidden="true"';
    return `<${tag} class="tile ${cls}" style="${style || ''}" ${attrs}>
      <span class="z">${z}</span>${flag}
      <span class="sym">${symbol}</span>
      <span class="name">${name}</span>
      ${mass}${count}${q}
    </${tag}>`;
  }

  function renderTable() {
    const grid = $('#grid');
    const parts = [];
    for (const el of ELEMENTS) {
      const fam = state.families.get(`el:${el.z}`);
      const cls = [
        `cat-${el.category}`,
        fam ? 'lit' : 'dim',
        fam && fam.available.length === 0 ? 'locked' : '',
        fam && fam.isDefault ? 'is-default' : '',
        fam && state.selectedKey === fam.key ? 'selected' : '',
      ].join(' ');
      parts.push(tileHTML({
        symbol: el.symbol, name: el.name, z: el.z, cls, fam,
        style: `grid-row:${el.row};grid-column:${el.col}`,
      }));
    }
    parts.push('<div class="marker" style="grid-row:6;grid-column:3" aria-hidden="true">57–71</div>');
    parts.push('<div class="marker" style="grid-row:7;grid-column:3" aria-hidden="true">89–103</div>');
    grid.innerHTML = parts.join('');

    const syn = [...state.families.values()].filter((f) => !f.element);
    const synRow = $('#synthetic');
    synRow.innerHTML = syn.map((fam) => tileHTML({
      symbol: fam.symbol, name: fam.name, z: fam.z, fam,
      cls: ['cat-synthetic', 'lit', fam.available.length === 0 ? 'locked' : '', fam.isDefault ? 'is-default' : '', state.selectedKey === fam.key ? 'selected' : ''].join(' '),
    })).join('');
    $('#synthetic-wrap').hidden = syn.length === 0;

    renderLeaderboard();

    const elementCount = [...state.families.values()].filter((f) => f.element).length;
    $('#summary').textContent = state.error
      ? 'Could not load models'
      : `${elementCount} element${elementCount === 1 ? '' : 's'} discovered · ${state.models.length} models`;
  }

  function fmtPrice(p) {
    if (p === null || p === undefined) return '';
    return `$${p >= 10 && Number.isInteger(p) ? p : p.toFixed(2)}`;
  }

  const THINKING = { 1: 'low', 2: 'medium', 3: 'high', 100: 'max' };
  const fmtThinking = (t) => (t === null || t === undefined ? '' : `${THINKING[t] || `level ${t}`} thinking`);
  const fmtTokens = (n) => (!n ? '' : n >= 1e6 ? `${+(n / 1048576).toFixed(1)}M` : `${Math.round(n / 1024)}K`);

  function renderLeaderboard() {
    const box = $('#leaderboard');
    const ranked = state.ranked || [];
    if (!ranked.length) { box.hidden = true; return; }
    box.hidden = false;
    const intel = weighByIntel();
    const max = metricOf(ranked[0]) || 1;
    $('#leaderboard-list').innerHTML = ranked.map((f) => {
      const el = f.element;
      const sym = el ? el.symbol : f.symbol;
      const cat = el ? el.category : 'synthetic';
      const label = [...f.families].join(' / ');
      return `<li>
        <button type="button" class="lb-row ${state.selectedKey === f.key ? 'on' : ''} ${f.available.length ? '' : 'locked'}" data-key="${f.key}">
          <span class="lb-rank">${f.rank}</span>
          <span class="lb-sym cat-${cat}">${sym}</span>
          <span class="lb-name">${escapeHTML(label)}${f.isNew ? ' <span class="pill">new</span>' : ''}${f.available.length ? '' : ' <span class="pill">locked</span>'}</span>
          <span class="lb-bar cat-${cat}"><span style="width:${Math.max(4, (metricOf(f) / max) * 100)}%"></span></span>
          <span class="lb-price">${f.aaIndex !== null ? `<span class="lb-iq ${intel ? 'strong' : ''}" title="Artificial Analysis Intelligence Index">${fmtIQ(f.aaIndex)}</span>` : ''}<span class="${intel ? '' : 'strong'}">${f.priceOut !== null ? `${fmtPrice(f.priceIn)} / ${fmtPrice(f.priceOut)}` : 'no price'}</span></span>
        </button>
      </li>`;
    }).join('');

    for (const b of document.querySelectorAll('[data-weigh]')) {
      const on = (b.dataset.weigh === 'intel') === intel;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      if (b.dataset.weigh === 'intel') b.disabled = !hasIntel();
    }
    const bits = [];
    if (state.priceSource) bits.push(`Prices per 1M tokens (input / output) via ${escapeHTML(state.priceSource)}`);
    if (hasIntel()) bits.push(`Intelligence Index${state.bench?.version ? ` v${escapeHTML(state.bench.version)}` : ''} by <a href="https://artificialanalysis.ai" target="_blank" rel="noopener noreferrer">Artificial Analysis</a>`);
    $('#price-source').innerHTML = bits.join(' · ');
    renderBenchBox();
  }

  // Key setup / status for Artificial Analysis benchmarks.
  function renderBenchBox() {
    const box = $('#aa-box');
    const b = state.bench || {};
    if (document.activeElement && document.activeElement.id === 'aa-key') return;
    if (!b.configured) {
      box.innerHTML = `<p class="small">Add benchmark scores: paste a free key from
        <a href="https://artificialanalysis.ai/api-key-management-redirect" target="_blank" rel="noopener noreferrer">Artificial Analysis</a>.
        It's stored only in this plugin's private data folder.</p>
        <div class="aa-form"><input id="aa-key" type="password" autocomplete="off" spellcheck="false" placeholder="Artificial Analysis API key" aria-label="Artificial Analysis API key">
        <button type="button" id="aa-save" class="ghost">Save</button></div>`;
      return;
    }
    const when = b.updatedAt ? new Date(b.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    box.innerHTML = `<p class="small muted">${b.error ? `<span class="warn-text">${escapeHTML(b.error)}</span> ` : ''}${when ? `Scores updated ${escapeHTML(when)} (refreshed every 12 h).` : ''}
      ${b.fromEnv ? '' : '<button type="button" id="aa-clear" class="link">Remove key</button>'}</p>`;
  }

  async function saveKey(key) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f('/api/aa-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || res.statusText);
    return data;
  }

  function fmtReset(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const mins = Math.round((d - Date.now()) / 60000);
    if (mins <= 0) return 'resets now';
    if (mins < 60) return `resets in ${mins} min`;
    if (mins < 48 * 60) return `resets in ${Math.round(mins / 60)} h`;
    return `resets ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }

  function renderDetail() {
    const panel = $('#detail');
    const fam = state.families.get(state.selectedKey);
    if (!fam) {
      panel.innerHTML = `<p class="hint">Pick a lit element to see its models. Element names in model labels (Hydrogen, Argon, Carbon…) land in their real spot; everything else goes in the bottom row.</p>`;
      return;
    }
    const el = fam.element;
    const sym = el ? el.symbol : fam.symbol;
    const z = el ? el.z : fam.z;
    const desc = fam.variants.map((v) => v.tagDescription).find(Boolean);
    const rows = fam.variants.map((v, i) => {
      const r = v.remaining;
      const pct = r === null ? null : Math.round(r * 100);
      const isSel = state.selectedVariant === v.label;
      const isDef = v.model && v.model === state.lastSelected;
      return `<button type="button" class="variant ${isSel ? 'on' : ''}" data-variant="${i}" ${v.disabled ? 'disabled' : ''} aria-pressed="${isSel}">
        <span class="v-name">${escapeHTML(fam.families.size > 1 ? v.label : v.variant)}${isDef ? ' <span class="pill">last used</span>' : ''}${v.disabled ? ' <span class="pill">locked</span>' : ''}</span>
        <span class="v-meta">${pct === null ? (v.disabled ? escapeHTML(v.tag || '') : '') : `${pct}% left · ${fmtReset(v.resetTime)}`}</span>
        <span class="v-facts">${[
          v.aaIndex !== null ? `<span class="v-iq" title="Artificial Analysis Intelligence Index${v.aaName ? `: ${escapeHTML(v.aaName)}` : ''}">IQ ${fmtIQ(v.aaIndex)}</span>` : '',
          fmtThinking(v.thinkingLevel), v.maxTokens ? `${fmtTokens(v.maxTokens)} context` : '', v.maxOutputTokens ? `${fmtTokens(v.maxOutputTokens)} output` : ''].filter(Boolean).join(' · ')}</span>
        ${pct === null ? '' : `<span class="v-bar ${quotaClass(r)}"><span style="width:${pct}%"></span></span>`}
      </button>`;
    }).join('');
    const sel = fam.variants.find((v) => v.label === state.selectedVariant);
    panel.innerHTML = `
      <div class="d-head">
        <div class="d-tile cat-${el ? el.category : 'synthetic'}"><span class="z">${z}</span><span class="sym">${sym}</span></div>
        <div>
          <h2>${escapeHTML(fam.name)}</h2>
          <p class="muted">${[...fam.families].map(escapeHTML).join(' · ')}</p>
        </div>
        <div class="d-mass">
          ${weighByIntel() && fam.aaIndex !== null
            ? `<span class="d-mass-num" title="Artificial Analysis Intelligence Index">${fmtIQ(fam.aaIndex)}</span>
               <span class="muted small">intelligence${fam.priceOut !== null ? ` · ${fmtPrice(fam.priceOut)} out` : ''}</span>`
            : fam.priceOut !== null
              ? `<span class="d-mass-num" title="API price per 1M tokens">${fmtPrice(fam.priceOut)}</span>
                 <span class="muted small">out · ${fmtPrice(fam.priceIn)} in${fam.aaIndex !== null ? ` · IQ ${fmtIQ(fam.aaIndex)}` : ''}</span>`
              : `<span class="muted small">no public API price${fam.aaIndex !== null ? ` · IQ ${fmtIQ(fam.aaIndex)}` : ''}</span>`}
          ${fam.rank ? `<span class="muted small">#${fam.rank} heaviest${fam.isHeaviest ? ' ★' : ''}</span>` : ''}
        </div>
      </div>
      ${desc ? `<p class="d-desc">${escapeHTML(desc)}</p>` : ''}
      <div class="variants">${rows}</div>
      <label class="prompt-label" for="prompt">New chat on ${sel ? `<strong>${escapeHTML(sel.label)}</strong>` : 'the selected model'}</label>
      <textarea id="prompt" rows="3" placeholder="What should it work on?">${escapeHTML(state.draft || '')}</textarea>
      <div class="actions">
        <span class="muted small">${sel ? `model id <code>${escapeHTML(sel.modelId)}</code>` : 'Pick a variant above'}</span>
        <button type="button" id="start" class="primary" ${sel && !state.busy ? '' : 'disabled'}>${state.busy ? 'Starting…' : 'Start chat'}</button>
      </div>`;
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show ${kind}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = 'toast'; }, 5000);
  }

  function render() {
    renderTable();
    renderDetail();
  }

  // ---------- data ----------

  async function load() {
    try {
      const res = await fetch('/api/models', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || res.statusText);
      state.models = data.models || [];
      state.lastSelected = data.lastSelected;
      state.priceSource = data.priceSource || '';
      state.bench = data.benchmarks || null;
      state.error = null;
      state.families = buildFamilies(state.models);
      if (!state.selectedKey) {
        const def = [...state.families.values()].find((f) => f.isDefault);
        if (def) {
          state.selectedKey = def.key;
          state.selectedVariant = def.variants.find((v) => v.model === state.lastSelected)?.label || null;
        }
      }
      $('#error').hidden = true;
    } catch (err) {
      state.error = String(err.message || err);
      $('#error').hidden = false;
      $('#error').textContent = `Couldn't reach the language server: ${state.error}`;
    }
    const draftEl = $('#prompt');
    if (draftEl) state.draft = draftEl.value;
    // Don't rebuild the detail panel under someone who is typing in it.
    if (document.activeElement === draftEl) renderTable();
    else render();
  }

  let projectIdPromise = null;
  function projectId() {
    if (!projectIdPromise) {
      projectIdPromise = (async () => {
        try {
          const id = window.sidecar?.conversationId;
          if (!id || !window.sidecar?.agent?.getConversationMetadata) return '';
          const data = await window.sidecar.agent.getConversationMetadata(id);
          const meta = (data?.response?.conversationMetadata || data?.response?.conversation_metadata)?.metadata;
          return meta?.projectId || meta?.project_id || '';
        } catch { return ''; }
      })();
    }
    return projectIdPromise;
  }

  async function start() {
    const fam = state.families.get(state.selectedKey);
    const v = fam?.variants.find((x) => x.label === state.selectedVariant);
    const prompt = $('#prompt')?.value.trim();
    if (!v) return;
    if (!prompt) { toast('Type what the new chat should do first.', 'warn'); $('#prompt').focus(); return; }
    state.draft = prompt;
    state.busy = true;
    renderDetail();
    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, modelId: v.modelId, projectId: await projectId() }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || res.statusText);
      state.draft = '';
      toast(`Started a chat on ${v.label}.`, 'ok');
      if (data.conversationId && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(data.conversationId);
      }
    } catch (err) {
      toast(String(err.message || err), 'warn');
    } finally {
      state.busy = false;
      renderDetail();
    }
  }

  // ---------- events ----------

  document.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile[data-key], .lb-row[data-key]');
    if (tile) {
      const key = tile.dataset.key;
      const draftEl = $('#prompt');
      if (draftEl) state.draft = draftEl.value;
      if (state.selectedKey !== key) {
        state.selectedKey = key;
        const fam = state.families.get(key);
        const pick = fam.available.find((v) => v.model === state.lastSelected) || fam.available[Math.floor((fam.available.length - 1) / 2)];
        state.selectedVariant = pick ? pick.label : null;
      }
      render();
      $('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    const variant = e.target.closest('.variant[data-variant]');
    if (variant) {
      const fam = state.families.get(state.selectedKey);
      const v = fam.variants[Number(variant.dataset.variant)];
      const draftEl = $('#prompt');
      if (draftEl) state.draft = draftEl.value;
      state.selectedVariant = v.label;
      renderDetail();
      return;
    }
    const weigh = e.target.closest('[data-weigh]');
    if (weigh && !weigh.disabled) {
      state.weigh = weigh.dataset.weigh;
      try { localStorage.setItem('elements.weigh', state.weigh); } catch {}
      rankFamilies();
      render();
      return;
    }
    if (e.target.closest('#aa-save')) submitKey();
    if (e.target.closest('#aa-clear')) clearKey();
    if (e.target.closest('#start')) start();
    if (e.target.closest('#refresh')) load();
  });

  async function submitKey() {
    const input = $('#aa-key');
    const key = input?.value.trim();
    if (!key) { toast('Paste your Artificial Analysis key first.', 'warn'); return; }
    const btn = $('#aa-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      const r = await saveKey(key);
      input.value = '';
      input.blur();
      state.weigh = 'intel';
      try { localStorage.setItem('elements.weigh', 'intel'); } catch {}
      toast(`Benchmarks loaded for ${r.models} models.`, 'ok');
      await refresh();
    } catch (err) {
      toast(String(err.message || err), 'warn');
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  }

  async function clearKey() {
    try {
      await saveKey('');
      state.weigh = 'price';
      toast('Artificial Analysis key removed.', 'ok');
      await refresh();
    } catch (err) {
      toast(String(err.message || err), 'warn');
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'aa-key' && e.key === 'Enter') {
      e.preventDefault();
      submitKey();
      return;
    }
    if (e.target.id === 'prompt' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      start();
    }
  });

  // Poll while the pane is visible, and reload right away when it comes back
  // into view, so new models and quota changes show up without a click.
  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    try { await load(); } finally { loading = false; }
  }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', refresh);
})();
