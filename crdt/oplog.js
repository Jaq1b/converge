/**
 * The local operation log.
 *
 * Two features depend on this one structure:
 *
 *   Offline sync — every op this replica generates goes into an outbox and
 *   stays there until the server acknowledges it. Reconnecting means "flush the
 *   outbox", nothing more. Because ops are idempotent, re-sending something the
 *   server already had is harmless, so we can be as pessimistic as we like
 *   about what actually made it across.
 *
 *   Undo — the ordered list of ops *this* replica authored. Undo walks this
 *   list, not the document, which is why undo stays correct while other people
 *   are editing: entries are identified by op id, and an op id never moves.
 *
 * Remote ops are recorded too (so the log is a complete history of what this
 * replica has seen) but they are never put in the outbox and never offered to
 * undo — you can only undo your own edits.
 */

import { idKey } from './rga.js';

export class OpLog {
  constructor(replicaId) {
    this.replicaId = replicaId;
    this.entries = [];
    this.index = new Set();
    /** Ops authored here that the server has not confirmed yet, in order. */
    this.outbox = [];
  }

  /**
   * Record an op. `local` marks it as authored by this replica, which is what
   * makes it eligible for the outbox and for undo.
   * Returns false if the op was already known.
   */
  append(op, { local = false } = {}) {
    const key = idKey(op.id);
    if (this.index.has(key)) return false;
    this.index.add(key);
    this.entries.push({ op, local, key });
    if (local) this.outbox.push(op);
    return true;
  }

  appendMany(ops, options) {
    let added = 0;
    for (const op of ops) if (this.append(op, options)) added += 1;
    return added;
  }

  has(id) {
    return this.index.has(idKey(id));
  }

  /** Every op this replica authored, oldest first. This is undo's input. */
  localOps() {
    return this.entries.filter((e) => e.local).map((e) => e.op);
  }

  /** Everything seen so far, for replaying into a fresh document. */
  allOps() {
    return this.entries.map((e) => e.op);
  }

  /** Ops still waiting on an ack. Sent on every (re)connect. */
  pending() {
    return this.outbox.slice();
  }

  get pendingCount() {
    return this.outbox.length;
  }

  /**
   * Clear acknowledged ops from the outbox.
   *
   * Acks are matched by id rather than by count or position: acks can arrive
   * out of order, or twice, or for ops from a previous connection, and matching
   * on identity is the only thing that stays correct in all of those cases.
   */
  ack(ids) {
    const acked = new Set(ids.map(idKey));
    if (acked.size === 0) return 0;
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((op) => !acked.has(idKey(op.id)));
    return before - this.outbox.length;
  }
}
