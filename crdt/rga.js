/**
 * RGA (Replicated Growable Array) — a sequence CRDT for plain text.
 *
 * The document is a linear array of character nodes. Every node carries a
 * globally unique, immutable id of the form (counter, replicaId). Nodes are
 * never removed from the array: a deletion only flips the node to invisible
 * (a "tombstone"), because other replicas may still be referring to that node
 * as the anchor point for their own concurrent inserts. Positions/indices are
 * therefore only ever a *view* over the array — they are never stored, sent
 * over the wire, or used to address anything.
 *
 * Three op types, all of which commute and are idempotent:
 *   insert   { id, ch, origin }          — place `ch` immediately after `origin`
 *   delete   { id, target }              — hide node `target`
 *   undelete { id, target, deleteId }    — cancel the effect of delete `deleteId`
 *
 * `undelete` is what makes undo of a deletion possible without resurrecting a
 * node that some *other* replica also legitimately deleted: each delete is
 * cancelled individually by id, and a node is visible only when every delete
 * ever applied to it has been cancelled.
 */

/** Stable string key for an id, used for Map/Set lookups. */
export function idKey(id) {
  return id === null || id === undefined ? 'HEAD' : `${id.counter}:${id.replica}`;
}

/**
 * Total order over ids. Lamport counter first, replicaId as the tie-breaker.
 * The tie-break must be deterministic and identical on every replica, which is
 * the whole reason ids are (counter, replicaId) pairs rather than bare counters.
 */
export function compareIds(a, b) {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.replica === b.replica) return 0;
  return a.replica < b.replica ? -1 : 1;
}

export class RGA {
  constructor(replicaId) {
    if (!replicaId) throw new Error('RGA requires a replicaId');
    this.replicaId = replicaId;
    this.counter = 0;

    // The linearised document, tombstones included.
    this.nodes = [];
    // idKey -> node, so ops can address nodes without scanning.
    this.byId = new Map();
    // idKey of every op ever applied — makes apply() idempotent, which is what
    // lets us replay an op log on reconnect without deduplicating first.
    this.applied = new Set();
    // Ops that arrived before the node they refer to. Keyed by the missing
    // node's idKey. Delivery order is not guaranteed (a peer may relay a
    // reconnecting client's backlog in any interleaving), so ops must be able
    // to wait for their causal dependency instead of being dropped.
    this.pending = new Map();
  }

  // ---------------------------------------------------------------- clock ---

  /** Allocate the next locally-unique id and bump the Lamport clock. */
  nextId() {
    this.counter += 1;
    return { counter: this.counter, replica: this.replicaId };
  }

  /**
   * Merge a remote id into the local clock. Guarantees that any op we create
   * after seeing `id` sorts *above* it, which is the invariant the insertion
   * scan below depends on.
   */
  observeId(id) {
    if (id && id.counter > this.counter) this.counter = id.counter;
  }

  // ------------------------------------------------------------- read API ---

  /** Nodes currently visible, in document order. */
  visibleNodes() {
    const out = [];
    for (const node of this.nodes) if (node.hidden === 0) out.push(node);
    return out;
  }

  toString() {
    let s = '';
    for (const node of this.nodes) if (node.hidden === 0) s += node.ch;
    return s;
  }

  get length() {
    let n = 0;
    for (const node of this.nodes) if (node.hidden === 0) n += 1;
    return n;
  }

  /** Id of the visible character at `index`, or null if out of range. */
  idAt(index) {
    if (index < 0) return null;
    let seen = 0;
    for (const node of this.nodes) {
      if (node.hidden !== 0) continue;
      if (seen === index) return node.id;
      seen += 1;
    }
    return null;
  }

  /**
   * Visible index of a node id. Tombstoned or unknown ids return -1; callers
   * that track a cursor should fall back to the nearest surviving neighbour.
   */
  indexOf(id) {
    if (!id) return -1;
    const key = idKey(id);
    let seen = 0;
    for (const node of this.nodes) {
      if (node.hidden !== 0) continue;
      if (idKey(node.id) === key) return seen;
      seen += 1;
    }
    return -1;
  }

  /**
   * The caret offset that sits *immediately after* node `id`.
   *
   * This is how a cursor is resolved: a caret is stored as "the id of the
   * character I am sitting after", so displaying it means finding that
   * character and adding one. If the character has since been deleted by
   * someone else, fall back to the offset just after the nearest surviving
   * character before it, so the caret shifts to a sensible neighbour instead of
   * jumping to the top of the document.
   */
  indexAfterOrBefore(id) {
    if (!id) return 0;
    const key = idKey(id);
    let visibleSoFar = 0;
    for (const node of this.nodes) {
      if (idKey(node.id) === key) {
        // +1 because the caret goes after this character, not on it.
        return node.hidden === 0 ? visibleSoFar + 1 : visibleSoFar;
      }
      if (node.hidden === 0) visibleSoFar += 1;
    }
    // Unknown id (an op we haven't received yet): clamp to the end.
    return visibleSoFar;
  }

  // ------------------------------------------------------- local mutation ---

  /**
   * Insert `ch` at visible position `index`. The op is anchored to the id of
   * the visible character *before* the caret (or HEAD at position 0) — never to
   * the index itself, since the index means nothing on another replica.
   */
  localInsert(index, ch) {
    const origin = index === 0 ? null : this.idAt(index - 1);
    const op = { type: 'insert', id: this.nextId(), ch, origin };
    this.apply(op);
    return op;
  }

  /** Insert a whole string, chaining each character onto the previous one. */
  localInsertText(index, text) {
    const ops = [];
    for (let i = 0; i < text.length; i += 1) {
      ops.push(this.localInsert(index + i, text[i]));
    }
    return ops;
  }

