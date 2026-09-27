/**
 * Deterministic three-way rehearsal merge engine.
 *
 * Model: both patches (A and B) are expressed against the SAME base document
 * (base coordinates). Array elements are identified by their index in the base
 * array; insertions address the "gap" before a base element. When both patches
 * insert into the same gap, A's values are placed before B's. Index drift
 * caused by adds/removes is resolved by rebuilding arrays from base identities.
 */

export const REASONS = Object.freeze({
  DELETE_VS_MODIFY: 'delete-vs-modify',
  REPLACE_MISMATCH: 'replace-mismatch',
  ADD_MISMATCH: 'add-mismatch',
  REPLACE_OVERLAP: 'replace-overlap',
});

const REASON_MESSAGES = Object.freeze({
  [REASONS.DELETE_VS_MODIFY]: 'one patch deletes this element while the other modifies it',
  [REASONS.REPLACE_MISMATCH]: 'both patches replace the same target with different values',
  [REASONS.ADD_MISMATCH]: 'both patches add the same object member with different values',
  [REASONS.REPLACE_OVERLAP]: 'one patch replaces a subtree that the other patch modifies inside',
});

export class PatchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PatchError';
    this.code = 'INVALID_PATCH';
    this.details = details;
  }
}

/* ------------------------------ JSON Pointer ----------------------------- */

