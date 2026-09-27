/**
 * Path-ownership preview for a stored merge record.
 *
 * The client submits a set of ownership rules, each assigning a unique
 * RFC 6901 prefix to one side:
 *
 *   { "prefix": "/features", "owner": "A" }
 *
 * A rule makes every path at or under `prefix` the territory of `owner`
 * ("A" or "B"). More specific rules override broader ones: the owner of a
 * path is the owner of the LONGEST rule prefix that matches it. A path no
 * rule covers is a violation by itself ("uncovered-path").
 *
 * Every ORIGINAL operation of the saved patchA / patchB is checked in turn
 * (original indices, base coordinates — the same normalization the merge
 * engine applies, but without intra-patch last-wins dropping):
 *
 *   - ownership: the operation's path must belong to its own side. For an
 *     array `add` the insertion position belongs to the PARENT ARRAY, so
 *     the parent path is matched instead of the full path.
 *   - descendant guard: a subtree write — `replace`, `remove`, or an `add`
 *     that overwrites an existing object member — must not clobber territory
 *     of the other side: if any rule strictly UNDER the target path belongs
 *     to the other side, the write is a violation
 *     ("descendant-owned-by-other"). This prevents a parent-level write
 *     from bypassing the protection of a nested path.
 *
 * The preview reports `publishable` (true when no violation was found) and
 * one entry per violation: the operation's side, original index, op and
 * path, the rule that was hit (null for uncovered paths) and the reason.
 * Violations are emitted in processing order — patchA operations by index,
 * then patchB; per operation the ownership verdict first, then descendant
 * hits in rule request order — so identical requests serialize identically.
 *
 * The preview is a pure function of the stored record and the submitted
 * rules: the record is never modified, and any record status (clean or
 * conflict) can be checked, since only the saved patches are inspected.
 */

import { normalizePatch, formatPointer } from './merge.js';
import { parseRulePointer } from './constraint.js';

export const OWNERSHIP_CODES = Object.freeze({
  INVALID_RULES: 'INVALID_RULES',
});

export const OWNERSHIP_REASONS = Object.freeze({
  UNCOVERED_PATH: 'uncovered-path',
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

function prefixIssue(prefix) {
  return typeof prefix === 'string'
    ? `"prefix" is not a valid JSON Pointer: "${prefix}"`
    : '"prefix" must be a JSON Pointer string ("" or starting with "/")';
}

/**
 * Validate the submitted rules and return them normalized as
 * { prefix, owner, tokens } in request order (`prefix` is the canonical
 * RFC 6901 form of the submitted pointer). Every problem is collected (one
 * entry per offending rule, in request order) and reported by throwing
 * OwnershipError(INVALID_RULES).
 */
export function validateOwnershipRules(rules) {
  const invalid = [];
  const normalized = [];
  const seen = new Map(); // canonical prefix -> index of its first occurrence
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
      issues.push(prefixIssue(rule.prefix));
    } else {
      const canonical = formatPointer(tokens);
      if (seen.has(canonical)) {
        issues.push(
          `duplicate rule prefix "${canonical}" (first used at index ${seen.get(canonical)})`,
        );
      } else {
        seen.set(canonical, index);
      }
    }
    if (rule.owner !== 'A' && rule.owner !== 'B') {
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
    normalized.push({ prefix: formatPointer(tokens), owner: rule.owner, tokens });
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

/** Is `a` a (non-strict) prefix of `b`? */
function isPrefix(a, b) {
  if (a.length > b.length) return false;
  return a.every((s, i) => s === b[i]);
}

/** The longest rule covering `tokens`, or null when no rule covers them. */
function longestMatch(rules, tokens) {
  let best = null;
  for (const rule of rules) {
    if (best && rule.tokens.length <= best.tokens.length) continue;
    if (isPrefix(rule.tokens, tokens)) best = rule;
  }
  return best;
}

function ruleRef(rule) {
  return { prefix: rule.prefix, owner: rule.owner };
}

/**
 * Check one normalized original operation against the rule set, appending
 * every violation found. `raw` is the original operation as submitted (its
 * op/path are reported verbatim, alongside the original index).
 */
function checkOperation(op, raw, rules, violations) {
  const base = { side: op.side, index: op.index, op: raw.op, path: raw.path };
  // An array insertion occupies a gap of the parent array: the position is
  // owned by the parent, not by any element-indexed rule.
  const ownershipTokens = op.arrayInsert ? op.segments.slice(0, -1) : op.segments;
  const owner = longestMatch(rules, ownershipTokens);
  if (!owner) {
    violations.push({ ...base, rule: null, reason: OWNERSHIP_REASONS.UNCOVERED_PATH });
  } else if (owner.owner !== op.side) {
    violations.push({
      ...base,
      rule: ruleRef(owner),
      reason: OWNERSHIP_REASONS.OWNED_BY_OTHER,
    });
  }
  // Subtree writes (replace / remove / add overwriting an existing object
  // member — normalized to replace) must not clobber other-side territory
  // nested under the target.
  if (op.op === 'replace' || op.op === 'remove') {
    for (const rule of rules) {
      if (rule.owner === op.side) continue;
      if (rule.tokens.length > op.segments.length && isPrefix(op.segments, rule.tokens)) {
        violations.push({
          ...base,
          rule: ruleRef(rule),
          reason: OWNERSHIP_REASONS.DESCENDANT_OWNED_BY_OTHER,
        });
      }
    }
  }
}

/**
 * Check every original operation of the record's patchA / patchB against
 * the ownership rules. `rules` must already be normalized by
 * validateOwnershipRules. Returns { publishable, violations, summary }.
 */
export function previewOwnership(record, rules) {
  const violations = [];
  for (const side of ['A', 'B']) {
    const patch = side === 'A' ? record.patchA : record.patchB;
    // The saved patches were validated against the saved base when the
    // record was created, so normalization cannot fail here.
    const ops = normalizePatch(record.base, patch, side);
    ops.forEach((op, i) => checkOperation(op, patch[i], rules, violations));
  }

  const summary = {
    total: violations.length,
    bySide: { A: 0, B: 0 },
    byReason: {
      [OWNERSHIP_REASONS.UNCOVERED_PATH]: 0,
      [OWNERSHIP_REASONS.OWNED_BY_OTHER]: 0,
      [OWNERSHIP_REASONS.DESCENDANT_OWNED_BY_OTHER]: 0,
    },
  };
  for (const violation of violations) {
    summary.bySide[violation.side] += 1;
    summary.byReason[violation.reason] += 1;
  }

  return { publishable: violations.length === 0, violations, summary };
}
