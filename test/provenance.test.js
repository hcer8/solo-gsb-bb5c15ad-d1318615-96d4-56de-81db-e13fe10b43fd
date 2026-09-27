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

async function createRecord(payload) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/merges', payload });
  return res.json();
}

async function getProvenance(id) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/merges/${id}/provenance` });
  assert.equal(res.statusCode, 200);
  return res.json();
}

/** Slim view: [path, source, ..."A#0"] per leaf, for compact assertions. */
function slim(leaves) {
  return leaves.map((l) => [
    l.path,
    l.source,
    ...l.operations.map((o) => `${o.side}#${o.index}`),
  ]);
}

/* ------------------------------ attribution ------------------------------ */

test('provenance attributes disjoint object writes to their sides', async () => {
  const record = await createRecord({
    base: { a: 1, b: 2, c: 3 },
    patchA: [{ op: 'replace', path: '/a', value: 10 }],
    patchB: [
      { op: 'replace', path: '/b', value: 20 },
      { op: 'add', path: '/d', value: 4 },
    ],
  });
  assert.equal(record.status, 'clean');

  const body = await getProvenance(record.id);
  assert.equal(body.id, record.id);
  assert.equal(body.createdAt, record.createdAt);
  assert.equal(body.status, 'clean');
  assert.deepEqual(slim(body.leaves), [
    ['/a', 'A', 'A#0'],
    ['/b', 'B', 'B#0'],
    ['/c', 'base'],
    ['/d', 'B', 'B#1'],
  ]);
  assert.deepEqual(body.summary, { total: 4, base: 1, A: 1, B: 2, both: 0 });
});

test('identical writes from both sides are reported as both (original indices)', async () => {
  const record = await createRecord({
    base: { x: 1, y: 2 },
    patchA: [{ op: 'replace', path: '/x', value: 5 }],
    patchB: [
      { op: 'add', path: '/n', value: { k: [1] } },
      { op: 'replace', path: '/x', value: 5 },
    ],
  });
  assert.equal(record.status, 'clean');
  assert.equal(record.stats.deduplicated, 1);

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/n/k/0', 'B', 'B#0'],
    ['/x', 'both', 'A#0', 'B#1'],
    ['/y', 'base'],
  ]);
  assert.deepEqual(body.summary, { total: 3, base: 1, A: 0, B: 1, both: 1 });
});

test('identical subtree adds from both sides mark every leaf as both', async () => {
  const record = await createRecord({
    base: {},
    patchA: [{ op: 'add', path: '/o', value: { a: 1, b: [2] } }],
    patchB: [{ op: 'add', path: '/o', value: { a: 1, b: [2] } }],
  });
  assert.equal(record.status, 'clean');

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/o/a', 'both', 'A#0', 'B#0'],
    ['/o/b/0', 'both', 'A#0', 'B#0'],
  ]);
});

test('intra-patch last-write-wins attributes only the surviving operation', async () => {
  const record = await createRecord({
    base: { k: 1 },
    patchA: [
      { op: 'replace', path: '/k', value: 2 },
      { op: 'replace', path: '/k', value: 3 },
    ],
    patchB: [],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged, { k: 3 });

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [['/k', 'A', 'A#1']]);
});

test('delete-then-recreate within one patch attributes the recreating operation', async () => {
  const record = await createRecord({
    base: { x: 1, keep: true },
    patchA: [
      { op: 'remove', path: '/x' },
      { op: 'add', path: '/x', value: 9 },
    ],
    patchB: [],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged, { x: 9, keep: true });

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/keep', 'base'],
    ['/x', 'A', 'A#1'],
  ]);
});

/* --------------------------- array relocation ---------------------------- */

test('array removal relocates surviving elements to their final pointers', async () => {
  const record = await createRecord({
    base: { list: ['a', 'b', 'c'] },
    patchA: [{ op: 'remove', path: '/list/0' }],
    patchB: [{ op: 'replace', path: '/list/2', value: 'C' }],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged.list, ['b', 'C']);

  const body = await getProvenance(record.id);
  // base[1] shifted to final index 0; B's edit to base[2] landed at index 1.
  assert.deepEqual(slim(body.leaves), [
    ['/list/0', 'base'],
    ['/list/1', 'B', 'B#0'],
  ]);
});

test('same-gap insertions keep A-before-B order at final indices', async () => {
  const record = await createRecord({
    base: { list: ['x', 'y'] },
    patchA: [{ op: 'add', path: '/list/1', value: 'from-A' }],
    patchB: [{ op: 'add', path: '/list/1', value: 'from-B' }],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged.list, ['x', 'from-A', 'from-B', 'y']);

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/list/0', 'base'],
    ['/list/1', 'A', 'A#0'],
    ['/list/2', 'B', 'B#0'],
    ['/list/3', 'base'],
  ]);
});

test('delete plus same-gap recreate is attributed at the final pointer', async () => {
  const record = await createRecord({
    base: { list: [{ id: 'a' }, { id: 'b' }] },
    patchA: [{ op: 'remove', path: '/list/0' }],
    patchB: [{ op: 'add', path: '/list/0', value: { id: 'new' } }],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged.list, [{ id: 'new' }, { id: 'b' }]);

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/list/0/id', 'B', 'B#0'],
    ['/list/1/id', 'base'],
  ]);
});

test('deep edits follow relocated array elements by base identity', async () => {
  const record = await createRecord({
    base: { servers: [{ host: 'a' }, { host: 'b' }] },
    patchA: [{ op: 'add', path: '/servers/0', value: { host: 'new' } }],
    patchB: [{ op: 'replace', path: '/servers/1/host', value: 'B' }],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged.servers, [{ host: 'new' }, { host: 'a' }, { host: 'B' }]);

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/servers/0/host', 'A', 'A#0'],
    ['/servers/1/host', 'base'],
    ['/servers/2/host', 'B', 'B#0'],
  ]);
});

