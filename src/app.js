import { STATUS_CODES } from 'node:http';
import Fastify from 'fastify';
import { mergePatches, PatchError } from './merge.js';
import { auditOrdering } from './audit.js';
import { previewResolution, DecisionError, DECISION_CODES } from './resolution.js';
import { buildRoundTripPlan } from './roundtrip.js';
import { computeProvenance } from './provenance.js';
import { rebasePatch } from './rebase.js';
import { previewConstraints, validateRules, ConstraintError } from './constraint.js';
import {
  previewOwnership,
  validateOwnershipRules,
  OwnershipError,
} from './ownership.js';
import { MergeStore } from './store.js';
import {
  EXAMPLE_REQUEST,
  EXAMPLE_CONFLICT_REQUEST,
  EXAMPLE_REBASE_REQUEST,
  EXAMPLE_REBASE_CONFLICT_REQUEST,
  EXAMPLE_CONSTRAINT_PREVIEW_REQUEST,
  EXAMPLE_OWNERSHIP_PREVIEW_REQUEST,
} from './example.js';

export const VERSION = '1.0.0';

const operationSchema = {
  type: 'object',
  required: ['op', 'path'],
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['add', 'remove', 'replace'] },
    path: { type: 'string' },
    value: true,
  },
};

const mergeBodySchema = {
  type: 'object',
  required: ['base', 'patchA', 'patchB'],
  additionalProperties: false,
  properties: {
    base: true,
    patchA: { type: 'array', items: operationSchema },
    patchB: { type: 'array', items: operationSchema },
  },
};

const rebaseBodySchema = {
  type: 'object',
  required: ['base', 'patch', 'onto'],
  additionalProperties: false,
  properties: {
    base: true,
    patch: { type: 'array', items: operationSchema },
    onto: true,
  },
};

const resolutionBodySchema = {
  type: 'object',
  required: ['decisions'],
  additionalProperties: false,
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['conflict', 'winner'],
        additionalProperties: false,
        properties: {
          conflict: { type: 'integer', minimum: 0 },
          winner: { type: 'string', enum: ['A', 'B'] },
        },
      },
    },
  },
};

const constraintBodySchema = {
  type: 'object',
  required: ['rules'],
  additionalProperties: false,
  properties: {
    // Per-rule shape is validated in the handler so that invalid rules are
    // reported as 422 (INVALID_RULES) with per-rule details, not as 400.
    rules: { type: 'array' },
  },
};

const ownershipBodySchema = {
  type: 'object',
  required: ['rules'],
  additionalProperties: false,
  properties: {
    // Per-rule shape is validated in the handler so that invalid rules are
    // reported as 422 (INVALID_RULES) with per-rule details, not as 400.
    rules: { type: 'array' },
  },
};

function publicRecord(record) {
  const { id, status, merged, conflicts, stats, createdAt } = record;
  return { id, status, merged, conflicts, stats, createdAt };
}

