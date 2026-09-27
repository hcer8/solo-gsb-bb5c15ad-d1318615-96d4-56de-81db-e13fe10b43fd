import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditOrdering,
  firstDifference,
  AUDIT_VERDICTS,
} from '../src/audit.js';

/* ------------------------------ verdict cases ---------------------------- */

test('disjoint scalar edits are commutative with full step traces', () => {
  const result = auditOrdering({
    base: { a: 1, b: 2 },
    patchA: [{ op: 'replace', path: '/a', value: 10 }],
    patchB: [
      { op: 'replace', path: '/b', value: 20 },
      { op: 'add', path: '/c', value: 30 },
    ],
  });
  assert.equal(result.verdict, AUDIT_VERDICTS.COMMUTATIVE);
  assert.equal(result.firstDifference, null);
  assert.deepEqual(result.orders['A->B'].finalDocument, { a: 10, b: 20, c: 30 });
  assert.deepEqual(result.orders['B->A'].finalDocument, { a: 10, b: 20, c: 30 });
  assert.equal(result.orders['A->B'].status, 'applied');
  assert.equal(result.orders['B->A'].status, 'applied');
  assert.equal(result.orders['A->B'].failure, null);

  // Per-operation paths and post-op values in execution order.
  assert.deepEqual(
    result.orders['A->B'].steps.map((s) => [s.side, s.index, s.path]),
    [
      ['A', 0, '/a'],
      ['B', 0, '/b'],
      ['B', 1, '/c'],
    ],
  );
  assert.deepEqual(
    result.orders['B->A'].steps.map((s) => [s.side, s.index, s.path]),
    [
      ['B', 0, '/b'],
      ['B', 1, '/c'],
      ['A', 0, '/a'],
    ],
  );
  assert.equal(result.orders['A->B'].steps[0].afterValue, 10);
  assert.equal(result.orders['A->B'].steps[2].afterValue, 30);
  assert.equal(result.orders['A->B'].steps[0].afterExists, true);
});

test('same-gap array inserts diverge because RFC replay never remaps indices', () => {
  const result = auditOrdering({
    base: { l: ['x', 'y'] },
    patchA: [{ op: 'add', path: '/l/1', value: 'A' }],
    patchB: [{ op: 'add', path: '/l/1', value: 'B' }],
  });
  assert.equal(result.verdict, AUDIT_VERDICTS.DIVERGENT);
  // A then B: after A inserts at 1, B's "/l/1" still means current index 1,
  // so B lands before A — indices are never remapped to base coordinates.
  assert.deepEqual(result.orders['A->B'].finalDocument.l, ['x', 'B', 'A', 'y']);
  assert.deepEqual(result.orders['B->A'].finalDocument.l, ['x', 'A', 'B', 'y']);
  // Both arrays agree at 0; the first divergence is index 1.
  assert.equal(result.firstDifference.path, '/l/1');
  assert.equal(result.firstDifference.aValue, 'B');
  assert.equal(result.firstDifference.bValue, 'A');
  assert.equal(result.firstDifference.aExists, true);
  assert.equal(result.firstDifference.bExists, true);
});

test('asymmetric failure: removing an element makes the other order OOB', () => {
  const result = auditOrdering({
    base: { l: [{ h: 'a' }, { h: 'b' }] },
    patchA: [{ op: 'remove', path: '/l/0' }],
    patchB: [{ op: 'replace', path: '/l/1/h', value: 'x' }],
  });
  assert.equal(result.verdict, AUDIT_VERDICTS.FAILED);

  const ab = result.orders['A->B'];
  assert.equal(ab.status, 'failed');
  assert.equal(ab.finalDocument, null);
  // A's remove was applied successfully before B failed.
  assert.deepEqual(ab.steps.map((s) => `${s.side}${s.index}`), ['A0']);
  assert.equal(ab.steps[0].afterExists, false);
  assert.deepEqual(ab.steps[0].removedValue, { h: 'a' });
  // Failure side, original operation index and pre-failure document.
  assert.deepEqual(
    {
      order: ab.failure.order,
      side: ab.failure.side,
      index: ab.failure.index,
      code: ab.failure.code,
    },
    { order: 'A->B', side: 'B', index: 0, code: 'OUT_OF_BOUNDS' },
  );
  assert.deepEqual(ab.failure.documentBefore, { l: [{ h: 'b' }] });

  // The reverse order still applies fully and is reported.
  const ba = result.orders['B->A'];
  assert.equal(ba.status, 'applied');
  assert.deepEqual(ba.finalDocument, { l: [{ h: 'x' }] });
  assert.equal(result.firstDifference, null);
});

test('failure on the B-first leg reports the same original index', () => {
  const result = auditOrdering({
    base: { db: { host: 'x' } },
    patchA: [{ op: 'replace', path: '/db/host', value: 'y' }],
    patchB: [{ op: 'remove', path: '/db' }],
  });
  assert.equal(result.verdict, AUDIT_VERDICTS.FAILED);
  assert.equal(result.orders['A->B'].status, 'applied');
  const failure = result.orders['B->A'].failure;
  assert.equal(failure.side, 'A');
  assert.equal(failure.index, 0);
  assert.equal(failure.code, 'PATH_NOT_FOUND');
  assert.deepEqual(failure.documentBefore, {});
});

test('within one patch each op acts on the previous result (insert then deep edit)', () => {
  const result = auditOrdering({
    base: { items: [] },
    patchA: [
      { op: 'add', path: '/items/0', value: { n: 1 } },
      { op: 'replace', path: '/items/0/n', value: 2 },
    ],
    patchB: [],
  });
  assert.equal(result.verdict, AUDIT_VERDICTS.COMMUTATIVE);
  assert.deepEqual(result.orders['A->B'].finalDocument, { items: [{ n: 2 }] });
  assert.equal(result.orders['A->B'].steps[1].afterValue, 2);
});

