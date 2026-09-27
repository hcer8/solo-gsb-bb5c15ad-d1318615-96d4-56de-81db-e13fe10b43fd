import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import {
  previewOwnership,
  validateOwnershipRules,
  OwnershipError,
  OWNERSHIP_CODES,
  OWNERSHIP_REASONS,
} from '../src/ownership.js';
import {
  EXAMPLE_REQUEST,
  EXAMPLE_CONFLICT_REQUEST,
  EXAMPLE_OWNERSHIP_PREVIEW_REQUEST,
} from '../src/example.js';
import { readFileSync } from 'node:fs';

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

function preview(id, rules) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/merges/${id}/ownership-preview`,
    payload: { rules },
  });
}

/* ------------------------------- happy path ------------------------------ */

test('ownership preview on the canned example reports every violation kind in processing order', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  assert.equal(record.status, 'clean');
  const res = await preview(record.id, EXAMPLE_OWNERSHIP_PREVIEW_REQUEST.rules);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, record.id);
  assert.equal(body.status, 'clean');
  assert.ok(body.createdAt);
  assert.deepEqual(body.rules, EXAMPLE_OWNERSHIP_PREVIEW_REQUEST.rules);
  assert.equal(body.publishable, false);

  // A#1 inserts into B-owned /servers; B#0 removes /servers/0 and clobbers
  // the A-owned descendant rule /servers/0/host; B#2 and B#3 write under
  // A-owned /features. A#0, A#2 and B#1 are owned by their own side.
  assert.deepEqual(body.violations, [
    {
      side: 'A',
      index: 1,
      op: 'add',
      path: '/servers/1',
      rule: { prefix: '/servers', owner: 'B' },
      reason: 'owned-by-other',
    },
    {
      side: 'B',
      index: 0,
      op: 'remove',
      path: '/servers/0',
      rule: { prefix: '/servers/0/host', owner: 'A' },
      reason: 'descendant-owned-by-other',
    },
    {
      side: 'B',
      index: 2,
      op: 'add',
      path: '/features/retries',
      rule: { prefix: '/features', owner: 'A' },
      reason: 'owned-by-other',
    },
    {
      side: 'B',
      index: 3,
      op: 'replace',
      path: '/features/tracing',
      rule: { prefix: '/features', owner: 'A' },
      reason: 'owned-by-other',
    },
  ]);
  assert.deepEqual(body.summary, {
    total: 4,
    bySide: { A: 1, B: 3 },
    byReason: {
      'uncovered-path': 0,
      'owned-by-other': 3,
      'descendant-owned-by-other': 1,
    },
  });
});

test('fully owned patches are publishable with an empty violation list', async () => {
  const record = await createRecord({
    base: { replicas: 2, features: { tracing: false }, tags: ['stable'] },
    patchA: [
      { op: 'replace', path: '/replicas', value: 3 },
      { op: 'replace', path: '/features/tracing', value: true },
    ],
    patchB: [
      { op: 'add', path: '/tags/-', value: 'canary' },
      { op: 'add', path: '/features/retries', value: 3 },
    ],
  });
  assert.equal(record.status, 'clean');
  const res = await preview(record.id, [
    { prefix: '/replicas', owner: 'A' },
    { prefix: '/features', owner: 'A' },
    { prefix: '/features/retries', owner: 'B' },
    { prefix: '/tags', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.publishable, true);
  assert.deepEqual(body.violations, []);
  assert.deepEqual(body.summary, {
    total: 0,
    bySide: { A: 0, B: 0 },
    byReason: {
      'uncovered-path': 0,
      'owned-by-other': 0,
      'descendant-owned-by-other': 0,
    },
  });
});

test('an empty rules list leaves every operation uncovered', async () => {
  const record = await createRecord({
    base: { a: 1 },
    patchA: [{ op: 'replace', path: '/a', value: 2 }],
    patchB: [],
  });
  const res = await preview(record.id, []);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.publishable, false);
  assert.deepEqual(body.violations, [
    { side: 'A', index: 0, op: 'replace', path: '/a', rule: null, reason: 'uncovered-path' },
  ]);
  assert.equal(body.summary.byReason['uncovered-path'], 1);
});

test('longest matching prefix wins over broader rules', async () => {
  const record = await createRecord({
    base: { features: { tracing: false, cache: true } },
    patchA: [{ op: 'replace', path: '/features/tracing', value: true }],
    patchB: [{ op: 'replace', path: '/features/cache', value: false }],
  });
  const res = await preview(record.id, [
    { prefix: '/features', owner: 'A' },
    { prefix: '/features/cache', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // /features/tracing resolves to A via /features; /features/cache resolves
  // to B via the longer, more specific rule.
  assert.equal(body.publishable, true);
  assert.deepEqual(body.violations, []);
});

test('array insertions are owned by the parent array, not by element-index rules', async () => {
  const record = await createRecord({
    base: { list: ['x', 'y'] },
    patchA: [{ op: 'add', path: '/list/1', value: 'a' }],
    patchB: [{ op: 'add', path: '/list/-', value: 'b' }],
  });
  // A rule at the exact insertion index does not capture the insertion:
  // only the parent path /list is matched, and it is uncovered here.
  const uncovered = await preview(record.id, [{ prefix: '/list/1', owner: 'A' }]);
  assert.equal(uncovered.statusCode, 200);
  assert.deepEqual(
    uncovered.json().violations.map((v) => [v.side, v.index, v.reason]),
    [
      ['A', 0, 'uncovered-path'],
      ['B', 0, 'uncovered-path'],
    ],
  );
  // Owning the parent array covers insertions from both gaps (index and "-").
  const owned = await preview(record.id, [{ prefix: '/list', owner: 'A' }]);
  assert.deepEqual(
    owned.json().violations.map((v) => [v.side, v.index, v.rule]),
    [['B', 0, { prefix: '/list', owner: 'A' }]],
  );
});

test('object member adds are matched at the member path itself', async () => {
  const record = await createRecord({
    base: { features: {} },
    patchA: [],
    patchB: [{ op: 'add', path: '/features/retries', value: 3 }],
  });
  const res = await preview(record.id, [
    { prefix: '/features', owner: 'A' },
    { prefix: '/features/retries', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  // the exact member rule (longest prefix) assigns the new member to B
  assert.equal(res.json().publishable, true);
});

test('the descendant guard fires for replace, remove and add-overwriting-member', async () => {
  const record = await createRecord({
    base: { a: { x: 1 }, b: { x: 1 }, c: { x: 1 } },
    patchA: [
      { op: 'replace', path: '/a', value: {} },
      { op: 'remove', path: '/b' },
      { op: 'add', path: '/c', value: {} }, // add on an existing member == replace
    ],
    patchB: [],
  });
  const res = await preview(record.id, [
    { prefix: '/a', owner: 'A' },
    { prefix: '/a/x', owner: 'B' },
    { prefix: '/b', owner: 'A' },
    { prefix: '/b/x', owner: 'B' },
    { prefix: '/c', owner: 'A' },
    { prefix: '/c/x', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.publishable, false);
  // each subtree write is owned by A at its own path but clobbers a B-owned
  // descendant rule
  assert.deepEqual(
    body.violations.map((v) => [v.index, v.op, v.reason, v.rule.prefix]),
    [
      [0, 'replace', 'descendant-owned-by-other', '/a/x'],
      [1, 'remove', 'descendant-owned-by-other', '/b/x'],
      [2, 'add', 'descendant-owned-by-other', '/c/x'],
    ],
  );
});

test('the descendant guard ignores own-side and non-descendant rules', async () => {
  const record = await createRecord({
    base: { a: { x: 1, y: 2 }, z: 1 },
    patchA: [{ op: 'replace', path: '/a', value: {} }],
    patchB: [],
  });
  const res = await preview(record.id, [
    { prefix: '/a', owner: 'A' },
    { prefix: '/a/x', owner: 'A' }, // own side: no violation
    { prefix: '/z', owner: 'B' }, // not under the target: no violation
  ]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().publishable, true);
});

test('a root replace is checked against the root rule and every descendant rule', async () => {
  const record = await createRecord({
    base: { a: 1 },
    patchA: [{ op: 'replace', path: '', value: { a: 2 } }],
    patchB: [],
  });
  // no "" rule: the root itself is uncovered, and /b is B-owned territory
  const res = await preview(record.id, [
    { prefix: '/a', owner: 'A' },
    { prefix: '/b', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().violations.map((v) => [v.reason, v.rule && v.rule.prefix]),
    [
      ['uncovered-path', null],
      ['descendant-owned-by-other', '/b'],
    ],
  );
  // with a root rule owned by A only the descendant violation remains
  const rooted = await preview(record.id, [
    { prefix: '', owner: 'A' },
    { prefix: '/b', owner: 'B' },
  ]);
  assert.deepEqual(rooted.json().violations.map((v) => v.reason), [
    'descendant-owned-by-other',
  ]);
});

test('every original operation is checked, including intra-patch overridden ones', async () => {
  const record = await createRecord({
    base: { a: 1 },
    patchA: [
      { op: 'replace', path: '/a', value: 2 },
      { op: 'replace', path: '/a', value: 3 }, // last-wins over A#0
    ],
    patchB: [],
  });
  const res = await preview(record.id, [{ prefix: '/a', owner: 'B' }]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().violations.map((v) => [v.side, v.index, v.reason]),
    [
      ['A', 0, 'owned-by-other'],
      ['A', 1, 'owned-by-other'],
    ],
  );
});

test('ownership preview also works on conflict records', async () => {
  const record = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  assert.equal(record.status, 'conflict');
  const res = await preview(record.id, [
    { prefix: '/database', owner: 'B' },
    { prefix: '/mode', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'conflict');
  assert.equal(body.publishable, false);
  // A#0 removes B-owned /database, A#1 replaces B-owned /mode
  assert.deepEqual(
    body.violations.map((v) => [v.side, v.index, v.reason]),
    [
      ['A', 0, 'owned-by-other'],
      ['A', 1, 'owned-by-other'],
    ],
  );
  // the record itself is untouched
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` });
  assert.equal(fetched.json().status, 'conflict');
  assert.equal(fetched.json().merged, null);
});

