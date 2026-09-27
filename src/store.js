import { randomUUID } from 'node:crypto';

/**
 * In-memory store for rehearsal records. FIFO eviction once `max` is reached.
 */
export class MergeStore {
  constructor({ max = 1000 } = {}) {
    this.max = max;
    this.records = new Map();
  }

  save(record) {
    const id = randomUUID();
    if (this.records.size >= this.max) {
      const oldest = this.records.keys().next().value;
      this.records.delete(oldest);
    }
    const stored = { id, createdAt: new Date().toISOString(), ...record };
    this.records.set(id, stored);
    return stored;
  }

  get(id) {
    return this.records.get(id) || null;
  }

  list() {
    return [...this.records.values()].map(({ id, status, createdAt, stats }) => ({
      id,
      status,
      createdAt,
      stats,
    }));
  }

  delete(id) {
    return this.records.delete(id);
  }

  size() {
    return this.records.size;
  }
}
