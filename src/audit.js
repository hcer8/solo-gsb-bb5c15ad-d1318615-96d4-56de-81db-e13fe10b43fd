/**
 * Order audit: strict RFC 6902 sequential replay of two saved patches.
 *
 * Unlike the three-way rehearsal engine in merge.js (which interprets every
 * path against the base document), the audit plays each patch as a genuine
 * RFC 6902 patch sequence: operation N is evaluated against the document
 * produced by operations 0..N-1. Array indices are therefore resolved in the
 * CURRENT document — index drift caused by earlier add/remove operations is
 * never remapped to base coordinates.
 *
 * Two replays are performed: A then B, and B then A. Outcomes:
 *  - both apply and the final documents are deeply equal  -> "commutative"
 *  - both apply but the final documents differ            -> "divergent"
 *    (with the leaf difference whose RFC 6901 pointer is lexicographically
 *    smallest)
 *  - at least one order fails                              -> "failed"
 *    (failing side, original operation index and the document as it was
 *    immediately before the failing operation are reported)
 *
 * Every value captured in the trace is a structuredClone snapshot, so the
 * audit result is a pure function of the saved inputs and repeated queries
 * serialize identically.
 */

import { deepEqual, formatPointer } from './merge.js';

export const AUDIT_VERDICTS = Object.freeze({
  COMMUTATIVE: 'commutative',
  DIVERGENT: 'divergent',
  FAILED: 'failed',
});

export const REPLAY_CODES = Object.freeze({
  INVALID_OPERATION: 'INVALID_OPERATION',
  UNSUPPORTED_OP: 'UNSUPPORTED_OP',
  INVALID_PATH: 'INVALID_PATH',
  MISSING_VALUE: 'MISSING_VALUE',
  INVALID_INDEX: 'INVALID_INDEX',
  OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  PATH_NOT_FOUND: 'PATH_NOT_FOUND',
  TRAVERSAL_ERROR: 'TRAVERSAL_ERROR',
  ROOT_NOT_REMOVABLE: 'ROOT_NOT_REMOVABLE',
});

export class ReplayFailure extends Error {
  constructor(message, { code, side, index, op, path } = {}) {
    super(message);
    this.name = 'ReplayFailure';
    this.code = code;
    this.side = side;
    this.index = index;
    this.op = op;
    this.path = path;
  }
}

/* ------------------------------ JSON Pointer ----------------------------- */

/**
 * RFC 6901 parser. Stricter than the rehearsal parser: a "~" that is not
 * followed by "0" or "1" makes the reference token malformed.
 */
function parsePointerStrict(pointer, side, index) {
  if (typeof pointer !== 'string') {
    throw new ReplayFailure('operation "path" must be a string', {
      code: REPLAY_CODES.INVALID_PATH,
      side,
      index,
      op: null,
      path: null,
    });
  }
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new ReplayFailure(
      `invalid JSON Pointer "${pointer}": must be "" or start with "/"`,
      { code: REPLAY_CODES.INVALID_PATH, side, index, op: null, path: pointer },
    );
  }
  const tokens = pointer.slice(1).split('/');
  for (const token of tokens) {
    if (/~(?!0|1)/.test(token)) {
      throw new ReplayFailure(
        `invalid JSON Pointer "${pointer}": "~" must be escaped as "~0"`,
        { code: REPLAY_CODES.INVALID_PATH, side, index, op: null, path: pointer },
      );
    }
  }
  return tokens.map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/* -------------------------------- helpers -------------------------------- */

function fail(message, code, ctx) {
  return new ReplayFailure(message, { code, ...ctx });
}

/**
 * Parse an array index reference token per RFC 6902 §4:
 *  - "0" is the only token allowed to start with a zero;
 *  - leading zeros are otherwise invalid;
 *  - when allowDash is true (array "add"), "-" denotes the append gap.
 * Returns the numeric index, or null for the "-" append marker.
 */
function parseArrayIndex(token, ctx, { allowDash = false } = {}) {
  if (allowDash && token === '-') return null;
  if (token === '0') return 0;
  if (!/^[1-9][0-9]*$/.test(token)) {
    throw fail(
      `"${token}" is not a valid array index at ${ctx.at}`,
      REPLAY_CODES.INVALID_INDEX,
      ctx,
    );
  }
  const n = Number(token);
  if (!Number.isSafeInteger(n)) {
    throw fail(
      `array index "${token}" is not a safe integer at ${ctx.at}`,
      REPLAY_CODES.INVALID_INDEX,
      ctx,
    );
  }
  return n;
}

function isContainer(node) {
  return node !== null && typeof node === 'object';
}

