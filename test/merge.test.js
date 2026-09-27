import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePatches,
  parsePointer,
  formatPointer,
  PatchError,
} from '../src/merge.js';

test('JSON Pointer parse/format round-trip with escaping', () => {
  assert.deepEqual(parsePointer(''), []);
  assert.deepEqual(parsePointer('/a/b'), ['a', 'b']);
  assert.deepEqual(parsePointer('/a~0b/c~1d'), ['a~b', 'c/d']);
  assert.equal(formatPointer(['a~b', 'c/d']), '/a~0b/c~1d');
  assert.equal(formatPointer([]), '');
  assert.throws(() => parsePointer('no-slash'), PatchError);
});

test('clean object merge: disjoint ops from both patches apply', () => {
  const { status, merged, stats } = mergePatches(
    { a: 1, b: 2, c: 3 },
    [{ op: 'replace', path: '/a', value: 10 }],
    [
      { op: 'replace', path: '/b', value: 20 },
      { op: 'add', path: '/d', value: 4 },
    ],
  );
  assert.equal(status, 'clean');
  assert.deepEqual(merged, { a: 10, b: 20, c: 3, d: 4 });
  assert.equal(stats.applied, 3);
});

test('array index drift: insert + remove + nested edit are relocated by base identity', () => {
  const base = {
    servers: [
      { host: 'a', weight: 1 },
      { host: 'b', weight: 2 },
      { host: 'c', weight: 3 },
    ],
  };
  const patchA = [
    { op: 'add', path: '/servers/0', value: { host: 'new', weight: 9 } },
    { op: 'replace', path: '/servers/2/weight', value: 33 },
  ];
  const patchB = [{ op: 'remove', path: '/servers/0' }];
  const { status, merged } = mergePatches(base, patchA, patchB);
  assert.equal(status, 'clean');
  // insert at gap 0, base[0] removed, base[1] untouched, base[2] edited in place
  assert.deepEqual(merged.servers, [
    { host: 'new', weight: 9 },
    { host: 'b', weight: 2 },
    { host: 'c', weight: 33 },
  ]);
});

test('same insertion gap is ordered A before B', () => {
  const { merged } = mergePatches(
    { list: ['x', 'y'] },
    [{ op: 'add', path: '/list/1', value: 'from-A' }],
    [{ op: 'add', path: '/list/1', value: 'from-B' }],
  );
  assert.deepEqual(merged.list, ['x', 'from-A', 'from-B', 'y']);
});

test('"-" appends after the last element and shares the append gap (A before B)', () => {
  const { merged } = mergePatches(
    ['a'],
    [{ op: 'add', path: '/-', value: 'A' }],
    [{ op: 'add', path: '/1', value: 'B' }],
  );
  assert.deepEqual(merged, ['a', 'A', 'B']);
});

test('identical replace and identical remove are deduplicated, not conflicts', () => {
  const { status, merged, stats } = mergePatches(
    { x: 1, y: 2 },
    [
      { op: 'replace', path: '/x', value: 5 },
      { op: 'remove', path: '/y' },
    ],
    [
      { op: 'replace', path: '/x', value: 5 },
      { op: 'remove', path: '/y' },
    ],
  );
  assert.equal(status, 'clean');
  assert.deepEqual(merged, { x: 5 });
  assert.equal(stats.deduplicated, 2);
  assert.equal(stats.applied, 2);
});

test('add on an existing object member is treated as replace (RFC 6902)', () => {
  const { merged } = mergePatches(
    { k: 'old' },
    [{ op: 'add', path: '/k', value: 'new' }],
    [],
  );
  assert.deepEqual(merged, { k: 'new' });
});

test('replace with different values conflicts with both operation indices', () => {
  const { status, merged, conflicts } = mergePatches(
    { replicas: 2 },
    [{ op: 'replace', path: '/replicas', value: 3 }],
    [{ op: 'replace', path: '/replicas', value: 5 }],
  );
  assert.equal(status, 'conflict');
  assert.equal(merged, null);
  assert.equal(conflicts.length, 1);
  const [c] = conflicts;
  assert.equal(c.reason, 'replace-mismatch');
  assert.equal(c.path, '/replicas');
  assert.deepEqual(
    c.operations.map((o) => [o.side, o.index]),
    [
      ['A', 0],
      ['B', 0],
    ],
  );
  assert.equal(c.operations[0].value, 3);
  assert.equal(c.operations[1].value, 5);
});

test('delete vs modify on the same element conflicts', () => {
  const { conflicts } = mergePatches(
    { db: { host: 'x' } },
    [{ op: 'remove', path: '/db' }],
    [{ op: 'replace', path: '/db', value: { host: 'y' } }],
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'delete-vs-modify');
  assert.equal(conflicts[0].path, '/db');
});

test('delete of an ancestor vs modify inside it conflicts (normalized paths reported)', () => {
  const { conflicts } = mergePatches(
    { db: { host: 'x', port: 1 } },
    [{ op: 'remove', path: '/db' }],
    [{ op: 'replace', path: '/db/host', value: 'y' }],
  );
  assert.equal(conflicts.length, 1);
  const [c] = conflicts;
  assert.equal(c.reason, 'delete-vs-modify');
  assert.equal(c.path, '/db');
  assert.equal(c.operations[0].path, '/db');
  assert.equal(c.operations[1].path, '/db/host');
});

