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

test('ownership preview on the canned example reports every violation kind', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  assert.equal(record.status, 'clean');
  const res = await preview(record.id, EXAMPLE_OWNERSHIP_PREVIEW_REQUEST.rules);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, record.id);
  assert.equal(body.status, 'clean');
  assert.ok(body.createdAt);
  assert.equal(body.publishable, false);

  // A#0 replaces /replicas, which no rule covers.
  // A#1 inserts into /servers, owned by B (parent-array attribution).
  // A#2 replaces /features/tracing, owned by B (longest prefix).
  // B#0 removes /servers/0 (owned by B via /servers) but A owns the nested
  //     /servers/0/host rule -> descendant violation.
  // B#1 inserts into its own /servers -> ok.
  // B#2 adds /features/retries under A's /features -> owned-by-other.
  // B#3 replaces /features/tracing, owned by B -> ok.
  assert.deepEqual(body.violations, [
    { side: 'A', index: 0, op: 'replace', path: '/replicas',
      reason: 'uncovered-path', rule: null },
    { side: 'A', index: 1, op: 'add', path: '/servers/1',
      reason: 'owned-by-other', rule: { prefix: '/servers', owner: 'B' } },
    { side: 'A', index: 2, op: 'replace', path: '/features/tracing',
      reason: 'owned-by-other', rule: { prefix: '/features/tracing', owner: 'B' } },
    { side: 'B', index: 0, op: 'remove', path: '/servers/0',
      reason: 'descendant-owned-by-other', rule: { prefix: '/servers/0/host', owner: 'A' } },
    { side: 'B', index: 2, op: 'add', path: '/features/retries',
      reason: 'owned-by-other', rule: { prefix: '/features', owner: 'A' } },
  ]);
  assert.deepEqual(body.summary, {
    operations: { A: 3, B: 4, total: 7 },
    violations: 5,
    byReason: { 'uncovered-path': 1, 'owned-by-other': 3, 'descendant-owned-by-other': 1 },
    bySide: { A: 3, B: 2 },
  });
});