/**
 * Walk every segment but the last, resolving against the CURRENT document.
 */
function navigateToParent(doc, segments, ctx) {
  let node = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const token = segments[i];
    const at = formatPointer(segments.slice(0, i + 1));
    if (Array.isArray(node)) {
      const idx = parseArrayIndex(token, { ...ctx, at });
      if (idx >= node.length) {
        throw fail(
          `array index ${idx} out of bounds (length ${node.length}) at ${at}`,
          REPLAY_CODES.OUT_OF_BOUNDS,
          { ...ctx, path: formatPointer(segments) },
        );
      }
      node = node[idx];
    } else if (isContainer(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, token)) {
        throw fail(
          `path does not exist: ${at}`,
          REPLAY_CODES.PATH_NOT_FOUND,
          { ...ctx, path: formatPointer(segments) },
        );
      }
      node = node[token];
    } else {
      throw fail(
        `cannot traverse into ${node === null ? 'null' : typeof node} at ${at}`,
        REPLAY_CODES.TRAVERSAL_ERROR,
        { ...ctx, path: formatPointer(segments) },
      );
    }
  }
  return node;
}

/* ---------------------------- one RFC 6902 op ----------------------------- */

/**
 * Apply a single raw operation to doc (mutated in place; the root document is
 * replaced for add/replace at "" ). Returns the post-operation value snapshot
 * captured at the operation's own target.
 */
function applyOne(doc, raw, side, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('operation must be an object', REPLAY_CODES.INVALID_OPERATION, {
      side,
      index,
      op: null,
      path: null,
    });
  }
  const { op, path } = raw;
  if (op !== 'add' && op !== 'remove' && op !== 'replace') {
    throw fail(
      `unsupported op "${op}" (only add, remove, replace are accepted)`,
      REPLAY_CODES.UNSUPPORTED_OP,
      { side, index, op: typeof op === 'string' ? op : null, path: typeof path === 'string' ? path : null },
    );
  }
  if ((op === 'add' || op === 'replace') && !('value' in raw)) {
    throw fail(`"${op}" operation requires a "value" member`, REPLAY_CODES.MISSING_VALUE, {
      side,
      index,
      op,
      path: typeof path === 'string' ? path : null,
    });
  }
  const segments = parsePointerStrict(path, side, index);
  const ctx = { side, index, op, path };

  // Document-root operations.
  if (segments.length === 0) {
    if (op === 'remove') {
      throw fail(
        'removing the document root is not supported',
        REPLAY_CODES.ROOT_NOT_REMOVABLE,
        ctx,
      );
    }
    const next = structuredClone(raw.value);
    return { doc: next, afterExists: true, afterValue: structuredClone(next) };
  }

  const parent = navigateToParent(doc, segments, ctx);
  const token = segments[segments.length - 1];
  const at = formatPointer(segments.slice(0, -1)) || '(root)';

  if (Array.isArray(parent)) {
    if (op === 'add') {
      const idx = parseArrayIndex(token, { ...ctx, at }, { allowDash: true });
      if (idx === null) {
        parent.push(structuredClone(raw.value));
      } else {
        if (idx > parent.length) {
          throw fail(
            `add index ${idx} out of bounds (array length ${parent.length}) at ${at}`,
            REPLAY_CODES.OUT_OF_BOUNDS,
            ctx,
          );
        }
        parent.splice(idx, 0, structuredClone(raw.value));
      }
      return { doc, afterExists: true, afterValue: structuredClone(raw.value) };
    }
    const idx = parseArrayIndex(token, { ...ctx, at });
    if (idx >= parent.length) {
      throw fail(
        `array index ${idx} out of bounds (length ${parent.length}) at ${at}`,
        REPLAY_CODES.OUT_OF_BOUNDS,
        ctx,
      );
    }
    if (op === 'remove') {
      const [removed] = parent.splice(idx, 1);
      return {
        doc,
        afterExists: false,
        afterValue: null,
        removedValue: structuredClone(removed),
      };
    }
    parent[idx] = structuredClone(raw.value); // replace
    return { doc, afterExists: true, afterValue: structuredClone(parent[idx]) };
  }

  if (isContainer(parent)) {
    const has = Object.prototype.hasOwnProperty.call(parent, token);
    if (op === 'remove') {
      if (!has) {
        throw fail(`path does not exist: ${path}`, REPLAY_CODES.PATH_NOT_FOUND, ctx);
      }
      const removed = parent[token];
      delete parent[token];
      return {
        doc,
        afterExists: false,
        afterValue: null,
        removedValue: structuredClone(removed),
      };
    }
    if (op === 'replace' && !has) {
      throw fail(
        `cannot replace a non-existent object member: ${path}`,
        REPLAY_CODES.PATH_NOT_FOUND,
        ctx,
      );
    }
    // add: existing object member is overwritten per RFC 6902.
    parent[token] = structuredClone(raw.value);
    return { doc, afterExists: true, afterValue: structuredClone(parent[token]) };
  }

  throw fail(
    `cannot target a member of ${parent === null ? 'null' : typeof parent} at ${at}`,
    REPLAY_CODES.TRAVERSAL_ERROR,
    ctx,
  );
}

