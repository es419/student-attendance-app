const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../sw.js'), 'utf8');

function worker(cached) {
  const context = vm.createContext({
    self: { addEventListener() {} },
    caches: { open: async () => ({ match: async () => cached }) },
    Response
  });
  vm.runInContext(source, context);
  return context;
}

test('repeat navigation returns cached shell while network is still pending', async () => {
  const cached = new Response('saved shell');
  const context = worker(cached);
  let networkRead = false;
  const pendingNetwork = { then() { networkRead = true; } };
  // Let the cache's microtasks finish without resolving the network at all.
  let result;
  context.navigationCacheFirst(pendingNetwork).then(value => { result = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(networkRead, false);
  assert.equal(result, cached);
});

test('navigation without a cached shell uses a successful network response', async () => {
  const fresh = new Response('fresh shell');
  assert.equal(await worker().navigationCacheFirst(Promise.resolve(fresh)), fresh);
});

test('navigation without cache fails cleanly on offline or HTTP errors', async () => {
  for (const response of [null, new Response('unavailable', { status: 503 })]) {
    const result = await worker().navigationCacheFirst(Promise.resolve(response));
    assert.equal(result.type, 'error');
  }
});
