/**
 * Path-ownership preview for a stored merge record.
 *
 * The client submits ownership rules, each mapping a unique RFC 6901 prefix
 * to the side that owns that subtree:
 *
 *   { "prefix": "/features", "owner": "A" }
 *
 * Every ORIGINAL operation of the saved patchA / patchB is then checked in
 * base coordinates (the same normalization the merge engine uses):
 *
 *   - the operation's target path is attributed to the LONGEST rule prefix
 *     that contains it; a path no rule covers is a violation
 *     ("uncovered-path"), and so is a path whose longest-prefix rule belongs
 *     to the other side ("owned-by-other");
 *   - an array `add` inserts into a gap of the PARENT array, so the
 *     insertion position is attributed to the parent array's path, not to
 *     the (not yet existing) element path;
 *   - a `replace` / `remove` — including an `add` that overwrites an
 *     existing object member (normalized to `replace` by the merge engine) —
 *     rewrites or deletes the whole subtree below its target, so every rule
 *     nested UNDER the target that belongs to the other side is also a
 *     violation ("descendant-owned-by-other"); this stops a parent-level
 *     write from silently bypassing the protection of nested territory. A
 *     pure `add` of a previously missing object member does not trigger the
 *     descendant check.
 *
 * The response carries a `publishable` boolean (true iff there are no
 * violations) and one entry per violation with the offending operation's
 * side, original index, op, base-coordinate path, the matched rule (null
 * for uncovered paths) and the reason.
 *
 * The preview is a pure function of the stored record and the submitted
 * rules: the record is never modified and repeated identical requests
 * produce identical responses. Records of any status can be previewed —
 * only the saved base / patchA / patchB are consulted, never `merged`.
 */

import { normalizePatch, formatPointer } from './merge.js';
import { parseRulePointer } from './constraint.js';

export const OWNERSHIP_CODES = Object.freeze({
  INVALID_RULES: 'INVALID_RULES',
});

export const OWNERSHIP_REASONS = Object.freeze({
  UNCOVERED: 'uncovered-path',
  OWNED_BY_OTHER: 'owned-by-other',
  DESCENDANT_OWNED_BY_OTHER: 'descendant-owned-by-other',
});

export class OwnershipError extends Error {
  constructor(message, { code, ...details } = {}) {
    super(message);
    this.name = 'OwnershipError';
    this.code = code;
    this.details = details;
  }
}

/* ---------------------------- rule validation ---------------------------- */

const RULE_KEYS = ['prefix', 'owner'];
const OWNERS = ['A', 'B'];

/**
 * Validate the submitted rules and return them normalized as
 * { prefix, owner, tokens } in request order. Every problem is collected
 * (one entry per offending rule, in request order) and reported by throwing
 * OwnershipError(INVALID_RULES).
 */
export function validateOwnershipRules(rules) {
  const invalid = [];
  const normalized = [];
  const seen = new Map(); // rule prefix -> index of its first occurrence
  rules.forEach((rule, index) => {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      invalid.push({ index, prefix: null, issues: ['rule must be an object'] });
      return;
    }
    const issues = [];
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.includes(key)) issues.push(`unknown property "${key}"`);
    }
    const tokens = parseRulePointer(rule.prefix);
    if (tokens === null) {
      issues.push(
        typeof rule.prefix === 'string'
          ? `"prefix" is not a valid JSON Pointer: "${rule.prefix}"`
          : '"prefix" must be a JSON Pointer string ("" or starting with "/")',
      );
    } else if (seen.has(rule.prefix)) {
      issues.push(
        `duplicate rule prefix "${rule.prefix}" (first used at index ${seen.get(rule.prefix)})`,
      );
    } else {
      seen.set(rule.prefix, index);
    }
    if (!OWNERS.includes(rule.owner)) {
      issues.push('"owner" must be "A" or "B"');
    }
    if (issues.length) {
      invalid.push({
        index,
        prefix: typeof rule.prefix === 'string' ? rule.prefix : null,
        issues,
      });
      return;
    }
    normalized.push({ prefix: rule.prefix, owner: rule.owner, tokens });
  });
  if (invalid.length) {
    throw new OwnershipError(`${invalid.length} of ${rules.length} rule(s) are invalid`, {
      code: OWNERSHIP_CODES.INVALID_RULES,
      invalid,
    });
  }
  return normalized;
}

