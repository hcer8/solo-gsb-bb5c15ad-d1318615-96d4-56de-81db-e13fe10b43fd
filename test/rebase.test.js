import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { mergePatches } from '../src/merge.js';
import { applyPatch } from '../src/roundtrip.js';
import { diffBaseCoordinates } from '../src/rebase.js';
import { EXAMPLE_REBASE_REQUEST, EXAMPLE_REBASE_CONFLICT_REQUEST } from '../src/example.js';

let app;

before(async () => {
  app = buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

/* ----------------------- diffBaseCoordinates (unit) ----------------------- */

test('base-coordinate diff: object members added, removed, replaced in key order', () => {
  const ops = diffBaseCoordinates(
    { keep: 1, drop: 2, change: 3 },
    { keep: 1, change: 30, fresh: 4 },
  );
  assert.deepEqual(ops, [
    { op: 'replace', path: '/change', value: 30 },
    { op: 'remove', path: '/drop' },
    { op: 'add', path: '/fresh', value: 4 },
  ]);
});

test('base-coordinate diff: deeply equal array elements are kept untouched', () => {
  const ops = diffBaseCoordinates(
    { list: [{ id: 1 }, { id: 2 }] },
    { list: [{ id: 1 }, { id: 2 }] },
  );
  assert.deepEqual(ops, []);
});

test('base-coordinate diff: unmatched elements become base-index removes and gap inserts', () => {
  // LCS keeps {id:2} (base index 1); {id:1} is removed and re-inserted.
  const ops = diffBaseCoordinates(
    { list: [{ id: 1 }, { id: 2 }] },
    { list: [{ id: 2 }, { id: 1 }, { id: 3 }] },
  );
  assert.deepEqual(ops, [
    { op: 'remove', path: '/list/0' },
    { op: 'add', path: '/list/2', value: { id: 1 } },
    { op: 'add', path: '/list/2', value: { id: 3 } },
  ]);
});

test('base-coordinate diff: consecutive insertions share the correct gap', () => {
  // Prepend run: both inserts land in gap 0, in onto order.
  assert.deepEqual(diffBaseCoordinates(['a', 'b'], ['x', 'y', 'a', 'b']), [
    { op: 'add', path: '/0', value: 'x' },
    { op: 'add', path: '/0', value: 'y' },
  ]);
  // Append run: both inserts land in the append gap (base length).
  assert.deepEqual(diffBaseCoordinates(['a'], ['a', 'x', 'y']), [
    { op: 'add', path: '/1', value: 'x' },
    { op: 'add', path: '/1', value: 'y' },
  ]);
  // Middle run between two kept neighbours.
  assert.deepEqual(diffBaseCoordinates(['a', 'b'], ['a', 'x', 'y', 'b']), [
    { op: 'add', path: '/1', value: 'x' },
    { op: 'add', path: '/1', value: 'y' },
  ]);
});

test('base-coordinate diff: container-kind change and root change replace wholesale', () => {
  assert.deepEqual(diffBaseCoordinates({ a: [1] }, { a: { b: 1 } }), [
    { op: 'replace', path: '/a', value: { b: 1 } },
  ]);
  assert.deepEqual(diffBaseCoordinates(1, { a: 1 }), [
    { op: 'replace', path: '', value: { a: 1 } },
  ]);
});

test('base-coordinate diff applied through the merge engine yields onto', () => {
  const cases = [
    [{ list: [1, 2, 3] }, { list: [3, 4, 1] }],
    [{ list: [] }, { list: [1, 2] }],
    [{ list: [1, 2] }, { list: [] }],
    [{ a: { b: [1, { c: 2 }] } }, { a: { b: [{ c: 2 }, 3] }, z: null }],
    [[1, 2, 2, 3], [2, 2, 4]],
    [{ n: 1 }, 5],
  ];
  for (const [base, onto] of cases) {
    const result = mergePatches(base, diffBaseCoordinates(base, onto), []);
    assert.equal(result.status, 'clean');
    assert.deepEqual(result.merged, onto);
  }
});

/* --------------------------- POST /api/v1/rebases -------------------------- */

test('rebase with the example payload is clean and the rebased patch replays to merged', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: EXAMPLE_REBASE_REQUEST,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'clean');
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.merged, {
    app: 'payment-service',
    replicas: 3,
    servers: [
      { host: 'b.internal', port: 8080 },
      { host: 'c.internal', port: 9090 },
    ],
    features: { cache: true, tracing: true, retries: 3 },
    region: 'eu-west',
  });
  // upstream delta in base coordinates: deep-equal server kept, a.internal
  // removed by base index, c.internal inserted into the append gap.
  assert.deepEqual(body.upstream, [
    { op: 'replace', path: '/features/tracing', value: true },
    { op: 'add', path: '/region', value: 'eu-west' },
    { op: 'remove', path: '/servers/0' },
    { op: 'add', path: '/servers/2', value: { host: 'c.internal', port: 9090 } },
  ]);
  // the rebased patch is expressed against onto and replays to merged
  for (const op of body.rebasedPatch) {
    assert.ok(['add', 'remove', 'replace'].includes(op.op));
  }
  assert.deepEqual(body.rebasedPatch, [
    { op: 'add', path: '/features/retries', value: 3 },
    { op: 'replace', path: '/replicas', value: 3 },
  ]);
  assert.deepEqual(applyPatch(EXAMPLE_REBASE_REQUEST.onto, body.rebasedPatch), body.merged);
});

