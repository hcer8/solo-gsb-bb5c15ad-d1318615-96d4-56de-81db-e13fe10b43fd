/**
 * Leaf provenance for a clean merge.
 *
 * For every leaf path of the merged document this module reports where the
 * value came from:
 *
 *  - "base":   the leaf survived from the base document untouched;
 *  - "A"/"B":  the leaf was written by an operation of that patch only;
 *  - "both":   both patches wrote a deeply equal value at that leaf (the
 *              merge deduplicates identical writes; attribution keeps both).
 *
 * Each entry lists the contributing operations by side and ORIGINAL index in
 * patchA / patchB. Operations whose effect was overridden — intra-patch
 * last-write-wins losers, the deletion half of a delete-then-recreate — do
 * not contribute and never appear.
 *
 * Attribution replays the exact base-coordinate merge pipeline (planMerge +
 * applyMerge from merge.js) on a provenance-annotated mirror of the inputs:
 * every scalar leaf of the base document is replaced by a "base" tag and
 * every operation value is annotated with a tag naming its source side and
 * contributing operations. The mirror is container-isomorphic to the real
 * document, so applyMerge applies the SAME array relocation rules as the
 * real merge — removals shift surviving elements, same-gap insertions keep
 * their A-before-B order, deep edits follow their base element — and every
 * tag lands at the FINAL JSON Pointer its value occupies in `merged`.
 *
 * Leaves are scalars, null and EMPTY containers ({} / []): an empty container
 * has no children to attribute, so it is itself the leaf. Empty containers
 * that survive from base untouched are reported as "base"; empty containers
 * written by an operation carry that operation's tag.
 *
 * The result is a pure function of the stored inputs; entries are sorted by
 * JSON Pointer in UTF-16 code-unit order, so repeated queries against the
 * same record serialize byte-for-byte identically.
 */

import { planMerge, applyMerge, formatPointer } from './merge.js';

/* ------------------------------ tagged mirror ----------------------------- */

// Marker key identifying a provenance tag. Collision-proof: after tagging,
// every property value of an internal node is itself a tag or a container,
// never the literal `true`, so only genuine tags satisfy isTag().
const TAG_MARK = '$prov';

function makeTag(source, operations) {
  return { [TAG_MARK]: true, source, operations };
}

function isTag(node) {
  return (
    node !== null &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    node[TAG_MARK] === true &&
    typeof node.source === 'string' &&
    Array.isArray(node.operations)
  );
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

/**
 * Mirror of the base document with every scalar leaf replaced by a "base"
 * tag. Containers (including empty ones) are preserved as-is so applyMerge
 * resolves array indices and object members exactly as for the real
 * document — an empty base array can still receive insertions.
 */
function tagBaseLeaves(value) {
  if (Array.isArray(value)) return value.map(tagBaseLeaves);
  if (isContainer(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = tagBaseLeaves(value[key]);
    return out;
  }
  return makeTag('base', []);
}

/**
 * Mirror of an operation value with every leaf replaced by the operation's
 * tag. Empty containers count as leaves here: an operation value never
 * receives deeper operations (the merge engine rejects or conflicts those),
 * so its empty containers are always leaf-shaped in the merged document.
 */
function tagValueLeaves(value, tag) {
  if (Array.isArray(value)) {
    if (value.length === 0) return makeTag(tag.source, tag.operations);
    return value.map((item) => tagValueLeaves(item, tag));
  }
  if (isContainer(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return makeTag(tag.source, tag.operations);
    const out = {};
    for (const key of keys) out[key] = tagValueLeaves(value[key], tag);
    return out;
  }
  return makeTag(tag.source, tag.operations);
}

/* ------------------------------- leaf walk -------------------------------- */

function pointerCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1; // UTF-16 code-unit order, locale-independent
}

function emitBaseLeaf(out, segments) {
  out.push({ path: formatPointer(segments), source: 'base', operations: [] });
}

/**
 * Collect the tag at every leaf of the annotated merged document. An empty
 * container at this stage can only be one that survived from base untouched
 * (operation values had their empty containers tagged), so it is a base leaf.
 */
function collectLeaves(node, segments, out) {
  if (isTag(node)) {
    out.push({
      path: formatPointer(segments),
      source: node.source,
      operations: node.operations.map((o) => ({ side: o.side, index: o.index })),
    });
    return;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) {
      emitBaseLeaf(out, segments);
      return;
    }
    for (let i = 0; i < node.length; i++) {
      collectLeaves(node[i], [...segments, String(i)], out);
    }
    return;
  }
  const keys = Object.keys(node);
  if (keys.length === 0) {
    emitBaseLeaf(out, segments);
    return;
  }
  for (const key of keys) collectLeaves(node[key], [...segments, key], out);
}

/* --------------------------------- entry ---------------------------------- */

/**
 * Compute the leaf provenance of a clean merge from its stored inputs.
 * Returns { leaves, summary } with leaves sorted by JSON Pointer (UTF-16
 * code-unit order) and summary counting leaves per source.
 */
export function computeProvenance(base, patchA, patchB) {
  const plan = planMerge(base, patchA, patchB);

  const byId = new Map();
  for (const op of [...plan.opsA, ...plan.opsB]) byId.set(op.id, op);

  // Survivor id -> contributing operations: itself, plus any dropped
  // equal-value duplicates from the other side (reported as "both").
  const contributors = new Map();
  for (const op of plan.surviving) contributors.set(op.id, [op]);
  for (const [droppedId, survivorId] of plan.duplicates) {
    const list = contributors.get(survivorId);
    if (list) list.push(byId.get(droppedId));
  }

  const provOps = plan.surviving.map((op) => {
    if (op.op === 'remove') return op; // removals only relocate base tags
    const ops = contributors.get(op.id);
    const source = ops.length > 1 ? 'both' : ops[0].side;
    const operations = ops
      .map((o) => ({ side: o.side, index: o.index }))
      .sort((x, y) => pointerCompare(x.side, y.side) || x.index - y.index);
    return { ...op, value: tagValueLeaves(op.value, { source, operations }) };
  });

  const provDoc = applyMerge(tagBaseLeaves(base), provOps);

  const leaves = [];
  collectLeaves(provDoc, [], leaves);
  leaves.sort((x, y) => pointerCompare(x.path, y.path));

  const summary = { total: leaves.length, base: 0, A: 0, B: 0, both: 0 };
  for (const leaf of leaves) summary[leaf.source] += 1;

  return { leaves, summary };
}
