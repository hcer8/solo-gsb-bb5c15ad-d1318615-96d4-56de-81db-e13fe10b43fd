import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { EXAMPLE_REQUEST, EXAMPLE_CONFLICT_REQUEST } from '../src/example.js';

let app;

before(async () => {
  app = buildApp({ logger: false, storeMax: 100 });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('GET /health returns ok with store info', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptimeSeconds, 'number');
  assert.equal(body.store.max, 100);
});

test('GET / returns service metadata', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'config-merge-rehearsal-api');
});

test('GET /api/v1/example returns a usable example payload', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/example' });
  assert.equal(res.statusCode, 200);
  const { mergeRequest } = res.json();
  assert.ok(mergeRequest.base && mergeRequest.patchA && mergeRequest.patchB);
});

test('POST /api/v1/merges with the example payload merges cleanly (200)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: EXAMPLE_REQUEST,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'clean');
  assert.deepEqual(body.merged, {
    app: 'payment-service',
    replicas: 3,
    servers: [
      { host: 'a2.internal', port: 8080 },
      { host: 'b2.internal', port: 9090 },
      { host: 'b.internal', port: 8080 },
    ],
    features: { cache: true, tracing: true, retries: 3 },
    tags: ['stable'],
  });
  assert.equal(body.stats.deduplicated, 1); // identical /features/tracing replace
  assert.ok(body.id);

  // stored record is retrievable
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${body.id}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().id, body.id);
  assert.deepEqual(fetched.json().base, EXAMPLE_REQUEST.base);
});

test('POST /api/v1/merges with conflicting patches returns 409 with structured conflicts', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: EXAMPLE_CONFLICT_REQUEST,
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.status, 'conflict');
  assert.equal(body.merged, null);
  assert.equal(body.conflicts.length, 2);

  const byReason = Object.fromEntries(body.conflicts.map((c) => [c.reason, c]));
  assert.equal(byReason['delete-vs-modify'].path, '/database');
  assert.deepEqual(
    byReason['delete-vs-modify'].operations.map((o) => [o.side, o.index]),
    [
      ['A', 0],
      ['B', 0],
    ],
  );
  assert.equal(byReason['replace-mismatch'].path, '/mode');
  assert.deepEqual(
    byReason['replace-mismatch'].operations.map((o) => [o.side, o.index]),
    [
      ['A', 1],
      ['B', 1],
    ],
  );
});

test('POST /api/v1/merges rejects unsupported ops (400)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: {
      base: {},
      patchA: [{ op: 'move', from: '/a', path: '/b' }],
      patchB: [],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/v1/merges rejects malformed bodies (400)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: { base: {}, patchA: [] },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/v1/merges with a patch that does not apply to base returns 422', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: {
      base: { a: 1 },
      patchA: [{ op: 'remove', path: '/nope' }],
      patchB: [],
    },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'INVALID_PATCH');
  assert.equal(body.details.side, 'A');
  assert.equal(body.details.index, 0);
});

test('list, fetch and delete rehearsals', async () => {  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: { base: { x: 1 }, patchA: [], patchB: [] },
  });
  const { id } = created.json();

  const list = await app.inject({ method: 'GET', url: '/api/v1/merges' });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().items.some((item) => item.id === id));

  const del = await app.inject({ method: 'DELETE', url: `/api/v1/merges/${id}` });
  assert.equal(del.statusCode, 204);

  const gone = await app.inject({ method: 'GET', url: `/api/v1/merges/${id}` });
  assert.equal(gone.statusCode, 404);
});

