/* Run: node agent/dashboard/scripts/test-desktop-auth.cjs. No live workspace. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function load(relative, extras = {}) {
  const filename = path.join(root, relative);
  const module = { exports: {} };
  const nativeRequire = createRequire(filename);
  const localRequire = name => name.startsWith('.')
    ? load(path.relative(root, path.resolve(path.dirname(filename), name)) + '.ts', extras)
    : nativeRequire(name);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire,
    process, Buffer, URL, Headers, Request, Response, ReadableStream, setTimeout, clearTimeout, console, ...extras }, { filename });
  return module.exports;
}
function client() {
  const data = new Map();
  const redirects = [];
  const window = { location: { hostname: '127.0.0.1', pathname: '/settings', search: '?view=models', hash: '#access', replace: value => redirects.push(value) },
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) },
    dispatchEvent() {} };
  return { auth: load('lib/auth.ts', { window, Event: class {} }), window, data, redirects };
}
async function main() {
  const c = client();
  c.auth.setStoredAuthToken('expired', Math.floor(Date.now() / 1000) - 1);
  assert.equal(c.auth.getStoredAuthToken(), '');
  c.auth.setStoredAuthToken('valid');
  assert.equal(c.auth.authHeaders().get('authorization'), 'Bearer valid');
  c.auth.handleAuthFailure(403, JSON.stringify({ reason: 'insufficient_scope' }));
  assert.equal(c.auth.getStoredAuthToken(), 'valid');
  assert.equal(c.redirects.length, 0);
  c.auth.handleAuthFailure(401);
  c.auth.handleAuthFailure(401);
  assert.equal(c.auth.getStoredAuthToken(), '');
  assert.equal(c.redirects.length, 1);
  assert.equal(c.redirects[0], '/login?next=%2Fsettings%3Fview%3Dmodels%23access');
  const invalid = client();
  invalid.auth.setStoredAuthToken('stale');
  invalid.auth.handleAuthFailure(403, JSON.stringify({ reason: 'invalid_token' }));
  assert.equal(invalid.redirects.length, 1);
  assert.equal(invalid.auth.getStoredAuthToken(), '');
  for (const next of [null, '//evil.test', '/\\evil.test', 'https://evil.test', '/login?next=/settings']) {
    assert.equal(c.auth.safeLoginNext(next), '/dashboard');
  }
  assert.equal(c.auth.safeLoginNext('/settings#access'), '/settings#access');
  console.log('PASS localhost 401 / invalid-token 403 recovery, expiry, safe return URL and permission preservation');

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/auth/status' ? { ok: true, password_configured: false } : {
        method: req.method, url: req.url, token: req.headers.authorization,
        proof: req.headers['x-nerya-local-peer'] ?? null, cookie: req.headers.cookie ?? null,
        body: Buffer.concat(chunks).toString(),
      }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const keys = ['NERYA_API', 'NERYA_API_TOKEN', 'NERYA_LOCAL_PEER_KEY'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { NERYA_API: `http://127.0.0.1:${upstream.address().port}`, NERYA_API_TOKEN: 'private-fixture', NERYA_LOCAL_PEER_KEY: 'socket-fixture' });
  try {
    const route = load('app/api/proxy/[...path]/route.ts');
    const { NextRequest } = require('next/server');
    const req = (endpoint, headers = {}, method = 'GET', body) => new NextRequest(`http://127.0.0.1:18400/api/proxy/${endpoint}`, {
      method, body, headers: { host: '127.0.0.1:18400', ...headers },
    });
    const ctx = endpoint => ({ params: { path: endpoint.split('/') } });
    const shared = { 'x-forwarded-for': 'desktop-share' };
    const privateHeaders = { 'x-nerya-local-peer': 'socket-fixture' };
    for (const [headers, expected] of [[shared, false], [privateHeaders, true], [{ 'x-nerya-local-peer': 'forged' }, false]]) {
      const response = await route.GET(req('auth/status', headers), ctx('auth/status'));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).local_access, expected);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await route.GET(req('workspace', shared), ctx('workspace'))).status, 401);
    const desktop = await route.GET(req('workspace', privateHeaders), ctx('workspace'));
    assert.equal(desktop.status, 200);
    assert.equal((await desktop.json()).token, 'Bearer private-fixture');
    const remoteHeaders = { ...shared, authorization: 'Bearer admin-fixture', cookie: 'language=zh' };
    const read = await route.GET(req('llm/config', remoteHeaders), ctx('llm/config'));
    const readData = await read.json();
    assert.equal(read.status, 200);
    assert.equal(readData.url, '/llm/config');
    assert.equal(readData.token, 'Bearer admin-fixture');
    assert.equal(readData.proof, null);
    const body = JSON.stringify({ providers: [] });
    const write = await route.POST(req('llm/config', remoteHeaders, 'POST', body), ctx('llm/config'));
    const writeData = await write.json();
    assert.equal(write.status, 200);
    assert.equal(writeData.method, 'POST');
    assert.equal(writeData.body, body);
    assert.equal(writeData.token, readData.token);
    assert.equal(writeData.cookie, 'language=zh');
    console.log('PASS actual Next proxy: private/shared locality, forged proof rejection, and same-backend authenticated GET/POST');
  } finally {
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    await new Promise(resolve => upstream.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