test('rebase relocates client array edits around upstream removals', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: {
      base: { list: ['a', 'b', 'c'] },
      patch: [{ op: 'replace', path: '/list/2', value: 'C' }],
      onto: { list: ['b', 'c'] }, // upstream removed "a"
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.merged, { list: ['b', 'C'] });
  // the client edit followed base element "c" to its new index 1 (the
  // round-trip diff expresses the element change as remove + add)
  assert.deepEqual(body.rebasedPatch, [
    { op: 'remove', path: '/list/1' },
    { op: 'add', path: '/list/1', value: 'C' },
  ]);
  assert.deepEqual(applyPatch({ list: ['b', 'c'] }, body.rebasedPatch), body.merged);
});

test('rebase orders same-gap insertions upstream-first', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: {
      base: { list: ['a', 'b'] },
      patch: [{ op: 'add', path: '/list/1', value: 'y' }],
      onto: { list: ['a', 'x', 'b'] }, // upstream inserted "x" into gap 1
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.merged, { list: ['a', 'x', 'y', 'b'] });
  assert.deepEqual(body.rebasedPatch, [{ op: 'add', path: '/list/2', value: 'y' }]);
});

test('rebase conflict returns 409 with reasons, paths and both sides indices, no patch', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: EXAMPLE_REBASE_CONFLICT_REQUEST,
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.status, 'conflict');
  assert.equal(body.merged, null);
  assert.equal(body.rebasedPatch, null); // no executable patch on conflict
  assert.deepEqual(body.upstream, [
    { op: 'replace', path: '/mode', value: 'readonly' },
    { op: 'remove', path: '/servers/0' },
  ]);
  assert.equal(body.conflicts.length, 2);
  const [first, second] = body.conflicts;
  assert.equal(first.reason, 'replace-mismatch');
  assert.equal(first.path, '/mode');
  assert.deepEqual(
    first.operations.map((o) => [o.side, o.index]),
    [
      ['A', 0], // upstream op index in body.upstream
      ['B', 0], // client patch index
    ],
  );
  assert.equal(second.reason, 'delete-vs-modify');
  assert.equal(second.path, '/servers/0');
  assert.deepEqual(
    second.operations.map((o) => [o.side, o.index]),
    [
      ['A', 1],
      ['B', 1],
    ],
  );
});

test('rebase with an empty patch returns onto and an empty rebased patch', async () => {
  const onto = { a: 2, b: 3 };
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: { base: { a: 1 }, patch: [], onto },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.merged, onto);
  assert.deepEqual(body.rebasedPatch, []);
  assert.deepEqual(body.upstream, [
    { op: 'replace', path: '/a', value: 2 },
    { op: 'add', path: '/b', value: 3 },
  ]);
});

test('rebase when base equals onto rebases the patch unchanged', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: {
      base: { a: 1 },
      patch: [{ op: 'replace', path: '/a', value: 5 }],
      onto: { a: 1 },
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.upstream, []);
  assert.deepEqual(body.merged, { a: 5 });
  assert.deepEqual(body.rebasedPatch, [{ op: 'replace', path: '/a', value: 5 }]);
});

test('rebase supports a wholesale root replace', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: { base: 1, patch: [], onto: { a: 1 } },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.upstream, [{ op: 'replace', path: '', value: { a: 1 } }]);
  assert.deepEqual(body.merged, { a: 1 });
  // onto already equals the merged document, so nothing remains to rebase
  assert.deepEqual(body.rebasedPatch, []);
});

test('rebase rejects malformed bodies and unsupported ops (400)', async () => {
  for (const payload of [
    { base: {}, patch: [] }, // missing onto
    { base: {}, patch: {}, onto: {} }, // patch not an array
    { base: {}, patch: [{ op: 'move', from: '/a', path: '/b' }], onto: {} },
  ]) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/rebases', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('rebase with a patch that does not apply to base returns 422', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: {
      base: { a: 1 },
      patch: [{ op: 'remove', path: '/nope' }],
      onto: { a: 1 },
    },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'INVALID_PATCH');
  assert.equal(body.details.side, 'B');
  assert.equal(body.details.index, 0);
});

test('rebase is stateless and byte-for-byte deterministic on repeated requests', async () => {
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: EXAMPLE_REBASE_REQUEST,
  });
  const second = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: EXAMPLE_REBASE_REQUEST,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body, second.body);
  // nothing was stored
  const list = await app.inject({ method: 'GET', url: '/api/v1/merges' });
  assert.equal(list.json().total, 0);
});

test('GET /api/v1/example exposes rebase example payloads', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/example' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.rebaseRequest.base && body.rebaseRequest.patch && body.rebaseRequest.onto);
  assert.ok(body.rebaseConflictRequest.base && body.rebaseConflictRequest.onto);
});
