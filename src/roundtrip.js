/**
 * Deterministic round-trip plan for a clean merge.
 *
 * Given the saved base document and the merged result, build two RFC 6902
 * patches containing ONLY add/remove/replace operations:
 *
 *  - forward:  base   -> merged
 *  - rollback: merged -> base
 *
 * Determinism rules:
 *  - object members are visited in UTF-16 code-unit ("dictionary") key order
 *    and every reference token is JSON-Pointer escaped (~ -> ~0, / -> ~1);
 *  - arrays are aligned by a longest common subsequence of deeply equal
 *    elements (ties resolved deterministically): equal elements stay in place
 *    untouched, every other base element is removed and every other merged
 *    element inserted;
 *  - within one array the removals are emitted at DESCENDING base indices and
 *    the insertions at ASCENDING final indices, so every array index is
 *    correct at the moment the operation executes.
 *
 * Before a plan is returned both patches are replayed here under strict
 * RFC 6902 semantics: the forward patch applied to base must yield merged and
 * the rollback patch applied to merged must restore base. The plan is a pure
 * function of its two inputs and every emitted value is a snapshot, so cached
 * answers for the same record serialize byte-for-byte.
 */

import { deepEqual, formatPointer, parsePointer } from './merge.js';

export class RoundTripError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RoundTripError';
    this.code = details.code || 'ROUND_TRIP_ERROR';
    this.details = details;
  }
}

/* ------------------------------- diff engine ------------------------------ */

function isContainer(v) {
  return v !== null && typeof v === 'object';
}

/**
 * Append the operations that transform base into merged at `segments`.
 */
function diffValues(base, merged, segments, out) {
  if (deepEqual(base, merged)) return;

  const baseIsArray = Array.isArray(base);
  const mergedIsArray = Array.isArray(merged);

  if (baseIsArray || mergedIsArray) {
    if (baseIsArray !== mergedIsArray) {
      // Container kind change (array <-> object) at this path: rewrite wholesale.
      out.push({ op: 'replace', path: formatPointer(segments), value: structuredClone(merged) });
      return;
    }
    diffArray(base, merged, segments, out);
    return;
  }

  if (isContainer(base) && isContainer(merged)) {
    diffObject(base, merged, segments, out);
    return;
  }

  // Scalar (or null) change, including a replace of the document root ("").
  out.push({ op: 'replace', path: formatPointer(segments), value: structuredClone(merged) });
}

function diffObject(base, merged, segments, out) {
  const keys = new Set([...Object.keys(base), ...Object.keys(merged)]);
  // Dictionary order: plain Array.sort compares by UTF-16 code units, which is
  // locale-independent and stable across runs.
  for (const key of [...keys].sort()) {
    const child = [...segments, key];
    const inBase = Object.prototype.hasOwnProperty.call(base, key);
    const inMerged = Object.prototype.hasOwnProperty.call(merged, key);
    if (inBase && inMerged) {
      diffValues(base[key], merged[key], child, out);
    } else if (inMerged) {
      out.push({ op: 'add', path: formatPointer(child), value: structuredClone(merged[key]) });
    } else {
      out.push({ op: 'remove', path: formatPointer(child) });
    }
  }
}

/**
 * Longest common subsequence of deeply equal elements.
 * Returns the base indices that belong to the LCS (ascending). On equal DP
 * scores the base side is skipped first, which makes the alignment unique even
 * when an element value repeats.
 */