export function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? { level: options.logLevel || 'info' },
  });
  const store = new MergeStore({ max: options.storeMax ?? 1000 });
  // Audit results are deterministic; cache per stored record so repeated
  // queries serialize byte-for-byte without re-running the replays.
  const audits = new WeakMap();
  // Round-trip plans are likewise pure functions of the saved base/merged.
  const plans = new WeakMap();
  // Provenance attributions are pure functions of the saved inputs.
  const provenances = new WeakMap();
  const startedAt = Date.now();

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `route ${req.method} ${req.url} not found`,
    });
  });

  app.setErrorHandler((err, req, reply) => {
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) req.log.error(err);
    reply.code(statusCode).send({
      statusCode,
      error: err.error || STATUS_CODES[statusCode] || 'Error',
      message: statusCode >= 500 ? 'unexpected server error' : err.message,
    });
  });

  app.get('/health', async () => ({
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
    store: { size: store.size(), max: store.max },
  }));

  app.get('/', async () => ({
    name: 'config-merge-rehearsal-api',
    version: VERSION,
    description:
      'Dry-run rehearsal for concurrent config changes: merges a base JSON document ' +
      'with two RFC 6902 patches (add/remove/replace) and reports deterministic ' +
      'results or structured conflicts.',
    endpoints: {
      'GET /health': 'liveness/readiness probe',
      'GET /api/v1/example': 'example merge request payload',
      'POST /api/v1/merges': 'rehearse a merge of { base, patchA, patchB }',
      'GET /api/v1/merges': 'list stored rehearsals',
      'GET /api/v1/merges/:id': 'fetch one rehearsal (inputs + outcome)',
      'GET /api/v1/merges/:id/order-audit':
        'replay saved patches A→B and B→A under strict RFC 6902 ordering (commutative / divergent / failed)',
      'POST /api/v1/merges/:id/resolution-preview':
        'preview per-conflict winner decisions (A/B) on a conflict record without modifying it',
      'GET /api/v1/merges/:id/round-trip-plan':
        'deterministic RFC 6902 forward (base -> merged) and rollback (merged -> base) patches, replayed server-side',
      'GET /api/v1/merges/:id/provenance':
        'per-leaf source attribution (base / A / B / both) of a clean merge at final JSON Pointers, with contributing operation indices',
      'POST /api/v1/merges/:id/constraint-preview':
        'evaluate conditional rules (when <pointer> deep-equals <value>, another <pointer> must exist) on base / A-only / B-only / merged of a clean record and classify merged violations (preexisting / introduced-by-A / introduced-by-B / combination-only), without modifying it',
      'POST /api/v1/merges/:id/ownership-preview':
        'check the saved patchA/patchB operations against path-ownership rules (unique RFC 6901 prefix -> owner A/B): longest-prefix attribution in base coordinates, array inserts attributed to the parent array, other-side descendant rules protected from replace/remove; returns a publishable verdict without modifying the record',
      'POST /api/v1/rebases':
        'rebase { base, patch, onto }: merge the client patch with the base->onto delta and return merged plus an onto-relative rebasedPatch (replayed server-side), or structured conflicts',
      'DELETE /api/v1/merges/:id': 'delete one rehearsal',
    },
  }));

  app.get('/api/v1/example', async () => ({
    description: 'POST the body below to /api/v1/merges',
    mergeRequest: EXAMPLE_REQUEST,
    conflictRequest: EXAMPLE_CONFLICT_REQUEST,
    rebaseDescription: 'POST the bodies below to /api/v1/rebases',
    rebaseRequest: EXAMPLE_REBASE_REQUEST,
    rebaseConflictRequest: EXAMPLE_REBASE_CONFLICT_REQUEST,
    constraintPreviewDescription:
      'POST the body below to /api/v1/merges/:id/constraint-preview ' +
      '(use the id of a clean merge record, e.g. one created from mergeRequest)',
    constraintPreviewRequest: EXAMPLE_CONSTRAINT_PREVIEW_REQUEST,
    ownershipPreviewDescription:
      'POST the body below to /api/v1/merges/:id/ownership-preview ' +
      '(works with any stored record, e.g. one created from mergeRequest)',
    ownershipPreviewRequest: EXAMPLE_OWNERSHIP_PREVIEW_REQUEST,
  }));

  app.post('/api/v1/merges', { schema: { body: mergeBodySchema } }, async (req, reply) => {
    const { base, patchA, patchB } = req.body;
    let result;
    try {
      result = mergePatches(base, patchA, patchB);
    } catch (err) {
      if (err instanceof PatchError) {
        return reply.code(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: err.code,
          message: err.message,
          details: err.details,
        });
      }
      throw err;
    }
    const record = store.save({ base, patchA, patchB, ...result });
    return reply.code(result.status === 'clean' ? 200 : 409).send(publicRecord(record));
  });

  app.get('/api/v1/merges', async () => ({
    total: store.size(),
    items: store.list(),
  }));

  app.get('/api/v1/merges/:id', async (req, reply) => {
    const record = store.get(req.params.id);
    if (!record) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `no rehearsal stored with id ${req.params.id}`,
      });
    }
    return record;
  });

  app.get('/api/v1/merges/:id/order-audit', async (req, reply) => {
    const record = store.get(req.params.id);
    if (!record) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `no rehearsal stored with id ${req.params.id}`,
      });
    }
    let result = audits.get(record);
    if (!result) {
      result = auditOrdering({
        base: record.base,
        patchA: record.patchA,
        patchB: record.patchB,
      });
      audits.set(record, result);
    }
    return {
      id: record.id,
      createdAt: record.createdAt,
      ...result,
    };
  });

  app.get('/api/v1/merges/:id/round-trip-plan', async (req, reply) => {
    const record = store.get(req.params.id);
    if (!record) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `no rehearsal stored with id ${req.params.id}`,
      });
    }
    if (record.status !== 'clean') {
      // Only successfully merged records carry a merged document to plan for.
      // The stored record is never modified.
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message:
          `rehearsal ${req.params.id} has status "${record.status}"; ` +
          'round-trip plan requires a clean merge record',
      });
    }
    let plan = plans.get(record);
    if (!plan) {
      // buildRoundTripPlan replays both patches server-side and throws if
      // either replay fails to reach its expected document.
      plan = buildRoundTripPlan(record.base, record.merged);
      plans.set(record, plan);
    }
    return {
      id: record.id,
      createdAt: record.createdAt,
      status: record.status,
      base: record.base,
      merged: record.merged,
      forward: plan.forward,
      rollback: plan.rollback,
      operationCount: plan.operationCount,
    };
  });

  app.get('/api/v1/merges/:id/provenance', async (req, reply) => {
    const record = store.get(req.params.id);
    if (!record) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `no rehearsal stored with id ${req.params.id}`,
      });
    }
    if (record.status !== 'clean') {
      // Only clean records carry a merged document to attribute. The stored
      // record is never modified.
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message:
          `rehearsal ${req.params.id} has status "${record.status}"; ` +
          'provenance requires a clean merge record',
      });
    }
    let provenance = provenances.get(record);
    if (!provenance) {
      // computeProvenance re-runs the base-coordinate merge pipeline on an
      // annotated mirror of the saved inputs; it is a pure function of the
      // record, so the cached answer serializes byte-for-byte on repeats.
      provenance = computeProvenance(record.base, record.patchA, record.patchB);
      provenances.set(record, provenance);
    }
    return {
      id: record.id,
      createdAt: record.createdAt,
      status: record.status,
      ...provenance,
    };
  });

  app.post(
    '/api/v1/merges/:id/resolution-preview',
    { schema: { body: resolutionBodySchema } },
    async (req, reply) => {
      const record = store.get(req.params.id);
      if (!record) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `no rehearsal stored with id ${req.params.id}`,
        });
      }
      if (record.status !== 'conflict') {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message:
            `rehearsal ${req.params.id} has status "${record.status}"; ` +
            'resolution preview requires a conflict record',
        });
      }
      let preview;
      try {
        preview = previewResolution(record, req.body.decisions);
      } catch (err) {
        if (err instanceof DecisionError) {
          const statusCode =
            err.code === DECISION_CODES.CONTRADICTORY_DECISIONS ? 422 : 400;
          return reply.code(statusCode).send({
            statusCode,
            error: STATUS_CODES[statusCode],
            code: err.code,
            message: err.message,
            ...err.details,
          });
        }
        throw err;
      }
      // Pure preview: the stored record is never modified. Residual conflicts
      // are reported with the same 409 shape as POST /api/v1/merges.
      return reply.code(preview.status === 'clean' ? 200 : 409).send({
        id: record.id,
        status: preview.status,
        merged: preview.merged,
        conflicts: preview.conflicts,
        retained: preview.retained,
        dropped: preview.dropped,
        stats: preview.stats,
      });
    },
  );

  app.post(
    '/api/v1/merges/:id/constraint-preview',
    { schema: { body: constraintBodySchema } },
    async (req, reply) => {
      const record = store.get(req.params.id);
      if (!record) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `no rehearsal stored with id ${req.params.id}`,
        });
      }
      if (record.status !== 'clean') {
        // Only clean records carry a merged document to evaluate. The stored
        // record is never modified.
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message:
            `rehearsal ${req.params.id} has status "${record.status}"; ` +
            'constraint preview requires a clean merge record',
        });
      }
      let rules;
      try {
        rules = validateRules(req.body.rules);
      } catch (err) {
        if (err instanceof ConstraintError) {
          return reply.code(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            code: err.code,
            message: err.message,
            ...err.details,
          });
        }
        throw err;
      }
      // Pure preview: the stored record is never modified. Single-side
      // states are computed with the same base-coordinate merge semantics
      // as the stored merge.
      const preview = previewConstraints(record, rules);
      return {
        id: record.id,
        createdAt: record.createdAt,
        status: record.status,
        ...preview,
      };
    },
  );

  app.post(
    '/api/v1/merges/:id/ownership-preview',
    { schema: { body: ownershipBodySchema } },
    async (req, reply) => {
      const record = store.get(req.params.id);
      if (!record) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `no rehearsal stored with id ${req.params.id}`,
        });
      }
      let rules;
      try {
        rules = validateOwnershipRules(req.body.rules);
      } catch (err) {
        if (err instanceof OwnershipError) {
          return reply.code(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            code: err.code,
            message: err.message,
            ...err.details,
          });
        }
        throw err;
      }
      // Pure preview: the stored record is never modified. Any record status
      // works — the check runs on the saved base/patchA/patchB alone and
      // never consults the merged document.
      const preview = previewOwnership(record, rules);
      return {
        id: record.id,
        createdAt: record.createdAt,
        status: record.status,
        ...preview,
      };
    },
  );

  app.delete('/api/v1/merges/:id', async (req, reply) => {
    if (!store.delete(req.params.id)) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `no rehearsal stored with id ${req.params.id}`,
      });
    }
    return reply.code(204).send();
  });

  app.post('/api/v1/rebases', { schema: { body: rebaseBodySchema } }, async (req, reply) => {
    const { base, patch, onto } = req.body;
    let result;
    try {
      result = rebasePatch(base, patch, onto);
    } catch (err) {
      if (err instanceof PatchError) {
        return reply.code(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: err.code,
          message: err.message,
          details: err.details,
        });
      }
      throw err;
    }
    // Stateless: nothing is stored. Conflict answers carry no executable
    // patch (rebasedPatch is null), only the structured conflicts.
    return reply.code(result.status === 'clean' ? 200 : 409).send(result);
  });

  return app;
}