test('unknown routes return JSON 404', async () => {
  const res = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

/* --------------------------- GET .../order-audit -------------------------- */

async function createAuditRecord(payload) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload,
  });
  const { id } = created.json();
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${id}/order-audit`,
  });
  assert.equal(res.statusCode, 200);
  return res.json();
}

test('order-audit on the clean example: divergent, smallest diff at /servers/0/host', async () => {
  const body = await createAuditRecord(EXAMPLE_REQUEST);
  assert.equal(body.id, body.id);
  assert.equal(body.verdict, 'divergent');
  assert.equal(body.firstDifference.path, '/servers/0/host');
  assert.equal(body.firstDifference.aValue, 'a2.internal');
  assert.equal(body.firstDifference.bValue, 'b.internal');

  for (const order of ['A->B', 'B->A']) {
    const replay = body.orders[order];
    assert.equal(replay.status, 'applied');
    assert.equal(replay.failure, null);
    assert.equal(replay.steps.length, 7);
    // every step carries its executed path and post-execution value
    for (const step of replay.steps) {
      assert.equal(typeof step.path, 'string');
      assert.ok('afterValue' in step);
      assert.equal(step.order, order);
    }
  }
  // A then B: A inserts a2 at gap 1, then B removes current [0] (a.internal)
  // and B's "/servers/1" now points at a2, so b2 lands first.
  assert.deepEqual(
    body.orders['A->B'].finalDocument.servers.map((s) => s.host),
    ['a2.internal', 'b2.internal', 'b.internal'],
  );
  // B then A: b2 is inserted, then A's "/servers/1" points at b2.
  assert.deepEqual(
    body.orders['B->A'].finalDocument.servers.map((s) => s.host),
    ['b.internal', 'a2.internal', 'b2.internal'],
  );
});

test('order-audit marks disjoint patches commutative and replays them fully', async () => {
  const body = await createAuditRecord({
    base: { a: 1, b: 2 },
    patchA: [{ op: 'replace', path: '/a', value: 10 }],
    patchB: [{ op: 'add', path: '/c', value: 30 }],
  });
  assert.equal(body.verdict, 'commutative');
  assert.equal(body.firstDifference, null);
  assert.deepEqual(body.orders['A->B'].finalDocument, { a: 10, b: 2, c: 30 });
  assert.deepEqual(body.orders['B->A'].finalDocument, { a: 10, b: 2, c: 30 });
  assert.deepEqual(
    body.orders['B->A'].steps.map((s) => [s.side, s.index]),
    [
      ['B', 0],
      ['A', 0],
    ],
  );
});

test('order-audit reports failing side, original index and document-before-failure', async () => {
  const body = await createAuditRecord({
    base: { l: [{ h: 'a' }, { h: 'b' }] },
    patchA: [{ op: 'remove', path: '/l/0' }],
    patchB: [{ op: 'replace', path: '/l/1/h', value: 'x' }],
  });
  assert.equal(body.verdict, 'failed');
  const ab = body.orders['A->B'];
  assert.equal(ab.status, 'failed');
  assert.equal(ab.finalDocument, null);
  assert.equal(ab.steps.length, 1);
  assert.deepEqual(ab.steps[0], {
    order: 'A->B',
    side: 'A',
    index: 0,
    op: 'remove',
    path: '/l/0',
    afterExists: false,
    afterValue: null,
    removedValue: { h: 'a' },
  });
  assert.deepEqual(
    {
      order: ab.failure.order,
      side: ab.failure.side,
      index: ab.failure.index,
      op: ab.failure.op,
      path: ab.failure.path,
      code: ab.failure.code,
    },
    {
      order: 'A->B',
      side: 'B',
      index: 0,
      op: 'replace',
      path: '/l/1/h',
      code: 'OUT_OF_BOUNDS',
    },
  );
  assert.deepEqual(ab.failure.documentBefore, { l: [{ h: 'b' }] });
  // the reverse order applied fully
  assert.equal(body.orders['B->A'].status, 'applied');
  assert.deepEqual(body.orders['B->A'].finalDocument, { l: [{ h: 'x' }] });
});

test('order-audit answers are byte-for-byte identical on repeated queries', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload: EXAMPLE_REQUEST,
  });
  const { id } = created.json();
  const first = await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${id}/order-audit`,
  });
  const second = await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${id}/order-audit`,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body, second.body);
  assert.deepEqual(first.json(), second.json());
});

test('order-audit for an unknown id returns 404', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/merges/does-not-exist/order-audit',
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

/* --------------------------- GET .../round-trip-plan ---------------------- */

async function createMerge(payload) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/merges',
    payload,
  });
  return created.json();
}

test('round-trip-plan on a clean record returns replayed forward + rollback patches', async () => {
  const base = {
    replicas: 2,
    servers: [{ host: 'a.internal' }, { host: 'b.internal' }],
    features: { cache: true, tracing: false },
  };
  const record = await createMerge({
    base,
    patchA: [{ op: 'replace', path: '/replicas', value: 3 }],
    patchB: [{ op: 'remove', path: '/servers/0' }, { op: 'add', path: '/features/x', value: 1 }],
  });
  assert.equal(record.status, 'clean');

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${record.id}/round-trip-plan`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, record.id);
  assert.equal(body.status, 'clean');
  assert.equal(body.createdAt, record.createdAt);
  assert.deepEqual(body.base, base);
  assert.deepEqual(body.merged, record.merged);

  // Only add/remove/replace, and array ops are index-safe (remove descending,
  // add ascending): replay forward reaches merged and rollback restores base.
  for (const op of [...body.forward, ...body.rollback]) {
    assert.ok(['add', 'remove', 'replace'].includes(op.op));
  }
  assert.deepEqual(body.forward, [
    { op: 'add', path: '/features/x', value: 1 },
    { op: 'replace', path: '/replicas', value: 3 },
    { op: 'remove', path: '/servers/0' },
  ]);
  assert.deepEqual(body.rollback, [
    { op: 'remove', path: '/features/x' },
    { op: 'replace', path: '/replicas', value: 2 },
    { op: 'add', path: '/servers/0', value: { host: 'a.internal' } },
  ]);
  assert.deepEqual(body.operationCount, {
    forward: { add: 1, remove: 1, replace: 1, total: 3 },
    rollback: { add: 1, remove: 1, replace: 1, total: 3 },
  });
});

