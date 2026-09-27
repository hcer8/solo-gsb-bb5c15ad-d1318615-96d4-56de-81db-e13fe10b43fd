import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import {
  previewConstraints,
  validateRules,
  ConstraintError,
  CONSTRAINT_CODES,
  parseRulePointer,
} from '../src/constraint.js';
import {
  EXAMPLE_REQUEST,
  EXAMPLE_CONFLICT_REQUEST,
  EXAMPLE_CONSTRAINT_PREVIEW_REQUEST,
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
    url: `/api/v1/merges/${id}/constraint-preview`,
    payload: { rules },
  });
}

/* ------------------------------- happy path ------------------------------ */

test('constraint preview evaluates every rule on base / A / B / merged and classifies violations', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  assert.equal(record.status, 'clean');
  const res = await preview(record.id, EXAMPLE_CONSTRAINT_PREVIEW_REQUEST.rules);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, record.id);
  assert.equal(body.status, 'clean');
  assert.ok(body.createdAt);

  const byId = Object.fromEntries(body.results.map((r) => [r.id, r]));
  for (const id of EXAMPLE_CONSTRAINT_PREVIEW_REQUEST.rules.map((r) => r.id)) {
    assert.ok(byId[id], `result for ${id}`);
  }
  // results keep the request order
  assert.deepEqual(
    body.results.map((r) => r.id),
    EXAMPLE_CONSTRAINT_PREVIEW_REQUEST.rules.map((r) => r.id),
  );

  // cache=true already in base, /features/cache-review never present
  const cache = byId['cache-needs-review'];
  assert.equal(cache.states.base.pass, false);
  assert.equal(cache.states.A.pass, false);
  assert.equal(cache.states.B.pass, false);
  assert.equal(cache.states.merged.pass, false);
  assert.deepEqual(cache.violation.labels, ['preexisting']);

  // A raises replicas to 3; B leaves it at 2; merged is 3
  const replicas = byId['replicas-need-capacity-review'];
  assert.equal(replicas.states.base.pass, true);
  assert.equal(replicas.states.A.pass, false);
  assert.equal(replicas.states.B.pass, true);
  assert.equal(replicas.states.merged.pass, false);
  assert.deepEqual(replicas.violation.labels, ['introduced-by-A']);

  // only B adds features.retries; merged keeps it
  const retries = byId['retries-need-budget'];
  assert.equal(retries.states.base.pass, true);
  assert.equal(retries.states.A.pass, true);
  assert.equal(retries.states.B.pass, false);
  assert.equal(retries.states.merged.pass, false);
  assert.deepEqual(retries.violation.labels, ['introduced-by-B']);

  // both sides flip tracing independently
  const tracing = byId['tracing-needs-audit'];
  assert.equal(tracing.states.base.pass, true);
  assert.equal(tracing.states.A.pass, false);
  assert.equal(tracing.states.B.pass, false);
  assert.equal(tracing.states.merged.pass, false);
  assert.deepEqual(tracing.violation.labels, ['introduced-by-A', 'introduced-by-B']);

  // merged /servers/0 is a2.internal only after A's same-gap insert + B's
  // delete of base servers[0] combine — neither side reaches that host alone
  const first = byId['first-server-needs-verification'];
  assert.equal(first.states.base.pass, true);
  assert.equal(first.states.A.pass, true);
  assert.equal(first.states.B.pass, true);
  assert.equal(first.states.merged.pass, false);
  assert.deepEqual(first.violation.labels, ['combination-only']);

  // satisfied rule in every state -> no violation
  const appRule = byId['app-implies-replicas'];
  assert.equal(appRule.states.base.pass, true);
  assert.equal(appRule.states.A.pass, true);
  assert.equal(appRule.states.B.pass, true);
  assert.equal(appRule.states.merged.pass, true);
  assert.equal(appRule.violation, null);

  assert.deepEqual(body.summary, {
    total: 6,
    violations: { base: 1, A: 3, B: 3, merged: 5 },
    mergedViolations: {
      preexisting: 1,
      introducedByA: 1,
      introducedByB: 1,
      introducedByBoth: 1,
      combinationOnly: 1,
    },
  });
});

