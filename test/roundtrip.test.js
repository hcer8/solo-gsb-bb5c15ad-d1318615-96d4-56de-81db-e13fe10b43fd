import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoundTripPlan,
  diffDocuments,
  applyPatch,
  RoundTripError,
} from '../src/roundtrip.js';

/** Forward must reach target and rollback must restore base, for any input. */
function checkRoundTrip(base, merged) {
  const plan = buildRoundTripPlan(base, merged);
  assert.deepEqual(applyPatch(base, plan.forward), merged);
  assert.deepEqual(applyPatch(merged, plan.rollback), base);
  return plan;
}

test('object members are added, removed, replaced and recursed in key order', () => {
  const base = { a: 1, b: { x: 1, y: 2 }, c: 3, gone: 4 };
  const merged = { a: 1, b: { x: 9, z: 5 }, c: 30, added: [1] };
  const plan = checkRoundTrip(base, merged);

  assert.deepEqual(plan.forward, [
    { op: 'add', path: '/added', value: [1] },
    { op: 'replace', path: '/b/x', value: 9 },
    { op: 'remove', path: '/b/y' },
    { op: 'add', path: '/b/z', value: 5 },
    { op: 'replace', path: '/c', value: 30 },
    { op: 'remove', path: '/gone' },
  ]);
  assert.deepEqual(plan.rollback, [
    { op: 'remove', path: '/added' },
    { op: 'replace', path: '/b/x', value: 1 },
    { op: 'add', path: '/b/y', value: 2 },
    { op: 'remove', path: '/b/z' },
    { op: 'replace', path: '/c', value: 3 },
    { op: 'add', path: '/gone', value: 4 },
  ]);
  assert.deepEqual(plan.operationCount, {
    forward: { add: 2, remove: 2, replace: 2, total: 6 },
    rollback: { add: 2, remove: 2, replace: 2, total: 6 },
  });
});

test('JSON Pointer tokens with ~ and / are escaped (and unescaped by replay)', () => {
  const base = { 'a/b': 1, 'a~b': 2, z: { '/': 3 } };
  const merged = { 'a/b': 9, 'a~b': 2, z: { '~': 4 }, q: [] };
  const plan = checkRoundTrip(base, merged);
  // Keys are visited in raw-key (UTF-16) order: "a/b" < "a~b" < "q" < "z";
  // inside z: "/" (0x2F) < "~" (0x7E). Emission is pre-order, so /q precedes
  // the edits nested under /z.
  const paths = plan.forward.map((o) => o.path);
  assert.deepEqual(paths, ['/a~1b', '/q', '/z/~1', '/z/~0']);
  const deep = checkRoundTrip({ '~': { '/': 1 } }, { '~': { '/': 2 } });
  assert.deepEqual(deep.forward, [{ op: 'replace', path: '/~0/~1', value: 2 }]);
});

test('array LCS keeps equal elements; removes descending, inserts ascending', () => {
  const base = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const merged = [{ id: 0 }, { id: 1 }, { id: 3 }, { id: 4 }];
  const plan = checkRoundTrip(base, merged);
  // Kept (deeply equal): base 0 -> merged 1 (id1), base 2 -> merged 2 (id3).
  // Removed: base 1 (only non-kept base index).
  // Inserted at final indices: merged 0 (id0), merged 3 (id4).
  assert.deepEqual(plan.forward, [
    { op: 'remove', path: '/1' },
    { op: 'add', path: '/0', value: { id: 0 } },
    { op: 'add', path: '/3', value: { id: 4 } },
  ]);
  // Strict in-order replay: [id1,id2,id3] -> [id1,id3] -> [id0,id1,id3]
  // -> [id0,id1,id3,id4]. Every index was valid at execution time.
  assert.deepEqual(applyPatch(base, plan.forward), merged);
});

test('array elements are atomic: differing elements are removed + reinserted wholesale', () => {
  // LCS pairs only deeply equal elements, so an element whose internals change
  // is never partially edited through an array index — it is replaced as a unit.
  const base = [{ n: 1 }, { n: 2, x: 1 }, { n: 3 }];
  const merged = [{ n: 0 }, { n: 2, x: 1 }, { n: 3, y: 2 }];
  const plan = checkRoundTrip(base, merged);
  assert.deepEqual(plan.forward, [
    { op: 'remove', path: '/2' },
    { op: 'remove', path: '/0' },
    { op: 'add', path: '/0', value: { n: 0 } },
    { op: 'add', path: '/2', value: { n: 3, y: 2 } },
  ]);
});

test('duplicate array elements align deterministically (stable LCS tie-break)', () => {
  const base = [1, 1, 1, 2, 1];
  const merged = [1, 2, 1, 1];
  const plan1 = buildRoundTripPlan(base, merged);
  const plan2 = buildRoundTripPlan(base, merged);
  assert.equal(JSON.stringify(plan1.forward), JSON.stringify(plan2.forward));
  // Earliest-match LCS keeps base 0,3,4; removes base 2 then 1 (descending);
  // the extra trailing 1 is inserted at final index 3 (ascending).
  assert.deepEqual(plan1.forward, [
    { op: 'remove', path: '/2' },
    { op: 'remove', path: '/1' },
    { op: 'add', path: '/3', value: 1 },
  ]);
  assert.deepEqual(plan1.rollback, [
    { op: 'remove', path: '/1' },
    { op: 'add', path: '/3', value: 2 },
    { op: 'add', path: '/4', value: 1 },
  ]);
  checkRoundTrip(base, merged);

  checkRoundTrip(['a', 'b', 'c', 'b', 'a'], ['b', 'x', 'b', 'y']);
});