/* -------------------------- determinism / no mutation --------------------- */

test('ownership preview does not modify the stored record and is byte-for-byte deterministic', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const rules = EXAMPLE_OWNERSHIP_PREVIEW_REQUEST.rules;
  const first = await preview(record.id, rules);
  const second = await preview(record.id, rules);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, second.body);

  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` });
  const stored = fetched.json();
  assert.equal(stored.status, 'clean');
  assert.deepEqual(stored.base, EXAMPLE_REQUEST.base);
  assert.deepEqual(stored.patchA, EXAMPLE_REQUEST.patchA);
  assert.deepEqual(stored.patchB, EXAMPLE_REQUEST.patchB);
  assert.deepEqual(stored.merged, record.merged);
});

/* ------------------------------ 422 / 400 / 404 --------------------------- */

test('invalid rules return 422 INVALID_RULES with every problem collected', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const res = await preview(record.id, [
    5,
    { owner: 'A' },
    { prefix: '/missing-owner' },
    { prefix: '/bad-owner', owner: 'C' },
    { prefix: 'a', owner: 'A' },
    { prefix: '/a~2b', owner: 'A' },
    { prefix: '/dup', owner: 'A' },
    { prefix: '/dup', owner: 'B' },
    { prefix: '/extra', owner: 'A', note: 'x' },
    { prefix: 42, owner: 'A' },
  ]);
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error, 'Unprocessable Entity');
  assert.equal(body.code, 'INVALID_RULES');
  assert.equal(body.invalid.length, 9);
  assert.deepEqual(
    body.invalid.map((e) => e.index),
    [0, 1, 2, 3, 4, 5, 7, 8, 9],
  );
  assert.equal(body.invalid[0].prefix, null);
  assert.match(body.invalid[0].issues[0], /must be an object/);
  assert.match(body.invalid[1].issues[0], /"prefix" must be a JSON Pointer string/);
  assert.match(body.invalid[2].issues[0], /"owner" must be "A" or "B"/);
  assert.match(body.invalid[3].issues[0], /"owner" must be "A" or "B"/);
  assert.match(body.invalid[4].issues[0], /not a valid JSON Pointer/);
  assert.match(body.invalid[5].issues[0], /not a valid JSON Pointer/);
  assert.match(body.invalid[6].issues[0], /duplicate rule prefix "\/dup"/);
  assert.match(body.invalid[7].issues[0], /unknown property "note"/);
  assert.equal(body.invalid[8].prefix, null);
});

test('duplicate prefixes are detected by canonical form, not raw string', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const res = await preview(record.id, [
    { prefix: '/a~1b', owner: 'A' },
    { prefix: '/a~1b', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 422);
  assert.match(res.json().invalid[0].issues[0], /duplicate rule prefix "\/a~1b"/);
});

test('malformed top-level bodies return 400, not 422', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  // missing required "rules"
  const missing = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/ownership-preview`,
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
  // a non-array `rules` is coerced to a single-element array whose non-object
  // "rule" is reported as invalid (422), same as constraint-preview
  const coerced = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/ownership-preview`,
    payload: { rules: 'nope' },
  });
  assert.equal(coerced.statusCode, 422);
  assert.equal(coerced.json().code, 'INVALID_RULES');
  assert.match(coerced.json().invalid[0].issues[0], /must be an object/);
});

test('ownership preview for an unknown id returns 404', async () => {
  const res = await preview('does-not-exist', []);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

/* ------------------------------ example file ----------------------------- */

test('examples/ownership-preview-request.json mirrors the canned example and works end-to-end', async () => {
  const fromDisk = JSON.parse(
    readFileSync(new URL('../examples/ownership-preview-request.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(fromDisk, EXAMPLE_OWNERSHIP_PREVIEW_REQUEST);
  const record = await createRecord(EXAMPLE_REQUEST);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/ownership-preview`,
    payload: fromDisk,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.publishable, false);
  assert.equal(body.summary.total, 4);
  assert.equal(body.summary.byReason['owned-by-other'], 3);
  assert.equal(body.summary.byReason['descendant-owned-by-other'], 1);
});