/* ------------------------------- evaluation ------------------------------ */

function isPrefixTokens(prefix, tokens) {
  if (prefix.length > tokens.length) return false;
  return prefix.every((seg, i) => seg === tokens[i]);
}

function isStrictPrefixTokens(prefix, tokens) {
  return prefix.length < tokens.length && isPrefixTokens(prefix, tokens);
}

/** Longest rule whose tokens prefix the given path tokens, or null. */
function longestMatch(rules, tokens) {
  let best = null;
  for (const rule of rules) {
    if (!isPrefixTokens(rule.tokens, tokens)) continue;
    if (!best || rule.tokens.length > best.tokens.length) best = rule;
  }
  return best;
}

function ruleRef(rule) {
  return { prefix: rule.prefix, owner: rule.owner };
}

function pointerCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1; // UTF-16 code-unit order, locale-independent
}

/**
 * Check one normalized operation against the rules and push its violations.
 * `rawOp` is the original patch entry; its `op` is reported verbatim (an
 * `add` that overwrites an existing object member is normalized to
 * `replace` internally, but the violation names the submitted operation).
 */
function checkOperation(op, rawOp, rules, violations) {
  const target = op.segments;
  const base = { side: op.side, index: op.index, op: rawOp.op, path: formatPointer(target) };
  // An array insertion addresses a gap of the parent array: ownership of
  // the insertion position is decided by the parent array's path.
  const attributed = op.arrayInsert ? target.slice(0, -1) : target;
  const matched = longestMatch(rules, attributed);
  if (!matched) {
    violations.push({ ...base, reason: OWNERSHIP_REASONS.UNCOVERED, rule: null });
  } else if (matched.owner !== op.side) {
    violations.push({
      ...base,
      reason: OWNERSHIP_REASONS.OWNED_BY_OTHER,
      rule: ruleRef(matched),
    });
  }
  // A replace/remove rewrites or deletes the whole subtree below its target
  // (an add on an existing object member is normalized to replace). Rules
  // nested under the target that belong to the other side would be silently
  // overridden — flag each of them, sorted by prefix for determinism.
  if (!op.arrayInsert && (op.op === 'replace' || op.op === 'remove')) {
    const descendants = rules
      .filter((rule) => rule.owner !== op.side && isStrictPrefixTokens(target, rule.tokens))
      .sort((x, y) => pointerCompare(x.prefix, y.prefix));
    for (const rule of descendants) {
      violations.push({
        ...base,
        reason: OWNERSHIP_REASONS.DESCENDANT_OWNED_BY_OTHER,
        rule: ruleRef(rule),
      });
    }
  }
}

/**
 * Check every original operation of the record's patchA / patchB against
 * the ownership rules. `rules` must already be normalized by
 * validateOwnershipRules. Returns { publishable, violations, summary } with
 * violations in check order (A's operations by original index, then B's;
 * descendant-rule violations of one operation sorted by rule prefix).
 */
export function previewOwnership(record, rules) {
  const violations = [];
  for (const side of ['A', 'B']) {
    const patch = side === 'A' ? record.patchA : record.patchB;
    // The record was validated when stored, so normalization cannot fail.
    // Every original operation is checked, including ones the merge engine
    // would later drop (intra-patch last-wins losers, equal-value
    // duplicates): the preview guards what each side SUBMITTED.
    const ops = normalizePatch(record.base, patch, side);
    for (const op of ops) checkOperation(op, patch[op.index], rules, violations);
  }

  const summary = {
    operations: {
      A: record.patchA.length,
      B: record.patchB.length,
      total: record.patchA.length + record.patchB.length,
    },
    violations: violations.length,
    byReason: {
      [OWNERSHIP_REASONS.UNCOVERED]: 0,
      [OWNERSHIP_REASONS.OWNED_BY_OTHER]: 0,
      [OWNERSHIP_REASONS.DESCENDANT_OWNED_BY_OTHER]: 0,
    },
    bySide: { A: 0, B: 0 },
  };
  for (const violation of violations) {
    summary.byReason[violation.reason] += 1;
    summary.bySide[violation.side] += 1;
  }

  return { publishable: violations.length === 0, violations, summary };
}