test('constraint preview single-side states follow base-coordinate relocation', async () => {
  // A deep-edits base servers[1]; B removes base servers[0]. Base
  // coordinates: A's edit follows the surviving element to merged index 0.
  const record = await createRecord({
    base: { servers: [{ host: 'a' }, { host: 'b' }] },
    patchA: [{ op: 'replace', path: '/servers/1/host', value: 'x' }],
    patchB: [{ op: 'remove', path: '/servers/0' }],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged.servers, [{ host: 'x' }]);

  const rules = [
    { id: 'first-host-x', when: '/servers/0/host', equals: 'x', require: '/servers/0/verified' },
  ];
  const res = await preview(record.id, rules);
  assert.equal(res.statusCode, 200);
  const [r] = res.json().results;
  // base servers[0].host = a: not triggered
  assert.equal(r.states.base.triggered, false);
  assert.equal(r.states.base.pass, true);
  // A alone: the edit is on base index 1, so current index 0 still hosts a
  assert.equal(r.states.A.triggered, false);
  assert.equal(r.states.A.whenValue, 'a');
  assert.equal(r.states.A.pass, true);
  // B alone: b relocates to index 0
  assert.equal(r.states.B.whenValue, 'b');
  assert.equal(r.states.B.pass, true);
  // merged: b (with A's deep edit x) relocates to index 0 -> violation
  assert.equal(r.states.merged.triggered, true);
  assert.equal(r.states.merged.whenValue, 'x');
  assert.equal(r.states.merged.requireExists, false);
  assert.equal(r.states.merged.pass, false);
  assert.deepEqual(r.violation.labels, ['combination-only']);
});

test('per-state diagnostics distinguish a missing pointer from an explicit null', async () => {
  const record = await createRecord({
    base: { a: null, b: 1 },
    patchA: [{ op: 'add', path: '/c', value: { x: 1, y: 2 } }],
    patchB: [],
  });
  const res = await preview(record.id, [
    { id: 'null-trigger-met', when: '/a', equals: null, require: '/b' },
    { id: 'null-trigger-unmet', when: '/a', equals: null, require: '/missing' },
    { id: 'when-missing', when: '/missing', equals: 1, require: '/nope' },
    { id: 'deep-equal-order', when: '/c', equals: { y: 2, x: 1 }, require: '/a' },
    { id: 'array-dash', when: '/arr/-', equals: 1, require: '/nope' },
    { id: 'leading-zero', when: '/arr/01', equals: 1, require: '/nope' },
  ]);
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.json().results.map((r) => [r.id, r]));
  const met = byId['null-trigger-met'].states.merged;
  assert.equal(met.whenExists, true);
  assert.equal(met.whenValue, null);
  assert.equal(met.triggered, true);
  assert.equal(met.requireExists, true);
  assert.equal(met.pass, true);
  const unmet = byId['null-trigger-unmet'].states.merged;
  assert.equal(unmet.whenExists, true);
  assert.equal(unmet.whenValue, null);
  assert.equal(unmet.requireExists, false);
  assert.equal(unmet.pass, false);
  // when pointer missing -> rule passes regardless of require
  const missingWhen = byId['when-missing'].states.merged;
  assert.equal(missingWhen.whenExists, false);
  assert.equal(missingWhen.whenValue, null);
  assert.equal(missingWhen.triggered, false);
  assert.equal(missingWhen.pass, true);
  // deep equality is key-order insensitive
  assert.equal(byId['deep-equal-order'].states.merged.triggered, true);
  assert.equal(byId['deep-equal-order'].states.merged.pass, true);
  // "-" and leading-zero array tokens never resolve -> not triggered
  assert.equal(byId['array-dash'].states.merged.whenExists, false);
  assert.equal(byId['leading-zero'].states.merged.whenExists, false);
});