/* ------------------------------ one ordering ----------------------------- */

const ORDER_SIDES = Object.freeze({
  'A->B': ['A', 'B'],
  'B->A': ['B', 'A'],
});

function replayOrder(base, patchA, patchB, order) {
  let doc = structuredClone(base);
  const steps = [];
  for (const side of ORDER_SIDES[order]) {
    const patch = side === 'A' ? patchA : patchB;
    for (let index = 0; index < patch.length; index++) {
      const raw = patch[index];
      const documentBefore = structuredClone(doc);
      let result;
      try {
        result = applyOne(doc, raw, side, index);
      } catch (err) {
        if (!(err instanceof ReplayFailure)) throw err;
        return {
          status: 'failed',
          steps,
          finalDocument: null,
          failure: {
            order,
            side,
            index,
            op: err.op,
            path: err.path,
            code: err.code,
            message: err.message,
            documentBefore,
          },
        };
      }
      doc = result.doc;
      const step = {
        order,
        side,
        index,
        op: raw.op,
        path: raw.path,
        afterExists: result.afterExists,
        afterValue: result.afterValue,
      };
      if (!result.afterExists) step.removedValue = result.removedValue;
      steps.push(step);
    }
  }
  return { status: 'applied', steps, finalDocument: doc, failure: null };
}

/* ----------------------------- leaf difference ---------------------------- */

const MISSING = Symbol('missing');

function childKeys(node) {
  return Array.isArray(node) ? node.map((_, i) => String(i)) : Object.keys(node);
}

function pointerCompare(p1, p2) {
  if (p1 === p2) return 0;
  return p1 < p2 ? -1 : 1; // UTF-16 code unit order
}

/**
 * Recursively compare two values and return the leaf difference whose RFC 6901
 * pointer is lexicographically smallest. A present-vs-absent member (or a
 * container-vs-non-container type change) is itself the leaf: its value is the
 * whole subtree on the existing side.
 */
export function firstDifference(a, b) {
  const visit = (segments, av, bv) => {
    if (deepEqual(av, bv)) return null;
    const bothArrays = Array.isArray(av) && Array.isArray(bv);
    const bothObjects =
      isContainer(av) &&
      isContainer(bv) &&
      !Array.isArray(av) &&
      !Array.isArray(bv);
    if (bothArrays || bothObjects) {
      let best = null;
      for (const key of new Set([...childKeys(av), ...childKeys(bv)])) {
        const aHas = Object.prototype.hasOwnProperty.call(av, key);
        const bHas = Object.prototype.hasOwnProperty.call(bv, key);
        const diff = visit(
          [...segments, key],
          aHas ? av[key] : MISSING,
          bHas ? bv[key] : MISSING,
        );
        if (diff && (best === null || pointerCompare(diff.path, best.path) < 0)) {
          best = diff;
        }
      }
      return best;
    }
    return {
      path: formatPointer(segments),
      aExists: av !== MISSING,
      aValue: av === MISSING ? null : av,
      bExists: bv !== MISSING,
      bValue: bv === MISSING ? null : bv,
    };
  };
  return visit([], a, b);
}

/* --------------------------------- entry --------------------------------- */

export function auditOrdering({ base, patchA, patchB }) {
  const orderAB = replayOrder(base, patchA, patchB, 'A->B');
  const orderBA = replayOrder(base, patchA, patchB, 'B->A');

  let verdict;
  let difference = null;
  if (orderAB.status === 'failed' || orderBA.status === 'failed') {
    verdict = AUDIT_VERDICTS.FAILED;
  } else if (deepEqual(orderAB.finalDocument, orderBA.finalDocument)) {
    verdict = AUDIT_VERDICTS.COMMUTATIVE;
  } else {
    verdict = AUDIT_VERDICTS.DIVERGENT;
    difference = firstDifference(orderAB.finalDocument, orderBA.finalDocument);
  }

  return {
    verdict,
    base: structuredClone(base),
    orders: {
      'A->B': orderAB,
      'B->A': orderBA,
    },
    firstDifference: difference,
  };
}