test('the canned example attributes every leaf of the merged document', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  assert.equal(record.status, 'clean');

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/app', 'base'],
    ['/features/cache', 'base'],
    ['/features/retries', 'B', 'B#2'],
    ['/features/tracing', 'both', 'A#2', 'B#3'],
    ['/replicas', 'A', 'A#0'],
    ['/servers/0/host', 'A', 'A#1'],
    ['/servers/0/port', 'A', 'A#1'],
    ['/servers/1/host', 'B', 'B#1'],
    ['/servers/1/port', 'B', 'B#1'],
    ['/servers/2/host', 'base'],
    ['/servers/2/port', 'base'],
    ['/tags/0', 'base'],
  ]);
  assert.deepEqual(body.summary, { total: 12, base: 5, A: 3, B: 3, both: 1 });
});

/* ------------------------------ leaf shapes ------------------------------ */

test('empty containers are leaves, attributed to whoever wrote them last', async () => {
  const record = await createRecord({
    base: { e: {}, keep: [[]] },
    patchA: [{ op: 'add', path: '/n', value: [] }],
    patchB: [{ op: 'replace', path: '/e', value: {} }],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged, { e: {}, keep: [[]], n: [] });

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/e', 'B', 'B#0'],
    ['/keep/0', 'base'],
    ['/n', 'A', 'A#0'],
  ]);
});

test('empty base containers receiving operations stay structural', async () => {
  const record = await createRecord({
    base: { arr: [], obj: {} },
    patchA: [{ op: 'add', path: '/arr/0', value: 'x' }],
    patchB: [{ op: 'add', path: '/obj/k', value: 1 }],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged, { arr: ['x'], obj: { k: 1 } });

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/arr/0', 'A', 'A#0'],
    ['/obj/k', 'B', 'B#0'],
  ]);
});

test('a container emptied by removals is a base leaf', async () => {
  const record = await createRecord({
    base: { o: { x: 1 }, l: [1] },
    patchA: [
      { op: 'remove', path: '/o/x' },
      { op: 'remove', path: '/l/0' },
    ],
    patchB: [],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged, { o: {}, l: [] });

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/l', 'base'],
    ['/o', 'base'],
  ]);
});

test('root replace attributes every leaf to the writer', async () => {
  const record = await createRecord({
    base: { v: 1 },
    patchA: [{ op: 'replace', path: '', value: [10, 20] }],
    patchB: [],
  });
  assert.equal(record.status, 'clean');

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/0', 'A', 'A#0'],
    ['/1', 'A', 'A#0'],
  ]);
});

test('scalar roots are single leaves at the empty pointer', async () => {
  const replaced = await createRecord({
    base: { v: 1 },
    patchA: [{ op: 'replace', path: '', value: 5 }],
    patchB: [],
  });
  assert.equal(replaced.status, 'clean');
  const body = await getProvenance(replaced.id);
  assert.deepEqual(slim(body.leaves), [['', 'A', 'A#0']]);
  assert.deepEqual(body.summary, { total: 1, base: 0, A: 1, B: 0, both: 0 });

  const untouched = await createRecord({ base: 5, patchA: [], patchB: [] });
  assert.equal(untouched.status, 'clean');
  const body2 = await getProvenance(untouched.id);
  assert.deepEqual(slim(body2.leaves), [['', 'base']]);
});

test('escaped keys are reported as RFC 6901 pointers and sorted', async () => {
  const record = await createRecord({
    base: { 'a/b': 1, 'a~b': 2, z: 3 },
    patchA: [{ op: 'replace', path: '/a~1b', value: 10 }],
    patchB: [{ op: 'replace', path: '/a~0b', value: 20 }],
  });
  assert.equal(record.status, 'clean');

  const body = await getProvenance(record.id);
  assert.deepEqual(slim(body.leaves), [
    ['/a~0b', 'B', 'B#0'],
    ['/a~1b', 'A', 'A#0'],
    ['/z', 'base'],
  ]);
});

test('leaves are sorted by pointer in UTF-16 code-unit order', async () => {
  const record = await createRecord({
    base: { l: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    patchA: [],
    patchB: [],
  });
  assert.equal(record.status, 'clean');

  const body = await getProvenance(record.id);
  const paths = body.leaves.map((l) => l.path);
  // String order, not numeric order: "/l/10" sorts before "/l/2".
  assert.deepEqual(paths, [
    '/l/0',
    '/l/1',
    '/l/10',
    '/l/2',
    '/l/3',
    '/l/4',
    '/l/5',
    '/l/6',
    '/l/7',
    '/l/8',
    '/l/9',
  ]);
  assert.ok(body.leaves.every((l) => l.source === 'base' && l.operations.length === 0));
});

/* --------------------------- status & caching ---------------------------- */

test('provenance on a conflict record returns 409 and does not modify it', async () => {
  const record = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  assert.equal(record.status, 'conflict');

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/merges/${record.id}/provenance`,
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'Conflict');
  assert.match(res.json().message, /conflict/);

  // the stored record is untouched
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` });
  assert.equal(fetched.json().status, 'conflict');
  assert.equal(fetched.json().merged, null);
});

test('provenance for an unknown id returns 404', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/merges/no-such-record/provenance',
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

test('provenance answers are byte-for-byte identical on repeated queries', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const url = `/api/v1/merges/${record.id}/provenance`;
  const first = await app.inject({ method: 'GET', url });
  const second = await app.inject({ method: 'GET', url });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body, second.body);
  assert.deepEqual(first.json(), second.json());
});