test('nested arrays and interleaved inserts/removes still round-trip', () => {
  const base = { l: [{ n: 1, x: 'a' }, { n: 2 }, { n: 3 }], m: [[1, 2], [3]] };
  const merged = {
    l: [{ n: 0 }, { n: 1, x: 'a' }, { n: 3, tag: true }, { n: 9 }],
    m: [[2, 1], [3], [4]],
  };
  checkRoundTrip(base, merged);
});

test('root scalar replace, container kind swap and null handling', () => {
  let plan = checkRoundTrip(42, { a: 1 });
  assert.deepEqual(plan.forward, [{ op: 'replace', path: '', value: { a: 1 } }]);
  assert.deepEqual(plan.rollback, [{ op: 'replace', path: '', value: 42 }]);

  plan = checkRoundTrip({ x: 1 }, [1, 2]);
  assert.deepEqual(plan.forward, [{ op: 'replace', path: '', value: [1, 2] }]);

  plan = checkRoundTrip(null, [null]);
  assert.deepEqual(plan.forward, [{ op: 'replace', path: '', value: [null] }]);

  plan = checkRoundTrip([null], { k: null });
  assert.deepEqual(plan.forward, [{ op: 'replace', path: '', value: { k: null } }]);
});

test('identical documents yield empty patches', () => {
  const doc = { k: [1, 2, 3], s: 'same' };
  const plan = buildRoundTripPlan(doc, structuredClone(doc));
  assert.deepEqual(plan.forward, []);
  assert.deepEqual(plan.rollback, []);
  assert.deepEqual(plan.operationCount, {
    forward: { add: 0, remove: 0, replace: 0, total: 0 },
    rollback: { add: 0, remove: 0, replace: 0, total: 0 },
  });
});

test('plan is a pure, deterministic function: byte-for-byte repeatable', () => {
  const base = { b: [1, 2, 3], a: { y: 1 } };
  const merged = { a: { y: 2, z: 0 }, b: [3, 2, 1, 0], c: null };
  const p1 = buildRoundTripPlan(base, merged);
  const p2 = buildRoundTripPlan(structuredClone(base), structuredClone(merged));
  assert.equal(JSON.stringify(p1), JSON.stringify(p2));
  // mutating inputs after the fact must not change the snapshot
  base.b.push(999);
  merged.a.y = 'mutated';
  const p3 = buildRoundTripPlan(base, merged);
  assert.notEqual(JSON.stringify(p1), JSON.stringify(p3));
  assert.deepEqual(p1.forward[0], p1.forward[0]); // snapshot values are owned
});

test('unicode keys follow UTF-16 code-unit ordering and round-trip', () => {
  const plan = checkRoundTrip({ 中: 2, é: 1 }, { 中: 3, é: 1 });
  // "中" (U+4E2D) > "é" (U+00E9), so /é is visited... only /中 differs.
  assert.deepEqual(plan.forward, [{ op: 'replace', path: '/中', value: 3 }]);
});

test('only add/remove/replace are ever emitted', () => {
  const plan = buildRoundTripPlan({ a: [1, 2] }, { a: [2, 3, 4], b: { deep: { x: 1 } } });
  for (const op of [...plan.forward, ...plan.rollback]) {
    assert.ok(['add', 'remove', 'replace'].includes(op.op));
    for (const key of Object.keys(op)) assert.ok(['op', 'path', 'value'].includes(key));
  }
});

/* ------------------------------ strict replay ------------------------------ */

test('applyPatch enforces RFC 6902: out-of-bounds, missing targets, leading zeros', () => {
  assert.throws(() => applyPatch([1], [{ op: 'remove', path: '/1' }]), RoundTripError);
  assert.throws(() => applyPatch([1], [{ op: 'remove', path: '/01' }]), RoundTripError);
  assert.throws(() => applyPatch({ a: 1 }, [{ op: 'remove', path: '/b' }]), RoundTripError);
  assert.throws(() => applyPatch({ a: 1 }, [{ op: 'replace', path: '/b', value: 1 }]), RoundTripError);
  assert.throws(() => applyPatch({}, [{ op: 'replace', path: '' }]), RoundTripError);
  assert.throws(() => applyPatch([1], [{ op: 'frob', path: '/0' }]), RoundTripError);
  assert.throws(() => applyPatch(1, [{ op: 'remove', path: '/a' }]), RoundTripError);
});

test('buildRoundTripPlan is exportable as a raw diff and matches verified plan', () => {
  const base = { k: [1, 2] };
  const merged = { k: [2, 3], j: 1 };
  const raw = diffDocuments(base, merged);
  const plan = buildRoundTripPlan(base, merged);
  assert.deepEqual(raw, plan.forward);
});