export function parsePointer(pointer) {
  if (typeof pointer !== 'string') {
    throw new PatchError('path must be a string');
  }
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new PatchError(`invalid JSON Pointer "${pointer}": must be "" or start with "/"`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function formatPointer(segments) {
  if (!segments.length) return '';
  return (
    '/' +
    segments
      .map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1'))
      .join('/')
  );
}

/* --------------------------------- helpers ------------------------------- */

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function parseIndex(seg) {
  if (!/^\d+$/.test(seg)) return null;
  const n = Number(seg);
  return Number.isSafeInteger(n) ? n : null;
}

function isStrictPrefix(a, b) {
  if (a.length >= b.length) return false;
  return a.every((s, i) => s === b[i]);
}

/* ----------------------------- normalization ----------------------------- */

/**
 * Resolve a parsed path against the base document, returning canonical
 * segments (array indices normalized to decimal strings, "-" resolved).
 */
function resolveTarget(base, segments, op, ctx) {
  const canon = [];
  let node = base;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    const at = formatPointer(canon) || '(root)';
    if (Array.isArray(node)) {
      if (seg === '-') {
        if (!last || op !== 'add') {
          throw new PatchError(
            `operation ${ctx.side}[${ctx.index}]: "-" is only allowed as the last segment of an add`,
            ctx,
          );
        }
        canon.push(String(node.length));
        return { segments: canon, parentType: 'array', exists: false };
      }
      const idx = parseIndex(seg);
      if (idx === null) {
        throw new PatchError(
          `operation ${ctx.side}[${ctx.index}]: "${seg}" is not a valid array index at ${at}`,
          ctx,
        );
      }
      canon.push(String(idx));
      if (last) {
        if (op === 'add') {
          if (idx > node.length) {
            throw new PatchError(
              `operation ${ctx.side}[${ctx.index}]: add index ${idx} out of bounds (array length ${node.length})`,
              ctx,
            );
          }
          return { segments: canon, parentType: 'array', exists: false };
        }
        if (idx >= node.length) {
          throw new PatchError(
            `operation ${ctx.side}[${ctx.index}]: index ${idx} out of bounds (array length ${node.length})`,
            ctx,
          );
        }
        return { segments: canon, parentType: 'array', exists: true };
      }
      if (idx >= node.length) {
        throw new PatchError(
          `operation ${ctx.side}[${ctx.index}]: index ${idx} out of bounds (array length ${node.length})`,
          ctx,
        );
      }
      node = node[idx];
    } else if (node !== null && typeof node === 'object') {
      canon.push(seg);
      const has = Object.prototype.hasOwnProperty.call(node, seg);
      if (last) {
        if (op !== 'add' && !has) {
          throw new PatchError(
            `operation ${ctx.side}[${ctx.index}]: path does not exist: ${formatPointer(canon)}`,
            ctx,
          );
        }
        return { segments: canon, parentType: 'object', exists: has };
      }
      if (!has) {
        throw new PatchError(
          `operation ${ctx.side}[${ctx.index}]: path does not exist: ${formatPointer(canon)}`,
          ctx,
        );
      }
      node = node[seg];
    } else {
      throw new PatchError(
        `operation ${ctx.side}[${ctx.index}]: cannot traverse into ${node === null ? 'null' : typeof node} at ${at}`,
        ctx,
      );
    }
  }
  return { segments: canon, parentType: 'root', exists: true };
}

const SUPPORTED_OPS = new Set(['add', 'remove', 'replace']);

/**
 * Validate and normalize a raw patch against the base document, one
 * normalized operation per original operation (same index): canonical
 * base-coordinate segments, `add` on an existing object member normalized
 * to `replace`, array insertions flagged. Exported for read-only previews
 * (e.g. ownership) that inspect every original operation individually.
 */
export function normalizePatch(base, patch, side) {
  return patch.map((raw, index) => {
    const ctx = { side, index };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PatchError(`operation ${side}[${index}] must be an object`, ctx);
    }
    const { op, path } = raw;
    if (!SUPPORTED_OPS.has(op)) {
      throw new PatchError(
        `operation ${side}[${index}]: unsupported op "${op}" (only add, remove, replace are accepted)`,
        ctx,
      );
    }
    if (typeof path !== 'string') {
      throw new PatchError(`operation ${side}[${index}]: "path" must be a string`, ctx);
    }
    if ((op === 'add' || op === 'replace') && !('value' in raw)) {
      throw new PatchError(`operation ${side}[${index}] (${op}) requires a "value" member`, ctx);
    }
    let segments;
    try {
      segments = parsePointer(path);
    } catch (err) {
      throw new PatchError(`operation ${side}[${index}]: ${err.message}`, ctx);
    }
    if (segments.length === 0 && op === 'remove') {
      throw new PatchError(
        `operation ${side}[${index}]: removing the document root is not supported`,
        ctx,
      );
    }
    const target = resolveTarget(base, segments, op, ctx);
    let normOp = op;
    let arrayInsert = false;
    if (op === 'add') {
      if (target.parentType === 'array') {
        arrayInsert = true;
      } else if (target.exists) {
        // RFC 6902: add on an existing object member replaces it.
        normOp = 'replace';
      }
    }
    return {
      id: `${side}#${index}`,
      side,
      index,
      op: normOp,
      segments: target.segments,
      value: raw.value,
      arrayInsert,
    };
  });
}

/**
 * Intra-patch resolution (base coordinates):
 *  - an op whose path is a strict descendant of another op's add/remove/replace
 *    target in the SAME patch is rejected (array insertions are transparent);
 *  - duplicate non-insertion targets: last op wins; array insertions accumulate.
 */
function resolveIntraPatch(ops, side) {
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].arrayInsert) continue;
    for (let j = 0; j < ops.length; j++) {
      if (i === j) continue;
      if (isStrictPrefix(ops[i].segments, ops[j].segments)) {
        throw new PatchError(
          `operation ${side}[${ops[j].index}] targets a path inside ${side}[${ops[i].index}] ` +
            `("${formatPointer(ops[i].segments)}"): nested operations under an add/remove/replace ` +
            'of an ancestor are not supported within one patch',
          { side, index: ops[j].index, ancestorIndex: ops[i].index },
        );
      }
    }
  }
  const byPath = new Map();
  const out = [];
  for (const op of ops) {
    if (op.arrayInsert) {
      out.push(op);
      continue;
    }
    const key = formatPointer(op.segments);
    const prev = byPath.get(key);
    if (prev) {
      const at = out.indexOf(prev);
      if (at !== -1) out.splice(at, 1);
    }
    byPath.set(key, op);
    out.push(op);
  }
  return out;
}