  /** Delete the visible node at `index`. */
  localDeleteAt(index) {
    const target = this.idAt(index);
    return target ? this.localDeleteById(target) : null;
  }

  /** Delete `count` visible characters starting at `index`. */
  localDeleteRange(index, count) {
    const targets = [];
    for (let i = 0; i < count; i += 1) {
      const id = this.idAt(index + i);
      if (id) targets.push(id);
    }
    // Collected up-front by id: deleting shifts every later index, so looking
    // ids up one at a time as we mutate would delete the wrong characters.
    return targets.map((target) => this.localDeleteById(target));
  }

  localDeleteById(target) {
    const op = { type: 'delete', id: this.nextId(), target };
    this.apply(op);
    return op;
  }

  /** Cancel a specific earlier delete. This is how undo of a deletion works. */
  localUndelete(target, deleteId) {
    const op = { type: 'undelete', id: this.nextId(), target, deleteId };
    this.apply(op);
    return op;
  }

  // ------------------------------------------------------------ op engine ---

  /**
   * Apply any op, local or remote. Returns true if this call changed the
   * document. Safe to call repeatedly with the same op and in any order.
   */
  apply(op) {
    const key = idKey(op.id);
    if (this.applied.has(key)) return false;
    this.observeId(op.id);

    switch (op.type) {
      case 'insert':
        return this.#applyInsert(op);
      case 'delete':
        return this.#applyDelete(op);
      case 'undelete':
        return this.#applyUndelete(op);
      default:
        throw new Error(`unknown op type: ${op.type}`);
    }
  }

  applyMany(ops) {
    let changed = false;
    for (const op of ops) if (this.apply(op)) changed = true;
    return changed;
  }

  #defer(waitingOnKey, op) {
    if (!this.pending.has(waitingOnKey)) this.pending.set(waitingOnKey, []);
    this.pending.get(waitingOnKey).push(op);
  }

  /** Retry ops that were waiting on `key` now that the node exists. */
  #flushPending(key) {
    const queued = this.pending.get(key);
    if (!queued) return;
    this.pending.delete(key);
    for (const op of queued) this.apply(op);
  }

  #applyInsert(op) {
    const originKey = idKey(op.origin);
    // The anchor hasn't arrived yet — park the op rather than guessing.
    if (op.origin !== null && !this.byId.has(originKey)) {
      this.#defer(originKey, op);
      return false;
    }

    const node = {
      id: op.id,
      ch: op.ch,
      origin: op.origin,
      // Number of deletes affecting this node that have not been cancelled.
      // Visible only at zero. A count (not a boolean) because two replicas can
      // delete the same character concurrently and each delete must be undone
      // independently.
      hidden: 0,
      deletes: new Set(),
      cancelled: new Set(),
    };

    let pos = op.origin === null ? 0 : this.#indexOfNode(originKey) + 1;

    /**
     * RGA tie-break for concurrent inserts sharing an anchor: walk forward past
     * every node with a *higher* id and stop at the first lower one, so the
     * newest concurrent insert ends up first. Both replicas run the identical
     * scan over the identical array, so both reach the identical position.
     *
     * The scan cannot run past the end of the origin's subtree, which is what
     * would corrupt the tree structure. Any node created after `origin` has a
     * strictly greater Lamport counter than `origin` (see observeId), while the
     * node that terminates the subtree is a younger sibling of `origin` or of
     * one of its ancestors, and younger siblings always sort *below*. So the
     * first node with a lower id than ours is exactly the subtree boundary.
     */
    while (pos < this.nodes.length && compareIds(this.nodes[pos].id, op.id) > 0) {
      pos += 1;
    }

    this.nodes.splice(pos, 0, node);
    const key = idKey(op.id);
    this.byId.set(key, node);
    this.applied.add(key);
    this.#flushPending(key);
    return true;
  }

  #applyDelete(op) {
    const targetKey = idKey(op.target);
    const node = this.byId.get(targetKey);
    if (!node) {
      this.#defer(targetKey, op);
      return false;
    }
    const deleteKey = idKey(op.id);
    if (node.deletes.has(deleteKey)) return false;
    node.deletes.add(deleteKey);
    // An undelete for this delete may already have arrived out of order, in
    // which case the delete is born already cancelled.
    if (!node.cancelled.has(deleteKey)) node.hidden += 1;
    this.applied.add(deleteKey);
    return true;
  }

  #applyUndelete(op) {
    const targetKey = idKey(op.target);
    const node = this.byId.get(targetKey);
    if (!node) {
      this.#defer(targetKey, op);
      return false;
    }
    const deleteKey = idKey(op.deleteId);
    if (node.cancelled.has(deleteKey)) return false;
    node.cancelled.add(deleteKey);
    // Only decrement if that delete was actually counted; otherwise the
    // cancellation just sits in the set waiting for its delete to show up.
    if (node.deletes.has(deleteKey)) node.hidden -= 1;
    this.applied.add(idKey(op.id));
    return true;
  }

  #indexOfNode(key) {
    for (let i = 0; i < this.nodes.length; i += 1) {
      if (idKey(this.nodes[i].id) === key) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------ debugging ---

  /** Array-with-tombstones view, for tests and the inspector panel. */
  debugState() {
    return this.nodes.map((n) => ({
      id: idKey(n.id),
      ch: n.ch,
      visible: n.hidden === 0,
    }));
  }

  /** Count of ops parked waiting on a missing causal dependency. */
  get pendingCount() {
    let n = 0;
    for (const list of this.pending.values()) n += list.length;
    return n;
  }
}