test('root pointers are accepted', async () => {
  const record = await createRecord({
    base: { a: 1 },
    patchA: [{ op: 'replace', path: '', value: { a: 2 } }],
    patchB: [],
  });
  const res = await preview(record.id, [
    { id: 'root-when', when: '', equals: { a: 2 }, require: '/a' },
  ]);
  assert.equal(res.statusCode, 200);
  const [r] = res.json().results;
  assert.equal(r.states.base.triggered, false);
  assert.deepEqual(r.states.merged.whenValue, { a: 2 });
  assert.equal(r.states.merged.pass, true); // require "" always exists
});

test('an empty rules list is valid', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const res = await preview(record.id, []);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().results, []);
  assert.deepEqual(res.json().summary, {
    total: 0,
    violations: { base: 0, A: 0, B: 0, merged: 0 },
    mergedViolations: {
      preexisting: 0,
      introducedByA: 0,
      introducedByB: 0,
      introducedByBoth: 0,
      combinationOnly: 0,
    },
  });
});

/* -------------------------- determinism / no mutation --------------------- */

test('constraint preview does not modify the stored record and is byte-for-byte deterministic', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const rules = EXAMPLE_CONSTRAINT_PREVIEW_REQUEST.rules;
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

/* ------------------------------ 422 / 400 / 404 / 409 --------------------- */

test('invalid rules return 422 INVALID_RULES with every problem collected', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const res = await preview(record.id, [
    5,
    { id: '', when: '/a', equals: 1, require: '/b' },
    { id: 'dup', when: '/a', equals: 1, require: '/b' },
    { id: 'dup', when: '/a', equals: 1, require: '/b' },
    { id: 'bad-when', when: 'a', equals: 1, require: '/b' },
    { id: 'bad-require', when: '/a', equals: 1, require: 'a' },
    { id: 'bad-escape', when: '/a~2b', equals: 1, require: '/b' },
    { id: 'missing-equals', when: '/a', require: '/b' },
    { id: 'extra', when: '/a', equals: 1, require: '/b', note: 'x' },
    { id: 123, when: '/a', equals: 1, require: '/b' },
  ]);
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error, 'Unprocessable Entity');
  assert.equal(body.code, 'INVALID_RULES');
  assert.equal(body.invalid.length, 9);
  assert.deepEqual(
    body.invalid.map((e) => e.index),
    [0, 1, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(body.invalid[0].id, null);
  assert.match(body.invalid[0].issues[0], /must be an object/);
  assert.match(body.invalid[2].issues[0], /duplicate rule id "dup"/);
  assert.match(body.invalid[3].issues[0], /not a valid JSON Pointer/);
  assert.match(body.invalid[6].issues[0], /"equals" is required/);
  assert.match(body.invalid[7].issues[0], /unknown property "note"/);
  assert.equal(body.invalid[8].id, null);
});

test('malformed top-level bodies return 400, not 422', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  // missing required "rules"
  const missing = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/constraint-preview`,
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
  // Unknown top-level properties are stripped by the platform-wide ajv
  // config (same as POST /api/v1/merges), not rejected.
  const stripped = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/constraint-preview`,
    payload: { rules: [], extra: true },
  });
  assert.equal(stripped.statusCode, 200);
  // A non-array `rules` is coerced to a single-element array (Fastify/ajv
  // array coercion), so its single non-object "rule" is reported as an
  // invalid rule (422), consistent with other rule-level problems.
  const coerced = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/constraint-preview`,
    payload: { rules: 'nope' },
  });
  assert.equal(coerced.statusCode, 422);
  assert.equal(coerced.json().code, 'INVALID_RULES');
  assert.match(coerced.json().invalid[0].issues[0], /must be an object/);
});

test('constraint preview for an unknown id returns 404', async () => {
  const res = await preview('does-not-exist', []);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

test('constraint preview on a conflict record returns 409 and does not modify it', async () => {
  const record = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  assert.equal(record.status, 'conflict');
  // 409 takes precedence over 422 rule validation
  const res = await preview(record.id, [{ id: 'bad', when: 'x', require: 'y' }]);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'Conflict');
  assert.match(res.json().message, /status "conflict"/);
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` });
  assert.equal(fetched.json().status, 'conflict');
  assert.equal(fetched.json().merged, null);
});