/* --------------------------------- units --------------------------------- */

test('validateOwnershipRules normalizes valid rules (canonical prefix, root, escapes)', () => {
  const normalized = validateOwnershipRules([
    { prefix: '/a~1b/0', owner: 'A' },
    { prefix: '', owner: 'B' },
  ]);
  assert.deepEqual(normalized[0], { prefix: '/a~1b/0', owner: 'A', tokens: ['a/b', '0'] });
  assert.deepEqual(normalized[1], { prefix: '', owner: 'B', tokens: [] });
});

test('validateOwnershipRules rejects invalid rules with OwnershipError(INVALID_RULES)', () => {
  assert.throws(
    () => validateOwnershipRules([{ prefix: '/a', owner: 'both' }]),
    (err) =>
      err instanceof OwnershipError &&
      err.code === OWNERSHIP_CODES.INVALID_RULES &&
      err.details.invalid.length === 1 &&
      err.details.invalid[0].index === 0 &&
      /"owner" must be "A" or "B"/.test(err.details.invalid[0].issues[0]),
  );
});

test('previewOwnership is a pure function of the record and rules', () => {
  const record = {
    id: 'x',
    status: 'clean',
    base: { a: { x: 1 }, list: [1] },
    patchA: [
      { op: 'replace', path: '/a', value: {} },
      { op: 'add', path: '/list/-', value: 2 },
    ],
    patchB: [],
    merged: { a: {}, list: [1, 2] },
  };
  const snapshot = structuredClone(record);
  const rules = validateOwnershipRules([
    { prefix: '/a', owner: 'A' },
    { prefix: '/a/x', owner: 'B' },
    { prefix: '/list', owner: 'A' },
  ]);
  const r1 = previewOwnership(record, rules);
  const r2 = previewOwnership(record, rules);
  assert.deepEqual(r1, r2);
  assert.equal(r1.publishable, false);
  assert.deepEqual(r1.violations, [
    {
      side: 'A',
      index: 0,
      op: 'replace',
      path: '/a',
      rule: { prefix: '/a/x', owner: 'B' },
      reason: OWNERSHIP_REASONS.DESCENDANT_OWNED_BY_OTHER,
    },
  ]);
  assert.deepEqual(record, snapshot); // record untouched
});
