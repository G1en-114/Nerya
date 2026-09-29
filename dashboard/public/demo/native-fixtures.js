/**
 * DEMO ONLY: install AFTER importing app.js, which owns the isolated fetch and
 * __demoRequests audit. No real vault, credentials, storage or network is used.
 * Only recording-only-placeholder is accepted by the native recording forms.
 * All unhandled routes/methods remain subject to the original demo deny guard.
 */
const INSTALLED = Symbol.for('nerya.demo.nativeFixtures');
const PLACEHOLDER = 'recording-only-placeholder';
const STAMP = '2026-09-26T00:00:00.000Z';
const PREFIX = '/api/proxy';
const READS = new Set(['/security/env/list', '/security/secrets/list', '/evolution/timeline']);
const WRITES = new Set(['/security/env/put', '/security/secrets/put']);

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function abortable(promise, signal) {
  if (!signal) return promise;
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

function metadata(name, kind = 'opaque', scope = ['recording.read']) {
  return { name, kind, scope, preview: PLACEHOLDER, fingerprint: 'demo-only',
    ref: `vault://${name}`, owner: 'recording-demo', created_at: STAMP };
}

function envRow(ref) {
  return { ...ref, name: ref.name.slice(4).toUpperCase(), secret_name: ref.name };
}

function supplementTimeline(data) {
  const timeline = (data.timeline || []).map(row => ({
    ...row, record_id: row.record_id ?? row.id, type: row.type ?? (row.proposal ? 'proposal' : 'event'),
    ts: row.ts ?? row.created_at ?? STAMP, status: row.status ?? row.state ?? 'pending',
    evidence_refs: row.evidence_refs ?? row.source_refs ?? [],
  }));
  const raw = { signals: [], events: [], proposals: timeline.map(row => row.proposal).filter(Boolean),
    assets: [], candidates: [], validation_plans: [], ...data.raw };
  const summary = {
    signals: raw.signals.length, events: raw.events.length, assets: raw.assets.length,
    capsules: raw.assets.filter(row => row.kind === 'capsule').length,
    candidates: raw.candidates.length, blocked_candidates: 0,
    proposals: raw.proposals.length,
    open_proposals: raw.proposals.filter(row => ['pending', 'draft', 'approved'].includes(row.state || row.status)).length,
    validation_plans: raw.validation_plans.length, blocked_validation_plans: 0,
    terminal_outcomes: 0, timeline_items: timeline.length,
    last_activity_ts: timeline.map(row => row.ts).sort().at(-1) || null, ...data.summary,
  };
  return { ...data, timeline, raw, summary, config: {
    ...data.config, periodic_reflection: {
      id: 'workspace_reflection_dream', kind: 'evolution.reflect', target: 'skill:evolution.reflect',
      enabled: false, configured: false, cron: '0 3 * * *', time: '03:00', timezone: 'Asia/Shanghai',
      ...data.config?.periodic_reflection,
    },
  } };
}

export function installNativeFixtures() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || !Array.isArray(window.__demoRequests)) {
    throw Error('Native fixtures require the isolated app.js demo transport first.');
  }
  if (window.fetch[INSTALLED]) return window.fetch;
  const originalFetch = window.fetch;
  const requests = window.__demoRequests;
  // Metadata only: even the permitted placeholder value is never persisted.
  const refs = new Map([
    ['recording_market_data', metadata('recording_market_data', 'api_key')],
    ['env.nerya_recording_mode', metadata('env.nerya_recording_mode', 'env', ['env', 'shell', 'mcp.read'])],
  ]);
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  const invalid = detail => json({ ok: false, error: 'demo_fixture_input', detail }, 400);

  const wrapped = async (input, init = {}) => {
    const signal = init.signal !== undefined ? init.signal : input?.signal;
    checkAbort(signal);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
    if (url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol)) {
      throw new TypeError('Demo blocks all external/runtime network requests.');
    }
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    const route = url.pathname.startsWith(PREFIX + '/') ? url.pathname.slice(PREFIX.length) : '';
    const supported = (READS.has(route) && ['GET', 'POST'].includes(method)) || (WRITES.has(route) && method === 'POST');
    if (!supported) return abortable(originalFetch.call(window, input, init), signal);
    const audit = () => requests.push({ path: route, method, local: true, fixture: 'native-recording' });

    if (route === '/evolution/timeline') {
      const start = requests.length;
      const pending = originalFetch.call(window, input, init);
      // The existing isolated fetch normally audits this delegated read itself.
      if (!requests.slice(start).some(row => row.path === route && row.method === method)) audit();
      const response = await abortable(pending, signal);
      if (!response.ok) return response;
      const data = await abortable(response.clone().json(), signal);
      checkAbort(signal);
      if (!data || data.ok === false) return response;
      const headers = new Headers(response.headers);
      headers.set('content-type', 'application/json'); headers.delete('content-length');
      return new Response(JSON.stringify(supplementTimeline(data)), { status: response.status, statusText: response.statusText, headers });
    }

    audit(); // Never record request bodies, values, authorization headers or query parameters.
    if (route === '/security/secrets/list') return json({ refs: [...refs.values()] });
    if (route === '/security/env/list') {
      const env = [...refs.values()].filter(ref => ref.kind === 'env' && ref.name.startsWith('env.')).map(envRow);
      return json({ ok: true, env, count: env.length });
    }

    let body;
    try {
      const text = init.body !== undefined ? init.body : typeof input?.clone === 'function'
        ? await abortable(input.clone().text(), signal) : '{}';
      checkAbort(signal);
      if (typeof text !== 'string') return invalid('Demo forms require a JSON object.');
      body = JSON.parse(text);
    } catch (error) {
      checkAbort(signal);
      return invalid('Demo forms require valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Demo forms require a JSON object.');
    if (body.value !== PLACEHOLDER) return invalid('Demo only: use recording-only-placeholder; never enter real credentials.');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (route === '/security/env/put') {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return invalid('Invalid demo environment variable name.');
      const secretName = 'env.' + name.toLowerCase();
      const ref = metadata(secretName, 'env', ['env', 'shell', 'mcp.read']);
      checkAbort(signal); refs.set(secretName, ref);
      return json({ ok: true, env: envRow(ref) });
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)) return invalid('Invalid demo reference name.');
    const kind = body.kind || 'opaque', scope = body.scope ?? [];
    if (typeof kind !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(kind) ||
        !Array.isArray(scope) || scope.length > 16 || scope.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value))) {
      return invalid('Invalid demo reference kind or scopes.');
    }
    const ref = metadata(name, kind, scope);
    checkAbort(signal); refs.set(name, ref);
    return json({ ok: true, ref });
  };
  Object.defineProperty(wrapped, INSTALLED, { value: true });
  window.fetch = wrapped;
  return wrapped;
}
