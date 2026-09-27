/**
 * Conditional constraint preview for a clean merge record.
 *
 * The client submits a set of rules, each with a unique id:
 *
 *   { "id": "tracing-needs-audit",
 *     "when": "/features/tracing",   // JSON Pointer (RFC 6901)
 *     "equals": true,                // any JSON value, compared deep-equal
 *     "require": "/features/audit" } // JSON Pointer that must then exist
 *
 * A rule PASSES on a document when
 *
 *   - the `when` pointer does not exist, or
 *   - the value at `when` is not deeply equal to `equals`, or
 *   - the `require` pointer exists (a present null counts as existing).
 *
 * Otherwise — `when` exists, matches `equals`, and `require` is missing —
 * the rule is VIOLATED on that document.
 *
 * Every rule is evaluated on four states of the stored rehearsal:
 *
 *   - "base":   the saved base document;
 *   - "A":      base + patchA alone — computed with the same base-coordinate
 *               merge semantics as the stored merge (mergePatches with an
 *               empty opposite patch), so array indices identify base
 *               elements and drift is relocated exactly as in the merge;
 *   - "B":      base + patchB alone, same semantics;
 *   - "merged": the saved merged document.
 *
 * A rule violated in the merged state is classified by where the violation
 * came from (`violation.labels`):
 *
 *   - "preexisting":      already violated on the base document (regardless
 *                         of what either side does);
 *   - "introduced-by-A":  clean base, violated by A's changes alone;
 *   - "introduced-by-B":  clean base, violated by B's changes alone;
 *   - "combination-only": clean on base and on both single sides; only the
 *                         combination of A and B violates the rule.
 *
 * When both sides violate the rule independently, BOTH "introduced-by-A" and
 * "introduced-by-B" are listed. A preexisting violation is reported as
 * "preexisting" alone — it was not introduced by this merge.
 *
 * The preview is a pure function of the stored record and the submitted
 * rules: the record is never modified and repeated identical requests
 * produce identical responses.
 */

import { deepEqual, mergePatches } from './merge.js';

export const CONSTRAINT_CODES = Object.freeze({
  INVALID_RULES: 'INVALID_RULES',
});

export const VIOLATION_LABELS = Object.freeze({
  PREEXISTING: 'preexisting',
  INTRODUCED_BY_A: 'introduced-by-A',
  INTRODUCED_BY_B: 'introduced-by-B',
  COMBINATION_ONLY: 'combination-only',
});

export class ConstraintError extends Error {
  constructor(message, { code, ...details } = {}) {
    super(message);
    this.name = 'ConstraintError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------ JSON Pointer ----------------------------- */

/**
 * Strict RFC 6901 parser for rule pointers: "" or "/"-separated reference
 * tokens with "~0"/"~1" escapes; a "~" not followed by 0 or 1 is malformed.
 * Returns the reference tokens, or null when the pointer is malformed.
 */
export function parseRulePointer(pointer) {
  if (typeof pointer !== 'string') return null;
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return null;
  const tokens = pointer.slice(1).split('/');
  for (const token of tokens) {
    if (/~(?!0|1)/.test(token)) return null;
  }
  return tokens.map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * RFC 6901 lookup: resolves tokens against the document and returns
 * { exists, value }. Any unresolvable step — a missing object member, an
 * array token that is not a canonical in-range index ("-" and leading zeros
 * never resolve), or traversal into a scalar — yields
 * { exists: false, value: null }.
 */
function lookup(document, tokens) {
  let node = document;
  for (const token of tokens) {
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { exists: false, value: null };
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= node.length) {
        return { exists: false, value: null };
      }
      node = node[index];
    } else if (node !== null && typeof node === 'object') {
      if (!Object.prototype.hasOwnProperty.call(node, token)) {
        return { exists: false, value: null };
      }
      node = node[token];
    } else {
      return { exists: false, value: null };
    }
  }
  return { exists: true, value: node };
}

/* ---------------------------- rule validation ---------------------------- */

const RULE_KEYS = ['id', 'when', 'equals', 'require'];

function pointerIssue(field, pointer) {
  return typeof pointer === 'string'
    ? `"${field}" is not a valid JSON Pointer: "${pointer}"`
    : `"${field}" must be a JSON Pointer string ("" or starting with "/")`;
}

/**
 * Validate the submitted rules and return them normalized as
 * { id, when, equals, require, whenTokens, requireTokens } in request order.
 * Every problem is collected (one entry per offending rule, in request
 * order) and reported by throwing ConstraintError(INVALID_RULES).
 */
export function validateRules(rules) {
  const invalid = [];
  const normalized = [];
  const seen = new Map(); // rule id -> index of its first occurrence
  rules.forEach((rule, index) => {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      invalid.push({ index, id: null, issues: ['rule must be an object'] });
      return;
    }
    const issues = [];
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.includes(key)) issues.push(`unknown property "${key}"`);
    }
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      issues.push('"id" must be a non-empty string');
    } else if (seen.has(rule.id)) {
      issues.push(`duplicate rule id "${rule.id}" (first used at index ${seen.get(rule.id)})`);
    } else {
      seen.set(rule.id, index);
    }
    const whenTokens = parseRulePointer(rule.when);
    if (whenTokens === null) issues.push(pointerIssue('when', rule.when));
    if (!('equals' in rule)) {
      issues.push('"equals" is required (any JSON value, including null)');
    }
    const requireTokens = parseRulePointer(rule.require);
    if (requireTokens === null) issues.push(pointerIssue('require', rule.require));
    if (issues.length) {
      invalid.push({ index, id: typeof rule.id === 'string' ? rule.id : null, issues });
      return;
    }
    normalized.push({
      id: rule.id,
      when: rule.when,
      equals: rule.equals,
      require: rule.require,
      whenTokens,
      requireTokens,
    });
  });
  if (invalid.length) {
    throw new ConstraintError(`${invalid.length} of ${rules.length} rule(s) are invalid`, {
      code: CONSTRAINT_CODES.INVALID_RULES,
      invalid,
    });
  }
  return normalized;
}