test('round-trip-plan handles arrays with LCS and escaped object keys', async () => {
  const record = await createMerge({
    base: { list: [1, 2, 3, 2], 'a/b': 1 },
    patchA: [{ op: 'replace', path: '/list', value: [2, 3, 2, 9] }],
    patchB: [{ op: 'replace', path: '/a~1b', value: 7 }],
  });
  assert.equal(record.status, 'clean');
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${record.id}/round-trip-plan`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // Raw-key order "a/b" < "list". For the array, [2,3,2] is the LCS: base
  // index 0 (1) is removed and 9 appended, the equal elements stay in place.
  assert.deepEqual(body.forward, [
    { op: 'replace', path: '/a~1b', value: 7 },
    { op: 'remove', path: '/list/0' },
    { op: 'add', path: '/list/3', value: 9 },
  ]);
});

test('round-trip-plan emits element-level LCS ops for in-place array edits', async () => {
  const record = await createMerge({
    base: { list: [1, 2, 3, 4] },
    patchA: [{ op: 'replace', path: '/list/1', value: 20 }],
    patchB: [{ op: 'add', path: '/list/-', value: 5 }],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged.list, [1, 20, 3, 4, 5]);
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${record.id}/round-trip-plan`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // Kept by LCS: 1,3,4. 2 -> 20 removed+inserted; 5 appended.
  // removals descending, insertions ascending at final indices.
  assert.deepEqual(body.forward, [
    { op: 'remove', path: '/list/1' },
    { op: 'add', path: '/list/1', value: 20 },
    { op: 'add', path: '/list/4', value: 5 },
  ]);
  assert.deepEqual(body.rollback, [
    { op: 'remove', path: '/list/4' },
    { op: 'remove', path: '/list/1' },
    { op: 'add', path: '/list/1', value: 2 },
  ]);
  assert.deepEqual(body.merged.list, [1, 20, 3, 4, 5]);
});

test('round-trip-plan is byte-for-byte identical on repeated queries', async () => {
  const record = await createMerge(EXAMPLE_REQUEST);
  const url = `/api/v1/merges/${record.id}/round-trip-plan`;
  const first = await app.inject({ method: 'GET', url });
  const second = await app.inject({ method: 'GET', url });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body, second.body);
});

test('round-trip-plan on a conflict record returns 409 and does not modify it', async () => {
  const record = await createMerge(EXAMPLE_CONFLICT_REQUEST);
  assert.equal(record.status, 'conflict');
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${record.id}/round-trip-plan`,
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'Conflict');
  assert.match(res.json().message, /conflict/);
  // the stored record is untouched
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` });
  assert.equal(fetched.json().status, 'conflict');
  assert.equal(fetched.json().merged, null);
});

test('round-trip-plan for an unknown id returns 404', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/merges/no-such-record/round-trip-plan',
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});