test('each failure code class: malformed pointer, leading-zero index, missing value', () => {
  const cases = [
    [{ op: 'remove', path: '/a~2b' }, 'INVALID_PATH'],
    [{ op: 'remove', path: '/items/01' }, 'INVALID_INDEX'],
    [{ op: 'replace', path: '/k' }, 'MISSING_VALUE'],
    [{ op: 'frobnicate', path: '/k' }, 'UNSUPPORTED_OP'],
    [{ op: 'remove', path: '/missing' }, 'PATH_NOT_FOUND'],
    [{ op: 'remove', path: '' }, 'ROOT_NOT_REMOVABLE'],
  ];
  for (const [operation, code] of cases) {
    const result = auditOrdering({
      base: { k: 1, items: [1] },
      patchA: [operation],
      patchB: [],
    });
    assert.equal(result.orders['A->B'].failure?.code, code, JSON.stringify(operation));
    assert.equal(result.verdict, AUDIT_VERDICTS.FAILED);
  }
});

test('root add/replace replaces the whole document and can break the other side', () => {
  const result = auditOrdering({
    base: { x: 1 },
    patchA: [{ op: 'replace', path: '', value: { y: 2 } }],
    patchB: [{ op: 'replace', path: '/x', value: 5 }],
  });
  assert.equal(result.verdict, AUDIT_VERDICTS.FAILED);
  assert.equal(result.orders['A->B'].failure.code, 'PATH_NOT_FOUND');
  // B first: /x -> 5, then root replace with {y:2}.
  assert.deepEqual(result.orders['B->A'].finalDocument, { y: 2 });
});

test('remove captures removedValue and afterValue null; add "-" appends in replay', () => {
  const result = auditOrdering({
    base: ['a'],
    patchA: [{ op: 'add', path: '/-', value: 'b' }],
    patchB: [{ op: 'add', path: '/1', value: 'c' }],
  });
  // A then B: A appends at current gap 1 (a,b); B's "/1" inserts before 'b'.
  assert.deepEqual(result.orders['A->B'].finalDocument, ['a', 'c', 'b']);
  // B then A: B inserts at gap 1 (a,c); A's "-" appends after the last.
  assert.deepEqual(result.orders['B->A'].finalDocument, ['a', 'c', 'b']);
  assert.equal(result.verdict, AUDIT_VERDICTS.COMMUTATIVE);

  const removed = auditOrdering({
    base: { k: 1 },
    patchA: [{ op: 'remove', path: '/k' }],
    patchB: [],
  });
  const step = removed.orders['A->B'].steps[0];
  assert.equal(step.afterExists, false);
  assert.equal(step.afterValue, null);
  assert.equal(step.removedValue, 1);
});

/* --------------------------- determinism / purity ------------------------- */

test('audit is a pure deterministic function of the saved inputs', () => {
  const input = {
    base: { l: [1, 2, 3], nested: { keep: { deep: true } } },
    patchA: [
      { op: 'add', path: '/l/1', value: 'A' },
      { op: 'remove', path: '/nested/keep/deep' },
    ],
    patchB: [{ op: 'add', path: '/l/1', value: 'B' }],
  };
  const r1 = auditOrdering(input);
  const r2 = auditOrdering(input);
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));

  // Mutating the caller's inputs after the fact cannot change captured values.
  input.base.l.push(999);
  input.patchA[0].value = 'mutated';
  const r3 = auditOrdering(input);
  assert.notDeepEqual(r1.orders['A->B'].finalDocument, r3.orders['A->B'].finalDocument);
  assert.deepEqual(r1.orders['A->B'].steps[0].afterValue, 'A');
});

/* ---------------------------- firstDifference ----------------------------- */

test('firstDifference returns the lexicographically smallest RFC 6901 path', () => {
  const d = firstDifference(
    { a: { y: 1, z: 2 }, b: 2 },
    { a: { y: 9, z: 8 }, b: 2 },
  );
  assert.equal(d.path, '/a/y');
  assert.equal(d.aValue, 1);
  assert.equal(d.bValue, 9);
});

test('firstDifference compares escaped pointers: "~0" sorts before "~1"', () => {
  const d = firstDifference({ 'a/b': 1, 'a~b': 2 }, { 'a/b': 9, 'a~b': 9 });
  assert.equal(d.path, '/a~0b');
});

test('firstDifference reports presence/absence separately from value null', () => {
  const removed = firstDifference({ a: 1 }, { a: 1, b: 2 });
  assert.deepEqual(
    { path: removed.path, aExists: removed.aExists, bExists: removed.bExists, bValue: removed.bValue },
    { path: '/b', aExists: false, bExists: true, bValue: 2 },
  );
  const actualNull = firstDifference({ a: 0 }, { a: null });
  assert.equal(actualNull.path, '/a');
  assert.equal(actualNull.aExists, true);
  assert.equal(actualNull.bExists, true);
  assert.equal(actualNull.bValue, null);
});

test('firstDifference treats a container/non-container type change as a leaf', () => {
  const d = firstDifference({ x: { k: 1 } }, { x: null });
  assert.equal(d.path, '/x');
  assert.deepEqual(d.aValue, { k: 1 });
  assert.equal(d.bValue, null);
});

test('firstDifference returns null for deeply equal values', () => {
  assert.equal(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), null);
});