/* ------------------------------- evaluation ------------------------------ */

/**
 * Evaluate one normalized rule on one document. Returns
 * { pass, triggered, whenExists, whenValue, requireExists } where
 * `triggered` means the `when` pointer exists AND matches `equals`
 * (whenValue is null when the pointer does not exist).
 */
function evaluateRule(rule, document) {
  const when = lookup(document, rule.whenTokens);
  const triggered = when.exists && deepEqual(when.value, rule.equals);
  const required = lookup(document, rule.requireTokens);
  return {
    pass: !triggered || required.exists,
    triggered,
    whenExists: when.exists,
    whenValue: when.exists ? when.value : null,
    requireExists: required.exists,
  };
}

/**
 * Classify a rule violated in the merged state by where the violation came
 * from. `states` maps state name -> evaluation result. Returns the label
 * array described in the module header.
 */
function classify(states) {
  if (!states.base.pass) return [VIOLATION_LABELS.PREEXISTING];
  const labels = [];
  if (!states.A.pass) labels.push(VIOLATION_LABELS.INTRODUCED_BY_A);
  if (!states.B.pass) labels.push(VIOLATION_LABELS.INTRODUCED_BY_B);
  if (labels.length) return labels;
  return [VIOLATION_LABELS.COMBINATION_ONLY];
}

/** Summary bucket (non-overlapping) for a merged-violation label array. */
function mergedViolationKind(labels) {
  if (labels.includes(VIOLATION_LABELS.PREEXISTING)) return 'preexisting';
  if (labels.length === 2) return 'introducedByBoth';
  if (labels[0] === VIOLATION_LABELS.INTRODUCED_BY_A) return 'introducedByA';
  if (labels[0] === VIOLATION_LABELS.INTRODUCED_BY_B) return 'introducedByB';
  return 'combinationOnly';
}

/**
 * Evaluate every rule on the four states of the record (base, A-only,
 * B-only, merged) and classify merged violations. `rules` must already be
 * normalized by validateRules. Returns { results, summary } with results in
 * request order.
 */
export function previewConstraints(record, rules) {
  const documents = {
    base: record.base,
    // Single-side states reuse the base-coordinate merge semantics: the
    // side's saved patch merged against an empty opposite patch. Both
    // patches were validated against the saved base when the record was
    // created, so these merges are always clean.
    A: mergePatches(record.base, record.patchA, []).merged,
    B: mergePatches(record.base, record.patchB, []).merged,
    merged: record.merged,
  };

  const results = rules.map((rule) => {
    const states = {
      base: evaluateRule(rule, documents.base),
      A: evaluateRule(rule, documents.A),
      B: evaluateRule(rule, documents.B),
      merged: evaluateRule(rule, documents.merged),
    };
    return {
      id: rule.id,
      when: rule.when,
      equals: rule.equals,
      require: rule.require,
      states,
      violation: states.merged.pass ? null : { labels: classify(states) },
    };
  });

  const summary = {
    total: results.length,
    violations: { base: 0, A: 0, B: 0, merged: 0 },
    mergedViolations: {
      preexisting: 0,
      introducedByA: 0,
      introducedByB: 0,
      introducedByBoth: 0,
      combinationOnly: 0,
    },
  };
  for (const result of results) {
    for (const state of ['base', 'A', 'B', 'merged']) {
      if (!result.states[state].pass) summary.violations[state] += 1;
    }
    if (result.violation) {
      summary.mergedViolations[mergedViolationKind(result.violation.labels)] += 1;
    }
  }

  return { results, summary };
}
