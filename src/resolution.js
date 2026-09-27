/**
 * Conflict-resolution preview.
 *
 * Given a stored rehearsal whose merge produced conflicts, the client submits
 * one decision per conflict — identified by the conflict's index in the
 * record's `conflicts` array — naming the winning side ("A" or "B"). The
 * losing side's operation is removed from the original patch and the
 * base-coordinate merge engine (merge.js) is re-run on the filtered patches.
 *
 * The preview is a pure function of the stored record and the decisions: the
 * record is never mutated and repeated requests produce identical results.
 */

import { mergePatches } from './merge.js';

export const DECISION_CODES = Object.freeze({
  INVALID_DECISIONS: 'INVALID_DECISIONS',
  CONTRADICTORY_DECISIONS: 'CONTRADICTORY_DECISIONS',
});

export class DecisionError extends Error {
  constructor(message, { code, ...details } = {}) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
    this.details = details;
  }
}

/** Operations are identified by side + index in the ORIGINAL patch ("A#0"). */
const opKey = (ref) => `${ref.side}#${ref.index}`;

function bySideThenIndex(x, y) {
  return x.side.localeCompare(y.side) || x.index - y.index;
}

const ascending = (a, b) => a - b;

/** Accumulate one decision outcome, keyed by side + original operation index. */
function tally(map, opRef, conflictIndex) {
  const key = opKey(opRef);
  let entry = map.get(key);
  if (!entry) {
    entry = { ...opRef, conflicts: [] };
    map.set(key, entry);
  }
  entry.conflicts.push(conflictIndex);
}

/** Deterministic view of a tally map: sorted by side then original index. */
function sortedEntries(map) {
  return [...map.values()]
    .map((entry) => ({ ...entry, conflicts: [...entry.conflicts].sort(ascending) }))
    .sort(bySideThenIndex);
}

/**
 * The decisions must cover every conflict exactly once: no missing, no
 * duplicated and no out-of-range conflict indices.
 */
function checkCoverage(decisions, conflictCount) {
  const counts = new Map();
  for (const d of decisions) counts.set(d.conflict, (counts.get(d.conflict) ?? 0) + 1);
  const missing = [];
  for (let i = 0; i < conflictCount; i++) {
    if (!counts.has(i)) missing.push(i);
  }
  const duplicate = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([i]) => i)
    .sort(ascending);
  const unexpected = [...counts.keys()]
    .filter((i) => i < 0 || i >= conflictCount)
    .sort(ascending);
  if (missing.length || duplicate.length || unexpected.length) {
    throw new DecisionError(
      `decisions must cover each of the ${conflictCount} conflict(s) exactly once`,
      {
        code: DECISION_CODES.INVALID_DECISIONS,
        expected: conflictCount,
        missing,
        duplicate,
        unexpected,
      },
    );
  }
}

/**
 * Apply winner decisions to a conflict record and re-run the merge.
 *
 * Returns { status, merged, conflicts, retained, dropped, stats } where
 * retained/dropped list the original operations kept/removed by the
 * decisions (each annotated with the conflict indices that decided it).
 *
 * Throws DecisionError (INVALID_DECISIONS) when the decisions do not cover
 * the conflicts exactly, and (CONTRADICTORY_DECISIONS) when the same
 * original operation is retained by one decision and dropped by another.
 */
export function previewResolution(record, decisions) {
  const conflicts = record.conflicts;
  checkCoverage(decisions, conflicts.length);

  const retained = new Map();
  const dropped = new Map();
  for (const d of decisions) {
    const conflict = conflicts[d.conflict];
    const winner = conflict.operations.find((o) => o.side === d.winner);
    const loser = conflict.operations.find((o) => o.side !== d.winner);
    tally(retained, winner, d.conflict);
    tally(dropped, loser, d.conflict);
  }

  const contradictions = [];
  for (const [key, keep] of retained) {
    const drop = dropped.get(key);
    if (!drop) continue;
    const { conflicts: retainedIn, ...operation } = keep;
    contradictions.push({
      ...operation,
      retainedIn: [...retainedIn].sort(ascending),
      droppedIn: [...drop.conflicts].sort(ascending),
    });
  }
  if (contradictions.length) {
    contradictions.sort(bySideThenIndex);
    throw new DecisionError(
      'decisions require the same operation to be both retained and dropped',
      { code: DECISION_CODES.CONTRADICTORY_DECISIONS, contradictions },
    );
  }

  // Remove the losing operations from the original patches (by original
  // index) and re-run the base-coordinate merge on what remains.
  const droppedKeys = new Set(dropped.keys());
  const patchA = record.patchA.filter((_, index) => !droppedKeys.has(`A#${index}`));
  const patchB = record.patchB.filter((_, index) => !droppedKeys.has(`B#${index}`));
  const result = mergePatches(record.base, patchA, patchB);

  return {
    status: result.status,
    merged: result.merged,
    conflicts: result.conflicts,
    retained: sortedEntries(retained),
    dropped: sortedEntries(dropped),
    stats: result.stats,
  };
}