function lcsBaseKept(base, merged) {
  const n = base.length;
  const m = merged.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = deepEqual(base[i], merged[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const kept = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (deepEqual(base[i], merged[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      kept.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return kept;
}

function diffArray(base, merged, segments, out) {
  // LCS-paired elements are deeply equal by construction and need no edits;
  // everything else is removed from base and inserted from merged.
  const keptBase = lcsBaseKept(base, merged);

  // Removals at descending base indices: deleting a high index first leaves
  // every lower index valid for the next operation.
  for (let i = base.length - 1; i >= 0; i--) {
    if (!keptBase.has(i)) {
      out.push({ op: 'remove', path: formatPointer([...segments, String(i)]) });
    }
  }

  // Insertions at ascending FINAL (merged-array) indices. After the removals
  // the array is rebuilt left to right, so an add at the element's merged
  // index always slots it into its final position.
  const keptBaseAsc = [...keptBase].sort((a, b) => a - b);
  // Walk base/merged in LCS order to know which merged indices are insertions.
  let basePtr = 0;
  for (let j = 0; j < merged.length; j++) {
    // Is merged[j] the next kept base element?
    const nextKept = base[keptBaseAsc[basePtr]];
    if (nextKept !== undefined && deepEqual(nextKept, merged[j])) {
      basePtr++;
      continue;
    }
    out.push({
      op: 'add',
      path: formatPointer([...segments, String(j)]),
      value: structuredClone(merged[j]),
    });
  }
}

/**
 * Pure RFC 6902 diff (add/remove/replace only) between two JSON values.
 */
export function diffDocuments(base, merged) {
  const out = [];
  diffValues(base, merged, [], out);
  return out;
}

/* ------------------------- strict RFC 6902 replay ------------------------- */

function parseRfcIndex(token, { add = false } = {}) {
  if (add && token === '-') return null; // append gap
  if (token === '0') return 0;
  if (!/^[1-9][0-9]*$/.test(token)) {
    throw new RoundTripError(`invalid array index "${token}"`, {
      code: 'ROUND_TRIP_INVALID_INDEX',
      token,
    });
  }
  const n = Number(token);
  if (!Number.isSafeInteger(n)) {
    throw new RoundTripError(`array index "${token}" is not a safe integer`, {
      code: 'ROUND_TRIP_INVALID_INDEX',
      token,
    });
  }
  return n;
}

/**
 * Apply one strict RFC 6902 add/remove/replace operation, mutating `parent`
 * chains in place. Returns the (possibly replaced) document.
 */
function applyRfcOperation(doc, raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RoundTripError(`operation ${index} must be an object`, {
      code: 'ROUND_TRIP_INVALID_OPERATION',
      index,
    });
  }
  const op = raw.op;
  if (op !== 'add' && op !== 'remove' && op !== 'replace') {
    throw new RoundTripError(`operation ${index}: unsupported op "${op}"`, {
      code: 'ROUND_TRIP_UNSUPPORTED_OP',
      index,
    });
  }
  if (typeof raw.path !== 'string') {
    throw new RoundTripError(`operation ${index}: "path" must be a string`, {
      code: 'ROUND_TRIP_INVALID_PATH',
      index,
    });
  }
  if ((op === 'add' || op === 'replace') && !('value' in raw)) {
    throw new RoundTripError(`operation ${index} (${op}) requires a "value" member`, {
      code: 'ROUND_TRIP_MISSING_VALUE',
      index,
    });
  }

  const segments = parsePointer(raw.path);

  if (segments.length === 0) {
    if (op === 'remove') {
      throw new RoundTripError('removing the document root is not supported', {
        code: 'ROUND_TRIP_ROOT_NOT_REMOVABLE',
        index,
      });
    }
    return structuredClone(raw.value);
  }

  let parent = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const token = segments[i];
    if (Array.isArray(parent)) {
      const idx = parseRfcIndex(token);
      if (idx >= parent.length) {
        throw new RoundTripError(
          `operation ${index}: array index ${idx} out of bounds at ${formatPointer(segments.slice(0, i + 1))}`,
          { code: 'ROUND_TRIP_OUT_OF_BOUNDS', index },
        );
      }
      parent = parent[idx];
    } else if (isContainer(parent)) {
      if (!Object.prototype.hasOwnProperty.call(parent, token)) {
        throw new RoundTripError(
          `operation ${index}: path does not exist: ${formatPointer(segments.slice(0, i + 1))}`,
          { code: 'ROUND_TRIP_PATH_NOT_FOUND', index },
        );
      }
      parent = parent[token];
    } else {
      throw new RoundTripError(
        `operation ${index}: cannot traverse a non-container at ${formatPointer(segments.slice(0, i + 1))}`,
        { code: 'ROUND_TRIP_TRAVERSAL_ERROR', index },
      );
    }
  }

  const token = segments[segments.length - 1];

  if (Array.isArray(parent)) {
    if (op === 'add') {
      const idx = parseRfcIndex(token, { add: true });
      if (idx !== null && idx > parent.length) {
        throw new RoundTripError(
          `operation ${index}: add index ${idx} out of bounds (array length ${parent.length})`,
          { code: 'ROUND_TRIP_OUT_OF_BOUNDS', index },
        );
      }
      parent.splice(idx === null ? parent.length : idx, 0, structuredClone(raw.value));
    } else {
      const idx = parseRfcIndex(token);
      if (idx >= parent.length) {
        throw new RoundTripError(
          `operation ${index}: array index ${idx} out of bounds (array length ${parent.length})`,
          { code: 'ROUND_TRIP_OUT_OF_BOUNDS', index },
        );
      }
      if (op === 'remove') parent.splice(idx, 1);
      else parent[idx] = structuredClone(raw.value);
    }
    return doc;
  }

  if (isContainer(parent)) {
    const has = Object.prototype.hasOwnProperty.call(parent, token);
    if (op === 'remove') {
      if (!has) {
        throw new RoundTripError(`operation ${index}: path does not exist: ${raw.path}`, {
          code: 'ROUND_TRIP_PATH_NOT_FOUND',
          index,
        });
      }
      delete parent[token];
    } else if (op === 'replace') {
      if (!has) {
        throw new RoundTripError(
          `operation ${index}: cannot replace a non-existent object member: ${raw.path}`,
          { code: 'ROUND_TRIP_PATH_NOT_FOUND', index },
        );
      }
      parent[token] = structuredClone(raw.value);
    } else {
      // RFC 6902: add overwrites an existing object member.
      parent[token] = structuredClone(raw.value);
    }
    return doc;
  }

  throw new RoundTripError(`operation ${index}: target parent is neither object nor array`, {
    code: 'ROUND_TRIP_TRAVERSAL_ERROR',
    index,
  });
}

/**
 * Strict RFC 6902 replay of an add/remove/replace patch. Throws RoundTripError
 * on the first operation that does not apply.
 */
export function applyPatch(doc, patch) {
  if (!Array.isArray(patch)) {
    throw new RoundTripError('patch must be an array of operations', {
      code: 'ROUND_TRIP_INVALID_PATCH',
    });
  }
  let current = structuredClone(doc);
  patch.forEach((op, i) => {
    current = applyRfcOperation(current, op, i);
  });
  return current;
}

/* --------------------------------- entry ---------------------------------- */

function countOps(patch) {
  const counts = { add: 0, remove: 0, replace: 0, total: patch.length };
  for (const op of patch) counts[op.op]++;
  return counts;
}

/**
 * Build the verified round-trip plan between base and merged.
 *
 * Both patches are actually replayed server-side: forward must produce merged
 * from base and rollback must restore base from merged. A failed verification
 * is a RoundTripError; callers must not return a plan in that case.
 */
export function buildRoundTripPlan(base, merged) {
  const forward = diffDocuments(base, merged);
  const rollback = diffDocuments(merged, base);

  const replayedMerged = applyPatch(base, forward);
  if (!deepEqual(replayedMerged, merged)) {
    throw new RoundTripError('forward replay did not produce the merged document', {
      code: 'ROUND_TRIP_FORWARD_MISMATCH',
    });
  }
  const replayedBase = applyPatch(merged, rollback);
  if (!deepEqual(replayedBase, base)) {
    throw new RoundTripError('rollback replay did not restore the base document', {
      code: 'ROUND_TRIP_ROLLBACK_MISMATCH',
    });
  }

  return {
    forward,
    rollback,
    operationCount: {
      forward: countOps(forward),
      rollback: countOps(rollback),
    },
  };
}