/* --------------------------- cross-patch conflicts ------------------------ */

function relate(a, b) {
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    if (a[i] !== b[i]) return 'none';
  }
  if (a.length === b.length) return 'equal';
  return a.length < b.length ? 'ancestor' : 'descendant';
}

function opRef(o) {
  const ref = { side: o.side, index: o.index, op: o.op, path: formatPointer(o.segments) };
  if (o.op !== 'remove') ref.value = o.value;
  return ref;
}

function makeConflict(reason, a, b, anchor) {
  const at = anchor || a;
  return {
    reason,
    path: formatPointer(at.segments),
    operations: [opRef(a), opRef(b)],
    message: `${REASON_MESSAGES[reason]} (${a.side}#${a.index} vs ${b.side}#${b.index})`,
  };
}

function detectCrossConflicts(opsA, opsB) {
  const conflicts = [];
  const dropped = new Set(); // deduplicated / shadowed op ids
  // Equal-value writes: dropped op id -> id of the surviving op it
  // duplicates. Recorded so downstream consumers (e.g. provenance) can
  // attribute the leaf to BOTH sides. remove/remove and shadowed descendant
  // removes are not recorded: their target is absent from the merged
  // document, so there is nothing to attribute.
  const duplicates = new Map();
  for (const a of opsA) {
    if (dropped.has(a.id)) continue;
    for (const b of opsB) {
      if (dropped.has(b.id)) continue;
      const rel = relate(a.segments, b.segments);
      if (rel === 'none') continue;

      if (rel === 'equal') {
        // Array insertions into the same gap coexist (A before B) and never
        // clash with element ops at the same index.
        if (a.arrayInsert || b.arrayInsert) continue;
        if (a.op === 'remove' && b.op === 'remove') {
          dropped.add(b.id); // identical delete: apply once
          continue;
        }
        if (a.op === 'remove' || b.op === 'remove') {
          conflicts.push(makeConflict(REASONS.DELETE_VS_MODIFY, a, b));
          continue;
        }
        if (a.op === 'replace' && b.op === 'replace') {
          if (deepEqual(a.value, b.value)) {
            dropped.add(b.id);
            duplicates.set(b.id, a.id);
          } else conflicts.push(makeConflict(REASONS.REPLACE_MISMATCH, a, b));
          continue;
        }
        // Both create the same (previously missing) object member.
        if (deepEqual(a.value, b.value)) {
          dropped.add(b.id);
          duplicates.set(b.id, a.id);
        } else conflicts.push(makeConflict(REASONS.ADD_MISMATCH, a, b));
        continue;
      }

      const anc = rel === 'ancestor' ? a : b;
      const desc = rel === 'ancestor' ? b : a;
      if (anc.arrayInsert) continue; // inserting before an element does not touch its subtree
      if (anc.op === 'remove') {
        if (desc.op === 'remove') {
          dropped.add(desc.id); // descendant delete is covered by the ancestor delete
          continue;
        }
        conflicts.push(makeConflict(REASONS.DELETE_VS_MODIFY, a, b, anc));
        continue;
      }
      // anc is a replace (or object create) rewriting the whole subtree.
      conflicts.push(makeConflict(REASONS.REPLACE_OVERLAP, a, b, anc));
    }
  }
  return { conflicts, dropped, duplicates };
}

/* ------------------------------- application ------------------------------ */

function applyNode(node, ops) {
  if (Array.isArray(node)) return applyArray(node, ops);
  if (node !== null && typeof node === 'object') return applyObject(node, ops);
  return node;
}

