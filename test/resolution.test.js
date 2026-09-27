import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { previewResolution } from '../src/resolution.js';
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
  return res.json().id;
}

function preview(id, decisions) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/merges/${id}/resolution-preview`,
    payload: { decisions },
  });
}

/* ------------------------------ happy path ------------------------------- */

test('resolution preview: winners are retained, losers dropped, merge re-run (200)', async () => {
  const id = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  const res = await preview(id, [
    { conflict: 0, winner: 'A' }, // keep A's remove /database
    { conflict: 1, winner: 'B' }, // keep B's mode = readonly
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, id);
  assert.equal(body.status, 'clean');
  assert.deepEqual(body.merged, { mode: 'readonly' });
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.retained, [
    { side: 'A', index: 0, op: 'remove', path: '/database', conflicts: [0] },
    { side: 'B', index: 1, op: 'replace', path: '/mode', value: 'readonly', conflicts: [1] },
  ]);
  assert.deepEqual(body.dropped, [
    { side: 'A', index: 1, op: 'replace', path: '/mode', value: 'single', conflicts: [1] },
    {
      side: 'B',
      index: 0,
      op: 'replace',
      path: '/database/host',
      value: 'db2.internal',
      conflicts: [0],
    },
  ]);
  assert.deepEqual(body.stats, {
    received: { A: 1, B: 1 },
    normalized: { A: 1, B: 1 },
    deduplicated: 0,
    conflicts: 0,
    applied: 2,
  });
});

test('resolution preview does not modify the stored record and is deterministic', async () => {
  const id = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  const decisions = [
    { conflict: 0, winner: 'A' },
    { conflict: 1, winner: 'B' },
  ];
  const first = await preview(id, decisions);
  const second = await preview(id, decisions);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, second.body); // byte-for-byte identical

  const record = (await app.inject({ method: 'GET', url: `/api/v1/merges/${id}` })).json();
  assert.equal(record.status, 'conflict'); // still unresolved
  assert.equal(record.conflicts.length, 2);
  assert.deepEqual(record.patchA, EXAMPLE_CONFLICT_REQUEST.patchA);
  assert.deepEqual(record.patchB, EXAMPLE_CONFLICT_REQUEST.patchB);
});

test('one operation may be retained across several conflicts', async () => {
  const id = await createRecord({
    base: { db: { h: 'x', p: 1 } },
    patchA: [{ op: 'remove', path: '/db' }],
    patchB: [
      { op: 'replace', path: '/db/h', value: 'y' },
      { op: 'replace', path: '/db/p', value: 2 },
    ],
  });
  const res = await preview(id, [
    { conflict: 0, winner: 'A' },
    { conflict: 1, winner: 'A' },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.merged, {});
  assert.deepEqual(body.retained, [
    { side: 'A', index: 0, op: 'remove', path: '/db', conflicts: [0, 1] },
  ]);
  assert.deepEqual(
    body.dropped.map((o) => [o.side, o.index, o.conflicts]),
    [
      ['B', 0, [0]],
      ['B', 1, [1]],
    ],
  );
});

/* ---------------------------- residual conflicts -------------------------- */

test('resolution preview returns 409 with the remaining conflicts', async () => {
  // A#1 shadows A#0 (last-wins); dropping A#1 lets A#0 resurface and conflict.
  const id = await createRecord({
    base: { k: 0 },
    patchA: [
      { op: 'replace', path: '/k', value: 1 },
      { op: 'replace', path: '/k', value: 2 },
    ],
    patchB: [{ op: 'replace', path: '/k', value: 3 }],
  });
  const res = await preview(id, [{ conflict: 0, winner: 'B' }]);
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.status, 'conflict');
  assert.equal(body.merged, null);
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].reason, 'replace-mismatch');
  assert.equal(body.conflicts[0].path, '/k');
  assert.deepEqual(
    body.conflicts[0].operations.map((o) => [o.side, o.index, o.value]),
    [
      ['A', 0, 1],
      ['B', 0, 3],
    ],
  );
  assert.deepEqual(body.retained, [
    { side: 'B', index: 0, op: 'replace', path: '/k', value: 3, conflicts: [0] },
  ]);
  assert.deepEqual(body.dropped, [
    { side: 'A', index: 1, op: 'replace', path: '/k', value: 2, conflicts: [0] },
  ]);
  assert.equal(body.stats.conflicts, 1);
});

/* ------------------------------ contradictions ---------------------------- */

test('retaining and dropping the same operation across conflicts returns 422', async () => {
  const id = await createRecord({
    base: { db: { h: 'x', p: 1 } },
    patchA: [{ op: 'remove', path: '/db' }],
    patchB: [
      { op: 'replace', path: '/db/h', value: 'y' },
      { op: 'replace', path: '/db/p', value: 2 },
    ],
  });
  const res = await preview(id, [
    { conflict: 0, winner: 'A' }, // retains A#0
    { conflict: 1, winner: 'B' }, // drops A#0
  ]);
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error, 'Unprocessable Entity');
  assert.equal(body.code, 'CONTRADICTORY_DECISIONS');
  assert.deepEqual(body.contradictions, [
    {
      side: 'A',
      index: 0,
      op: 'remove',
      path: '/db',
      retainedIn: [0],
      droppedIn: [1],
    },
  ]);
});

/* ------------------------------- coverage -------------------------------- */

test('decisions must cover every conflict exactly once (400 otherwise)', async () => {
  const id = await createRecord(EXAMPLE_CONFLICT_REQUEST); // 2 conflicts

  const missing = await preview(id, [{ conflict: 0, winner: 'A' }]);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, 'INVALID_DECISIONS');
  assert.deepEqual(missing.json().missing, [1]);

  const duplicate = await preview(id, [
    { conflict: 0, winner: 'A' },
    { conflict: 0, winner: 'B' },
    { conflict: 1, winner: 'A' },
  ]);
  assert.equal(duplicate.statusCode, 400);
  assert.deepEqual(duplicate.json().duplicate, [0]);

  const unexpected = await preview(id, [
    { conflict: 0, winner: 'A' },
    { conflict: 1, winner: 'A' },
    { conflict: 2, winner: 'A' },
  ]);
  assert.equal(unexpected.statusCode, 400);
  assert.deepEqual(unexpected.json().unexpected, [2]);
});

/* --------------------------- record preconditions ------------------------- */

test('resolution preview on a clean record returns 409', async () => {
  const id = await createRecord(EXAMPLE_REQUEST); // merges cleanly
  const res = await preview(id, []);
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error, 'Conflict');
  assert.match(body.message, /status "clean"/);
});

test('resolution preview for an unknown id returns 404', async () => {
  const res = await preview('does-not-exist', []);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

test('malformed decision bodies are rejected (400)', async () => {
  const id = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  for (const payload of [
    {}, // missing decisions
    { decisions: [{ conflict: 0 }] }, // missing winner
    { decisions: [{ conflict: 0, winner: 'C' }] }, // winner must be A/B
    { decisions: [{ conflict: -1, winner: 'A' }] }, // negative index
    { decisions: [{ conflict: 0.5, winner: 'A' }] }, // non-integer index
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/merges/${id}/resolution-preview`,
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