test('fully owned operations are publishable with no violations', async () => {
  const record = await createRecord({
    base: { cfg: { a: 1, b: 2 }, list: [1, 2] },
    patchA: [{ op: 'replace', path: '/cfg/a', value: 10 }],
    patchB: [
      { op: 'add', path: '/list/-', value: 3 },
      { op: 'replace', path: '/cfg/b', value: 20 },
    ],
  });
  assert.equal(record.status, 'clean');
  const res = await preview(record.id, [
    { prefix: '/cfg/a', owner: 'A' },
    { prefix: '/cfg/b', owner: 'B' },
    { prefix: '/list', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.publishable, true);
  assert.deepEqual(body.violations, []);
  assert.deepEqual(body.summary, {
    operations: { A: 1, B: 2, total: 3 },
    violations: 0,
    byReason: { 'uncovered-path': 0, 'owned-by-other': 0, 'descendant-owned-by-other': 0 },
    bySide: { A: 0, B: 0 },
  });
});

test('the longest matching prefix decides ownership', async () => {
  const record = await createRecord({
    base: { cfg: { inner: { x: 1 }, other: 2 } },
    patchA: [{ op: 'replace', path: '/cfg/inner/x', value: 9 }],
    patchB: [{ op: 'replace', path: '/cfg/other', value: 3 }],
  });
  const res = await preview(record.id, [
    { prefix: '/cfg', owner: 'A' },
    { prefix: '/cfg/inner', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // A edits under B's nested territory, B edits under A's outer territory.
  assert.deepEqual(body.violations, [
    { side: 'A', index: 0, op: 'replace', path: '/cfg/inner/x',
      reason: 'owned-by-other', rule: { prefix: '/cfg/inner', owner: 'B' } },
    { side: 'B', index: 0, op: 'replace', path: '/cfg/other',
      reason: 'owned-by-other', rule: { prefix: '/cfg', owner: 'A' } },
  ]);
});

test('array inserts are attributed to the parent array, not the element path', async () => {
  const record = await createRecord({
    base: { list: [1, 2] },
    patchA: [{ op: 'add', path: '/list/0', value: 0 }],
    patchB: [],
  });
  // A rule on the element path alone does not cover the insertion position:
  // the parent array /list itself is uncovered.
  const uncovered = await preview(record.id, [{ prefix: '/list/0', owner: 'A' }]);
  assert.equal(uncovered.statusCode, 200);
  assert.deepEqual(uncovered.json().violations, [
    { side: 'A', index: 0, op: 'add', path: '/list/0',
      reason: 'uncovered-path', rule: null },
  ]);
  // Owning the parent array covers insertions at any gap, including "-".
  const record2 = await createRecord({
    base: { list: [1, 2] },
    patchA: [{ op: 'add', path: '/list/-', value: 3 }],
    patchB: [{ op: 'add', path: '/list/0', value: 0 }],
  });
  const owned = await preview(record2.id, [{ prefix: '/list', owner: 'A' }]);
  assert.equal(owned.statusCode, 200);
  assert.deepEqual(owned.json().violations, [
    { side: 'B', index: 0, op: 'add', path: '/list/0',
      reason: 'owned-by-other', rule: { prefix: '/list', owner: 'A' } },
  ]);
});

test('replace/remove over other-side descendant rules are flagged per rule', async () => {
  const record = await createRecord({
    base: { cfg: { x: 1, y: 2 }, gone: { z: 3 } },
    patchA: [
      { op: 'replace', path: '/cfg', value: { x: 1 } },
      { op: 'remove', path: '/gone' },
    ],
    patchB: [],
  });
  const res = await preview(record.id, [
    { prefix: '/cfg', owner: 'A' },
    { prefix: '/cfg/x', owner: 'B' },
    { prefix: '/cfg/y', owner: 'B' },
    { prefix: '/gone', owner: 'A' },
    { prefix: '/gone/z', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // The operations' own paths are owned by A, but each other-side rule
  // nested below the targets is reported (sorted by prefix).
  assert.deepEqual(body.violations, [
    { side: 'A', index: 0, op: 'replace', path: '/cfg',
      reason: 'descendant-owned-by-other', rule: { prefix: '/cfg/x', owner: 'B' } },
    { side: 'A', index: 0, op: 'replace', path: '/cfg',
      reason: 'descendant-owned-by-other', rule: { prefix: '/cfg/y', owner: 'B' } },
    { side: 'A', index: 1, op: 'remove', path: '/gone',
      reason: 'descendant-owned-by-other', rule: { prefix: '/gone/z', owner: 'B' } },
  ]);
  assert.equal(body.summary.byReason['descendant-owned-by-other'], 3);
});

test('same-side descendant rules do not violate, and pure adds skip the descendant check', async () => {
  const record = await createRecord({
    base: { cfg: { x: 1 } },
    patchA: [
      { op: 'replace', path: '/cfg', value: { x: 2 } },
      { op: 'add', path: '/fresh', value: { deep: 1 } },
    ],
    patchB: [],
  });
  const res = await preview(record.id, [
    { prefix: '/cfg', owner: 'A' },
    { prefix: '/cfg/x', owner: 'A' }, // same side: protected, not violated
    { prefix: '/fresh', owner: 'A' },
    { prefix: '/fresh/deep', owner: 'B' }, // pure add of a new member: not checked
  ]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().publishable, true);
  assert.deepEqual(res.json().violations, []);
});

test('an add overwriting an existing object member is treated as replace for the descendant check', async () => {
  const record = await createRecord({
    base: { cfg: { x: 1 } },
    patchA: [{ op: 'add', path: '/cfg', value: { x: 9 } }],
    patchB: [],
  });
  const res = await preview(record.id, [
    { prefix: '/cfg', owner: 'A' },
    { prefix: '/cfg/x', owner: 'B' },
  ]);
  assert.equal(res.statusCode, 200);
  // The original op is reported verbatim ("add") while the descendant
  // protection of the normalized replace still applies.
  assert.deepEqual(res.json().violations, [
    { side: 'A', index: 0, op: 'add', path: '/cfg',
      reason: 'descendant-owned-by-other', rule: { prefix: '/cfg/x', owner: 'B' } },
  ]);
});

test('every original operation is checked, even ones the merge would drop', async () => {
  // Intra-patch last-wins: the merge keeps only the second replace, but the
  // preview checks both submitted operations.
  const record = await createRecord({
    base: { a: 1 },
    patchA: [
      { op: 'replace', path: '/a', value: 2 },
      { op: 'replace', path: '/a', value: 3 },
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

test('root-level operations are attributed by the root prefix rule', async () => {
  const record = await createRecord({
    base: { a: 1 },
    patchA: [{ op: 'replace', path: '', value: { a: 2 } }],
    patchB: [],
  });
  // Root rule owned by the other side -> owned-by-other at "".
  const foreign = await preview(record.id, [{ prefix: '', owner: 'B' }]);
  assert.deepEqual(foreign.json().violations, [
    { side: 'A', index: 0, op: 'replace', path: '',
      reason: 'owned-by-other', rule: { prefix: '', owner: 'B' } },
  ]);
  // Root owned by A, but the whole-document replace overrides B's nested
  // territory -> descendant violation.
  const nested = await preview(record.id, [
    { prefix: '', owner: 'A' },
    { prefix: '/a', owner: 'B' },
  ]);
  assert.deepEqual(nested.json().violations, [
    { side: 'A', index: 0, op: 'replace', path: '',
      reason: 'descendant-owned-by-other', rule: { prefix: '/a', owner: 'B' } },
  ]);
  // Root owned by A alone -> publishable.
  const owned = await preview(record.id, [{ prefix: '', owner: 'A' }]);
  assert.equal(owned.json().publishable, true);
});

test('RFC 6901 escapes in prefixes match the corresponding operation paths', async () => {
  const record = await createRecord({
    base: { 'a/b': { 'x~y': 1 } },
    patchA: [{ op: 'replace', path: '/a~1b/x~0y', value: 2 }],
    patchB: [],
  });
  const res = await preview(record.id, [{ prefix: '/a~1b', owner: 'B' }]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().violations, [
    { side: 'A', index: 0, op: 'replace', path: '/a~1b/x~0y',
      reason: 'owned-by-other', rule: { prefix: '/a~1b', owner: 'B' } },
  ]);
  const owned = await preview(record.id, [{ prefix: '/a~1b/x~0y', owner: 'A' }]);
  assert.equal(owned.json().publishable, true);
});

test('an empty rules list leaves every operation uncovered', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const res = await preview(record.id, []);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.publishable, false);
  assert.equal(body.violations.length, 7);
  assert.ok(body.violations.every((v) => v.reason === 'uncovered-path' && v.rule === null));
  assert.equal(body.summary.byReason['uncovered-path'], 7);
});

test('empty patches are publishable even with no rules', async () => {
  const record = await createRecord({ base: { a: 1 }, patchA: [], patchB: [] });
  const res = await preview(record.id, []);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.publishable, true);
  assert.deepEqual(body.violations, []);
  assert.deepEqual(body.summary.operations, { A: 0, B: 0, total: 0 });
});

/* ------------------------- any record status works ------------------------ */

test('ownership preview also works on conflict records (no 409)', async () => {
  const record = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  assert.equal(record.status, 'conflict');
  const res = await preview(record.id, [
    { prefix: '/database', owner: 'A' },
    { prefix: '/mode', owner: 'A' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'conflict');
  assert.equal(body.publishable, false);
  assert.deepEqual(body.violations, [
    { side: 'B', index: 0, op: 'replace', path: '/database/host',
      reason: 'owned-by-other', rule: { prefix: '/database', owner: 'A' } },
    { side: 'B', index: 1, op: 'replace', path: '/mode',
      reason: 'owned-by-other', rule: { prefix: '/mode', owner: 'A' } },
  ]);
  // the stored record is untouched
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
    { prefix: '/a' },
    { prefix: '/a', owner: 'C' },
    { prefix: '/a', owner: 'A' },
    { prefix: '/a', owner: 'B' },
    { prefix: 'a', owner: 'A' },
    { prefix: '/a~2b', owner: 'A' },
    { prefix: '/b', owner: 'A', note: 'x' },
    { prefix: 42, owner: 'A' },
  ]);
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error, 'Unprocessable Entity');
  assert.equal(body.code, 'INVALID_RULES');
  // Index 2 has a valid prefix (it claims "/a" in the duplicate registry)
  // but no owner, so the "/a" rules at indices 3-5 are all duplicates of
  // index 2; index 3 additionally carries its invalid owner.
  assert.equal(body.invalid.length, 10);
  assert.deepEqual(
    body.invalid.map((e) => e.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(body.invalid[0].prefix, null);
  assert.match(body.invalid[0].issues[0], /must be an object/);
  assert.match(body.invalid[1].issues[0], /"prefix" must be a JSON Pointer string/);
  assert.match(body.invalid[2].issues[0], /"owner" must be "A" or "B"/);
  assert.equal(body.invalid[3].issues.length, 2);
  assert.match(body.invalid[3].issues[0], /duplicate rule prefix "\/a" \(first used at index 2\)/);
  assert.match(body.invalid[3].issues[1], /"owner" must be "A" or "B"/);
  assert.match(body.invalid[4].issues[0], /duplicate rule prefix "\/a" \(first used at index 2\)/);
  assert.match(body.invalid[5].issues[0], /duplicate rule prefix "\/a" \(first used at index 2\)/);
  assert.match(body.invalid[6].issues[0], /not a valid JSON Pointer/);
  assert.match(body.invalid[7].issues[0], /not a valid JSON Pointer/);
  assert.match(body.invalid[8].issues[0], /unknown property "note"/);
  assert.equal(body.invalid[9].prefix, null);
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
  // Unknown top-level properties are stripped by the platform-wide ajv
  // config (same as the other endpoints), not rejected.
  const stripped = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/ownership-preview`,
    payload: { rules: [], extra: true },
  });
  assert.equal(stripped.statusCode, 200);
  // A non-array `rules` is coerced to a single-element array (Fastify/ajv
  // array coercion), so its single non-object "rule" is reported as an
  // invalid rule (422), consistent with other rule-level problems.
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
  assert.equal(body.violations.length, 5);
  assert.deepEqual(
    body.violations.map((v) => v.reason),
    [
      'uncovered-path',
      'owned-by-other',
      'owned-by-other',
      'descendant-owned-by-other',
      'owned-by-other',
    ],
  );
});

/* --------------------------------- units --------------------------------- */

test('validateOwnershipRules normalizes valid rules (RFC 6901 escapes, root prefix)', () => {
  const normalized = validateOwnershipRules([
    { prefix: '', owner: 'A' },
    { prefix: '/a~1b/0', owner: 'B' },
  ]);
  assert.deepEqual(normalized[0], { prefix: '', owner: 'A', tokens: [] });
  assert.deepEqual(normalized[1], { prefix: '/a~1b/0', owner: 'B', tokens: ['a/b', '0'] });
});

test('validateOwnershipRules rejects invalid rules with OwnershipError', () => {
  assert.throws(
    () => validateOwnershipRules([{ prefix: '/a', owner: 'both' }]),
    (err) =>
      err instanceof OwnershipError &&
      err.code === OWNERSHIP_CODES.INVALID_RULES &&
      err.details.invalid.length === 1 &&
      /"owner" must be "A" or "B"/.test(err.details.invalid[0].issues[0]),
  );
  assert.throws(
    () => validateOwnershipRules([{ prefix: '/a', owner: 'A' }, { prefix: '/a', owner: 'A' }]),
    (err) => err instanceof OwnershipError && /duplicate rule prefix/.test(err.details.invalid[0].issues[0]),
  );
});

test('previewOwnership is a pure function of the record and rules', () => {
  const record = {
    id: 'x',
    status: 'clean',
    base: { a: 1, list: [1] },
    patchA: [{ op: 'replace', path: '/a', value: 2 }],
    patchB: [{ op: 'add', path: '/list/-', value: 2 }],
    merged: { a: 2, list: [1, 2] },
  };
  const snapshot = structuredClone(record);
  const rules = validateOwnershipRules([
    { prefix: '/a', owner: 'A' },
    { prefix: '/list', owner: 'A' },
  ]);
  const r1 = previewOwnership(record, rules);
  const r2 = previewOwnership(record, rules);
  assert.deepEqual(r1, r2);
  assert.equal(r1.publishable, false);
  assert.deepEqual(r1.violations, [
    { side: 'B', index: 0, op: 'add', path: '/list/1',
      reason: OWNERSHIP_REASONS.OWNED_BY_OTHER, rule: { prefix: '/list', owner: 'A' } },
  ]);
  assert.deepEqual(record, snapshot); // record untouched
});
