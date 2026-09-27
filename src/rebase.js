/**
 * Rebase a pending patch onto a new upstream version.
 *
 * A client holds a patch expressed against the ORIGINAL base document and
 * wants to move ("rebase") it onto a newer upstream version `onto`. This
 * module converts the base -> onto delta into operations in the merge
 * engine's BASE COORDINATES (merge.js): object members are addressed by key,
 * array removals name base element indices and array insertions name the
 * base gap they belong to. Arrays are aligned by a longest common
 * subsequence of deeply equal elements — equal elements keep their identity
 * and stay untouched, every unmatched base element is deleted, every
 * unmatched onto element is inserted, and a run of consecutive insertions
 * between the same kept neighbours shares one gap (accumulating in order).
 *
 * The upstream operations (side A) and the client patch (side B) are then
 * merged by the rehearsal engine against `base`. On a clean merge the
 * rebased patch — a plain sequential RFC 6902 patch that transforms `onto`
 * into the merged document — is produced by the deterministic diff from
 * roundtrip.js and REPLAYED against `onto`; the result is only returned
 * when the replay equals the merged document. On conflict no executable
 * patch is returned, only the structured conflicts (reason, path and both
 * sides' operation indices).
 */

import { mergePatches, deepEqual, formatPointer } from './merge.js';
import { diffDocuments, applyPatch } from './roundtrip.js';

export class RebaseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RebaseError';
    this.code = details.code || 'REBASE_ERROR';
    this.details = details;
  }
}

/* --------------------- base-coordinate diff (base -> onto) ----------------- */

/**
 * Longest common subsequence of deeply equal elements, returned as matched
 * [baseIndex, ontoIndex] pairs in ascending order. Mirrors the alignment of
 * roundtrip.js (same DP, same tie-break: on equal scores the base side is
 * skipped first) so rebasing and round-trip planning align arrays the same
 * way even when an element value repeats.
 */
function lcsPairs(base, onto) {
  const n = base.length;
  const m = onto.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = deepEqual(base[i], onto[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (deepEqual(base[i], onto[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Append the base-coordinate operations that transform base into onto at
 * `segments`. Unlike the sequential RFC 6902 diff in roundtrip.js, every
 * emitted path is interpreted against the BASE document (the merge engine's
 * coordinate system), so the caller never has to undo index drift.
 */
function diffNode(base, onto, segments, out) {
  if (deepEqual(base, onto)) return;
  if (Array.isArray(base) && Array.isArray(onto)) {
    diffArray(base, onto, segments, out);
    return;
  }
  if (isPlainObject(base) && isPlainObject(onto)) {
    diffObject(base, onto, segments, out);
    return;
  }
  // Scalar change or container-kind change (array <-> object, container <->
  // scalar) at this path, including a replace of the document root ("").
  out.push({ op: 'replace', path: formatPointer(segments), value: structuredClone(onto) });
}

function diffObject(base, onto, segments, out) {
  const keys = new Set([...Object.keys(base), ...Object.keys(onto)]);
  // Dictionary order: plain Array.sort compares by UTF-16 code units, which
  // is locale-independent and stable across runs.
  for (const key of [...keys].sort()) {
    const child = [...segments, key];
    const inBase = Object.prototype.hasOwnProperty.call(base, key);
    const inOnto = Object.prototype.hasOwnProperty.call(onto, key);
    if (inBase && inOnto) {
      diffNode(base[key], onto[key], child, out);
    } else if (inOnto) {
      out.push({ op: 'add', path: formatPointer(child), value: structuredClone(onto[key]) });
    } else {
      out.push({ op: 'remove', path: formatPointer(child) });
    }
  }
}

function diffArray(base, onto, segments, out) {
  const pairs = lcsPairs(base, onto);
  const keptBase = new Set(pairs.map(([i]) => i));
  const keptOnto = new Set(pairs.map(([, j]) => j));

  // Unmatched base elements are deleted by identity: the removal names the
  // element's index in the BASE array, however other operations shift
  // indices. Emitted ascending for determinism (order is irrelevant in base
  // coordinates).
  for (let i = 0; i < base.length; i++) {
    if (!keptBase.has(i)) {
      out.push({ op: 'remove', path: formatPointer([...segments, String(i)]) });
    }
  }

  // Unmatched onto elements are inserted into the gap before the next kept
  // base element, or the append gap when none follows. Consecutive
  // insertions between the same kept neighbours share one gap and, being
  // emitted in ascending onto order, accumulate in their final order.
  let p = 0;
  for (let j = 0; j < onto.length; j++) {
    while (p < pairs.length && pairs[p][1] <= j) p++;
    if (keptOnto.has(j)) continue;
    const gap = p < pairs.length ? pairs[p][0] : base.length;
    out.push({
      op: 'add',
      path: formatPointer([...segments, String(gap)]),
      value: structuredClone(onto[j]),
    });
  }
}

/**
 * Base-coordinate operation list transforming `base` into `onto`, ready to
 * be fed into the merge engine as one side of a rehearsal merge. Applying
 * it to `base` through the engine yields exactly `onto`.
 */
export function diffBaseCoordinates(base, onto) {
  const out = [];
  diffNode(base, onto, [], out);
  return out;
}

/* --------------------------------- entry ---------------------------------- */

/**
 * Rebase `patch` (expressed against `base`) onto the new upstream version
 * `onto`.
 *
 * Returns:
 *  - { status: 'clean', merged, rebasedPatch, upstream, conflicts: [] }
 *  - { status: 'conflict', merged: null, rebasedPatch: null, upstream, conflicts }
 *
 * `upstream` is the base-coordinate base -> onto operation list; conflict
 * operations with side "A" index into it, side "B" into the client patch.
 *
 * PatchError from the merge engine propagates (invalid client patch). A
 * replay mismatch of the rebased patch throws RebaseError; that is a server
 * error and not expected for valid inputs.
 */
export function rebasePatch(base, patch, onto) {
  const upstream = diffBaseCoordinates(base, onto);
  // Side A carries the upstream (base -> onto) operations, side B the client
  // patch; when both insert into the same array gap, upstream lands first.
  const result = mergePatches(base, upstream, patch);
  if (result.status === 'conflict') {
    return {
      status: 'conflict',
      merged: null,
      rebasedPatch: null,
      upstream,
      conflicts: result.conflicts,
    };
  }
  const merged = result.merged;
  // The rebased patch is expressed against onto: a plain sequential RFC 6902
  // patch. Replay it server-side and only return it when the replay
  // reproduces the merged document exactly.
  const rebasedPatch = diffDocuments(onto, merged);
  const replayed = applyPatch(onto, rebasedPatch);
  if (!deepEqual(replayed, merged)) {
    throw new RebaseError('rebased patch replay did not produce the merged document', {
      code: 'REBASE_REPLAY_MISMATCH',
    });
  }
  return { status: 'clean', merged, rebasedPatch, upstream, conflicts: [] };
}