function applyObject(obj, ops) {
  const groups = new Map();
  for (const op of ops) {
    const key = op.segments[0];
    let g = groups.get(key);
    if (!g) {
      g = { here: [], deeper: [] };
      groups.set(key, g);
    }
    if (op.segments.length === 1) g.here.push(op);
    else g.deeper.push({ ...op, segments: op.segments.slice(1) });
  }
  for (const [key, g] of groups) {
    if (g.here.length) {
      const op = g.here[g.here.length - 1];
      if (op.op === 'remove') {
        delete obj[key];
        continue;
      }
      obj[key] = structuredClone(op.value);
      continue;
    }
    obj[key] = applyNode(obj[key], g.deeper);
  }
  return obj;
}

function applyArray(arr, ops) {
  const groups = new Map(); // base index -> { adds, remove, replace, deeper }
  for (const op of ops) {
    const idx = Number(op.segments[0]);
    let g = groups.get(idx);
    if (!g) {
      g = { adds: [], remove: null, replace: null, deeper: [] };
      groups.set(idx, g);
    }
    if (op.segments.length === 1) {
      if (op.arrayInsert) g.adds.push(op); // keeps [A..., B...] encounter order
      else if (op.op === 'remove') g.remove = op;
      else g.replace = op;
    } else {
      g.deeper.push({ ...op, segments: op.segments.slice(1) });
    }
  }
  const out = [];
  for (let i = 0; i <= arr.length; i++) {
    const g = groups.get(i);
    if (g) for (const add of g.adds) out.push(structuredClone(add.value));
    if (i === arr.length) break;
    if (g && g.remove) continue;
    if (g && g.replace) {
      out.push(structuredClone(g.replace.value));
      continue;
    }
    let el = arr[i];
    if (g && g.deeper.length) el = applyNode(el, g.deeper);
    out.push(el);
  }
  return out;
}

export function applyMerge(base, ops) {
  const rootOps = ops.filter((o) => o.segments.length === 0);
  const treeOps = ops.filter((o) => o.segments.length > 0);
  let doc = structuredClone(base);
  for (const op of rootOps) doc = structuredClone(op.value); // only replace reaches the root
  if (treeOps.length) doc = applyNode(doc, treeOps);
  return doc;
}

/* --------------------------------- entry --------------------------------- */

/**
 * Full merge pipeline up to (but excluding) application: normalize both
 * patches against the base, resolve intra-patch duplicates, detect
 * cross-patch conflicts. Returns the normalized operations, the conflicts,
 * the dropped-op bookkeeping and the surviving operations in application
 * order ([A..., B...]). `duplicates` maps a dropped op id to the surviving
 * op it duplicates (equal-value writes only).
 */
export function planMerge(base, patchA, patchB) {
  const opsA = resolveIntraPatch(normalizePatch(base, patchA, 'A'), 'A');
  const opsB = resolveIntraPatch(normalizePatch(base, patchB, 'B'), 'B');
  const { conflicts, dropped, duplicates } = detectCrossConflicts(opsA, opsB);
  const surviving = [...opsA, ...opsB].filter((o) => !dropped.has(o.id));
  return { opsA, opsB, conflicts, dropped, duplicates, surviving };
}

export function mergePatches(base, patchA, patchB) {
  const { opsA, opsB, conflicts, dropped, surviving } = planMerge(base, patchA, patchB);
  conflicts.sort(
    (x, y) => x.path.localeCompare(y.path) || x.reason.localeCompare(y.reason),
  );
  const stats = {
    received: { A: patchA.length, B: patchB.length },
    normalized: { A: opsA.length, B: opsB.length },
    deduplicated: dropped.size,
    conflicts: conflicts.length,
    applied: 0,
  };
  if (conflicts.length) {
    return { status: 'conflict', merged: null, conflicts, stats };
  }
  stats.applied = surviving.length;
  const merged = applyMerge(base, surviving);
  return { status: 'clean', merged, conflicts: [], stats };
}