test('delete vs modify on an array element (delete beats nested edit)', () => {
  const { conflicts } = mergePatches(
    { s: [{ h: 'a' }, { h: 'b' }] },
    [{ op: 'remove', path: '/s/1' }],
    [{ op: 'replace', path: '/s/1/h', value: 'c' }],
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'delete-vs-modify');
  assert.equal(conflicts[0].path, '/s/1');
});

test('both patches adding the same new member with different values conflicts', () => {
  const { conflicts } = mergePatches(
    {},
    [{ op: 'add', path: '/region', value: 'eu' }],
    [{ op: 'add', path: '/region', value: 'us' }],
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'add-mismatch');
  assert.equal(conflicts[0].path, '/region');
});

test('both patches adding the same new member with equal values deduplicate', () => {
  const { status, merged } = mergePatches(
    {},
    [{ op: 'add', path: '/region', value: 'eu' }],
    [{ op: 'add', path: '/region', value: 'eu' }],
  );
  assert.equal(status, 'clean');
  assert.deepEqual(merged, { region: 'eu' });
});

test('replace of a subtree vs modification inside it conflicts (replace-overlap)', () => {
  const { conflicts } = mergePatches(
    { svc: { image: 'v1', port: 80 } },
    [{ op: 'replace', path: '/svc', value: { image: 'v2' } }],
    [{ op: 'replace', path: '/svc/port', value: 8080 }],
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'replace-overlap');
  assert.equal(conflicts[0].path, '/svc');
});

test('descendant remove under the other side\'s ancestor remove is dropped silently', () => {
  const { status, merged } = mergePatches(
    { a: { b: 1, c: 2 }, keep: true },
    [{ op: 'remove', path: '/a' }],
    [{ op: 'remove', path: '/a/b' }],
  );
  assert.equal(status, 'clean');
  assert.deepEqual(merged, { keep: true });
});

test('insertion before an element does not conflict with edits inside that element', () => {
  const { status, merged } = mergePatches(
    { s: [{ h: 'a' }, { h: 'b' }] },
    [{ op: 'add', path: '/s/0', value: { h: 'z' } }],
    [{ op: 'replace', path: '/s/1/h', value: 'B' }],
  );
  assert.equal(status, 'clean');
  assert.deepEqual(merged.s, [{ h: 'z' }, { h: 'a' }, { h: 'B' }]);
});

test('root replace by both sides with different values conflicts', () => {
  const { conflicts } = mergePatches(
    { v: 1 },
    [{ op: 'replace', path: '', value: { v: 2 } }],
    [{ op: 'replace', path: '', value: { v: 3 } }],
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'replace-mismatch');
  assert.equal(conflicts[0].path, '');
});

test('single root replace applies cleanly', () => {
  const { status, merged } = mergePatches(
    { v: 1 },
    [{ op: 'replace', path: '', value: [1, 2] }],
    [],
  );
  assert.equal(status, 'clean');
  assert.deepEqual(merged, [1, 2]);
});

test('invalid patches raise PatchError with side and index details', () => {
  assert.throws(
    () => mergePatches({ a: 1 }, [{ op: 'remove', path: '/missing' }], []),
    (err) => {
      assert.ok(err instanceof PatchError);
      assert.equal(err.details.side, 'A');
      assert.equal(err.details.index, 0);
      return true;
    },
  );
  assert.throws(
    () => mergePatches({ a: [1] }, [], [{ op: 'replace', path: '/a/5', value: 0 }]),
    (err) => {
      assert.equal(err.details.side, 'B');
      return true;
    },
  );
  assert.throws(
    () => mergePatches({ a: 1 }, [{ op: 'replace', path: '/a/b', value: 1 }], []),
    PatchError,
  );
  assert.throws(
    () => mergePatches({ a: 1 }, [{ op: 'replace', path: '/a' }], []),
    PatchError, // replace without value
  );
  assert.throws(
    () => mergePatches({ a: 1 }, [{ op: 'remove', path: '' }], []),
    PatchError, // root removal unsupported
  );
});

test('nested op under an ancestor op within one patch is rejected', () => {
  assert.throws(
    () =>
      mergePatches(
        { a: { b: 1 } },
        [
          { op: 'remove', path: '/a' },
          { op: 'replace', path: '/a/b', value: 2 },
        ],
        [],
      ),
    PatchError,
  );
});

test('duplicate targets within one patch: last write wins', () => {
  const { merged } = mergePatches(
    { k: 1 },
    [
      { op: 'replace', path: '/k', value: 2 },
      { op: 'replace', path: '/k', value: 3 },
    ],
    [],
  );
  assert.deepEqual(merged, { k: 3 });
});

test('merge is deterministic regardless of patch order in the request', () => {
  const base = { l: [1, 2], m: 0 };
  const patchA = [
    { op: 'add', path: '/l/1', value: 'A' },
    { op: 'replace', path: '/m', value: 1 },
  ];
  const patchB = [{ op: 'add', path: '/l/1', value: 'B' }];
  const r1 = mergePatches(base, patchA, patchB);
  const r2 = mergePatches(base, patchA, patchB);
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1.merged.l, [1, 'A', 'B', 2]);
});