/* --------------------------------- units --------------------------------- */

test('previewResolution is a pure function of the record and decisions', () => {
  const record = {
    id: 'x',
    status: 'conflict',
    ...structuredClone({
      base: EXAMPLE_CONFLICT_REQUEST.base,
      patchA: EXAMPLE_CONFLICT_REQUEST.patchA,
      patchB: EXAMPLE_CONFLICT_REQUEST.patchB,
      conflicts: [
        {
          reason: 'delete-vs-modify',
          path: '/database',
          operations: [
            { side: 'A', index: 0, op: 'remove', path: '/database' },
            { side: 'B', index: 0, op: 'replace', path: '/database/host', value: 'db2.internal' },
          ],
          message: 'm0',
        },
        {
          reason: 'replace-mismatch',
          path: '/mode',
          operations: [
            { side: 'A', index: 1, op: 'replace', path: '/mode', value: 'single' },
            { side: 'B', index: 1, op: 'replace', path: '/mode', value: 'readonly' },
          ],
          message: 'm1',
        },
      ],
    }),
  };
  const snapshot = structuredClone(record);
  const decisions = [
    { conflict: 0, winner: 'A' },
    { conflict: 1, winner: 'B' },
  ];
  const r1 = previewResolution(record, decisions);
  const r2 = previewResolution(record, decisions);
  assert.deepEqual(r1, r2);
  assert.equal(r1.status, 'clean');
  assert.deepEqual(record, snapshot); // record untouched
});
