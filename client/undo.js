/**
 * Undo / redo that survives concurrent editing.
 *
 * The rule that makes this work: an undo entry stores **op ids**, never text
 * positions. "Undo the insert of character 7" is meaningless a second later —
 * someone else's edit above the caret has already moved character 7 somewhere
 * else. "Undo op (42, replica-a3f)" stays true forever, because ids are
 * immutable and the CRDT can always find the node an id refers to.
 *
 * Undo is therefore expressed as *new ops that invert old ops*, not as a
 * rollback to a previous state:
 *
 *   undo an insert    -> a delete targeting that inserted node's id
 *   undo a delete     -> an undelete cancelling that specific delete op's id
 *   undo an undelete  -> a fresh delete of the same node
 *
 * Two consequences worth noting, both intentional:
 *
 *   - Undo only ever touches ops *this* replica authored. You cannot undo a
 *     collaborator's typing, which is what people expect from a shared doc.
 *   - Because an undo is just another op, it broadcasts, merges, and converges
 *     like any other edit. Remote replicas need no undo-specific handling.
 */

/** Consecutive keystrokes inside this window collapse into one undo step. */
const COALESCE_MS = 600;
const MAX_STACK = 300;

function idKey(id) {
  return id ? `${id.counter}:${id.replica}` : 'HEAD';
}

export class UndoManager {
  /**
   * @param {object} options
   * @param {import('../crdt/rga.js').RGA} options.doc
   * @param {(ops: object[]) => void} options.onOps  publish ops undo generates
   * @param {() => number} [options.now]             injectable clock, for tests
   */
  constructor({ doc, onOps, now = () => Date.now() }) {
    this.doc = doc;
    this.onOps = onOps ?? (() => {});
    this.now = now;
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  /**
   * Record local ops as one undoable step.
   *
   * Runs of typing are merged so that undo removes a word rather than a single
   * letter. Merging is decided by op *identity* — the new op must be anchored
   * to the last op of the previous step — rather than by comparing indices,
   * which would silently mis-merge when a remote edit lands between keystrokes.
   */
  record(ops) {
    const batch = ops.filter(Boolean);
    if (batch.length === 0) return;

    // Any fresh edit invalidates the redo branch, as in every other editor.
    this.redoStack.length = 0;

    const top = this.undoStack[this.undoStack.length - 1];
    if (top && this.#canCoalesce(top, batch)) {
      top.ops.push(...batch);
      top.at = this.now();
    } else {
      this.undoStack.push({ ops: batch, at: this.now() });
      if (this.undoStack.length > MAX_STACK) this.undoStack.shift();
    }
  }

  #canCoalesce(entry, batch) {
    if (this.now() - entry.at > COALESCE_MS) return false;

    const prev = entry.ops[entry.ops.length - 1];
    const next = batch[0];
    if (prev.type !== next.type) return false;

    if (next.type === 'insert') {
      // Only merge if the new character was typed directly after the previous
      // one — an id-level check, immune to concurrent edits moving things.
      return idKey(next.origin) === idKey(prev.id);
    }
    if (next.type === 'delete') {
      // Merge a run of backspaces/deletes regardless of direction.
      return true;
    }
    return false;
  }

  undo() {
    return this.#applyInverse(this.undoStack, this.redoStack);
  }

  redo() {
    return this.#applyInverse(this.redoStack, this.undoStack);
  }

  #applyInverse(from, to) {
    const entry = from.pop();
    if (!entry) return null;

    // Inverting in reverse order matters for a multi-op step: undoing "abc"
    // must un-insert c, then b, then a, mirroring how it was built.
    const inverses = [];
    for (let i = entry.ops.length - 1; i >= 0; i -= 1) {
      const inverse = this.#invert(entry.ops[i]);
      if (inverse) inverses.push(inverse);
    }
    if (inverses.length === 0) return null;

    // The inverse batch becomes the opposite stack's entry: undoing an undo is
    // just inverting it again, so one code path covers both directions.
    to.push({ ops: inverses, at: this.now() });
    if (to.length > MAX_STACK) to.shift();

    this.onOps(inverses);
    return inverses;
  }

  /**
   * Build the op that cancels `op`. These are ordinary local ops with fresh
   * ids, applied to the document immediately — undo is an edit, not a rewind.
   */
  #invert(op) {
    switch (op.type) {
      case 'insert':
        return this.doc.localDeleteById(op.id);
      case 'delete':
        // Cancel this one delete by id. A concurrent delete of the same
        // character by someone else has its own id and stays in force, so
        // undoing your delete can't resurrect text another user removed.
        return this.doc.localUndelete(op.target, op.id);
      case 'undelete':
        return this.doc.localDeleteById(op.target);
      default:
        return null;
    }
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
