/**
 * Canned example payload, also mirrored in examples/merge-request.json.
 * Demonstrates: scalar replace, same-gap array insertions (A before B),
 * element removal with index drift, identical-op deduplication.
 */
export const EXAMPLE_REQUEST = {
  base: {
    app: 'payment-service',
    replicas: 2,
    servers: [
      { host: 'a.internal', port: 8080 },
      { host: 'b.internal', port: 8080 },
    ],
    features: { cache: true, tracing: false },
    tags: ['stable'],
  },
  patchA: [
    { op: 'replace', path: '/replicas', value: 3 },
    { op: 'add', path: '/servers/1', value: { host: 'a2.internal', port: 8080 } },
    { op: 'replace', path: '/features/tracing', value: true },
  ],
  patchB: [
    { op: 'remove', path: '/servers/0' },
    { op: 'add', path: '/servers/1', value: { host: 'b2.internal', port: 9090 } },
    { op: 'add', path: '/features/retries', value: 3 },
    { op: 'replace', path: '/features/tracing', value: true },
  ],
};

export const EXAMPLE_CONFLICT_REQUEST = {
  base: {
    database: { host: 'db1.internal', port: 5432 },
    mode: 'ha',
  },
  patchA: [
    { op: 'remove', path: '/database' },
    { op: 'replace', path: '/mode', value: 'single' },
  ],
  patchB: [
    { op: 'replace', path: '/database/host', value: 'db2.internal' },
    { op: 'replace', path: '/mode', value: 'readonly' },
  ],
};

/**
 * Canned rebase payload, also mirrored in examples/rebase-request.json.
 * The client patch (replicas -> 3, features.retries) is rebased onto a new
 * upstream version that removed servers[0], appended a server, flipped
 * tracing and added a region — disjoint from the client changes, so the
 * rebase is clean.
 */
export const EXAMPLE_REBASE_REQUEST = {
  base: {
    app: 'payment-service',
    replicas: 2,
    servers: [
      { host: 'a.internal', port: 8080 },
      { host: 'b.internal', port: 8080 },
    ],
    features: { cache: true, tracing: false },
  },
  patch: [
    { op: 'replace', path: '/replicas', value: 3 },
    { op: 'add', path: '/features/retries', value: 3 },
  ],
  onto: {
    app: 'payment-service',
    replicas: 2,
    servers: [
      { host: 'b.internal', port: 8080 },
      { host: 'c.internal', port: 9090 },
    ],
    features: { cache: true, tracing: true },
    region: 'eu-west',
  },
};

/**
 * Canned conflicting rebase payload, mirrored in
 * examples/rebase-conflict-request.json: upstream flipped /mode and removed
 * servers[0], while the client patch replaces /mode and edits inside
 * servers[0].
 */
export const EXAMPLE_REBASE_CONFLICT_REQUEST = {
  base: {
    mode: 'ha',
    servers: [{ host: 'a.internal' }, { host: 'b.internal' }],
  },
  patch: [
    { op: 'replace', path: '/mode', value: 'single' },
    { op: 'replace', path: '/servers/0/host', value: 'a2.internal' },
  ],
  onto: {
    mode: 'readonly',
    servers: [{ host: 'b.internal' }],
  },
};

/**
 * Canned constraint-preview payload, mirrored in
 * examples/constraint-preview-request.json. Evaluated against a clean record
 * created from EXAMPLE_REQUEST it exercises every merged-violation
 * classification: preexisting, introduced-by-A, introduced-by-B,
 * introduced-by-both (A and B independently) and combination-only, plus one
 * rule that passes everywhere.
 */
export const EXAMPLE_CONSTRAINT_PREVIEW_REQUEST = {
  rules: [
    {
      id: 'cache-needs-review',
      when: '/features/cache',
      equals: true,
      require: '/features/cache-review',
    },
    {
      id: 'replicas-need-capacity-review',
      when: '/replicas',
      equals: 3,
      require: '/capacity-review',
    },
    {
      id: 'retries-need-budget',
      when: '/features/retries',
      equals: 3,
      require: '/features/retry-budget',
    },
    {
      id: 'tracing-needs-audit',
      when: '/features/tracing',
      equals: true,
      require: '/features/audit',
    },
    {
      id: 'first-server-needs-verification',
      when: '/servers/0/host',
      equals: 'a2.internal',
      require: '/servers/0/verified',
    },
    {
      id: 'app-implies-replicas',
      when: '/app',
      equals: 'payment-service',
      require: '/replicas',
    },
  ],
};