/* ------------------------------ example file ----------------------------- */

test('examples/constraint-preview-request.json mirrors the canned example and works end-to-end', async () => {
  const fromDisk = JSON.parse(
    readFileSync(new URL('../examples/constraint-preview-request.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(fromDisk, EXAMPLE_CONSTRAINT_PREVIEW_REQUEST);
  const record = await createRecord(EXAMPLE_REQUEST);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/constraint-preview`,
    payload: fromDisk,
  });
  assert.equal(res.statusCode, 200);
  const labels = Object.fromEntries(
    res.json().results.map((r) => [r.id, r.violation && r.violation.labels]),
  );
  assert.deepEqual(labels['cache-needs-review'], ['preexisting']);
  assert.deepEqual(labels['replicas-need-capacity-review'], ['introduced-by-A']);
  assert.deepEqual(labels['retries-need-budget'], ['introduced-by-B']);
  assert.deepEqual(labels['tracing-needs-audit'], ['introduced-by-A', 'introduced-by-B']);
  assert.deepEqual(labels['first-server-needs-verification'], ['combination-only']);
  assert.equal(labels['app-implies-replicas'], null);
});

/* --------------------------------- units --------------------------------- */

test('validateRules normalizes valid rules (RFC 6901 escapes, null equals)', () => {
  const normalized = validateRules([
    { id: 'r1', when: '/a~1b/0', equals: null, require: '' },
    { id: 'r2', when: '', equals: { x: [1, 2] }, require: '/a~0b' },
  ]);
  assert.deepEqual(normalized[0].whenTokens, ['a/b', '0']);
  assert.deepEqual(normalized[0].requireTokens, []);
  assert.deepEqual(normalized[1].whenTokens, []);
  assert.deepEqual(normalized[1].requireTokens, ['a~b']);
});

test('validateRules rejects a pointer whose type is not a string', () => {
  assert.throws(
    () => validateRules([{ id: 'r', when: 42, equals: 1, require: '/b' }]),
    (err) =>
      err instanceof ConstraintError &&
      err.code === CONSTRAINT_CODES.INVALID_RULES &&
      err.details.invalid.length === 1 &&
      /"when" must be a JSON Pointer string/.test(err.details.invalid[0].issues[0]),
  );
});

test('parseRulePointer implements strict RFC 6901 syntax', () => {
  assert.deepEqual(parseRulePointer(''), []);
  assert.deepEqual(parseRulePointer('/a/0'), ['a', '0']);
  assert.deepEqual(parseRulePointer('/~0/~1'), ['~', '/']);
  assert.equal(parseRulePointer('no-leading-slash'), null);
  assert.equal(parseRulePointer('/a~2b'), null);
  assert.equal(parseRulePointer('/a~'), null);
  assert.equal(parseRulePointer(null), null);
  assert.equal(parseRulePointer(undefined), null);
});

test('previewConstraints is a pure function of the record and rules', () => {
  const record = {
    id: 'x',
    status: 'clean',
    base: { a: 1 },
    patchA: [{ op: 'replace', path: '/a', value: 2 }],
    patchB: [{ op: 'add', path: '/b', value: 3 }],
    merged: { a: 2, b: 3 },
  };
  const snapshot = structuredClone(record);
  const rules = validateRules([{ id: 'r', when: '/a', equals: 2, require: '/b' }]);
  const r1 = previewConstraints(record, rules);
  const r2 = previewConstraints(record, rules);
  assert.deepEqual(r1, r2);
  const [result] = r1.results;
  assert.equal(result.states.base.pass, true); // a is 1 in base: not triggered
  assert.equal(result.states.A.pass, false); // a becomes 2, /b still missing
  assert.equal(result.states.B.pass, true);
  assert.equal(result.states.merged.pass, true); // /b exists in merged
  assert.equal(result.violation, null);
  assert.deepEqual(record, snapshot); // record untouched
});
