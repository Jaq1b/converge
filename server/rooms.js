/**
 * Room bookkeeping for the relay.
 *
 * Deliberately dumb: this module knows that a room has members and an ordered
 * list of *opaque* op blobs. It never inspects an op's contents, never applies
 * one, and has no idea what RGA is. All convergence logic lives in the clients;
 * the server's only jobs are fan-out and handing a late joiner the backlog.
 *
 * Because there is no CRDT logic here, the server can never be the thing that
 * corrupts a document — the worst it can do is deliver ops late, out of order,
 * or twice, all of which clients already tolerate by construction.
 *
 * Every collection here is bounded. An in-memory relay with unbounded growth is
 * a memory-exhaustion bug waiting for its first bad actor.
 */

const DEFAULTS = {
  /** Drop a room's history this long after the last member disconnects. */
  ttlMs: 10 * 60 * 1000,
  /** Per-room op ceiling. Reached only by a pathological session. */
  maxOps: 200_000,
  /** Total concurrent rooms held in memory. */
  maxRooms: 500,
  /** Members in a single room. */
  maxClientsPerRoom: 32,
};

export class Rooms {
  constructor(options = {}) {
    const config = { ...DEFAULTS, ...options };
    this.rooms = new Map();
    this.ttlMs = config.ttlMs;
    this.maxOps = config.maxOps;
    this.maxRooms = config.maxRooms;
    this.maxClientsPerRoom = config.maxClientsPerRoom;
  }

  #create(name) {
    const room = { name, members: new Set(), log: [], seen: new Set(), reapTimer: null };
    this.rooms.set(name, room);
    return room;
  }

  #keepAlive(room) {
    if (room.reapTimer) {
      clearTimeout(room.reapTimer);
      room.reapTimer = null;
    }
    return room;
  }

  /**
   * Admit a member. Returns the room, or null when a limit would be exceeded —
   * the caller is expected to reject the connection rather than ignore this.
   *
   * Capacity is checked *before* the room is created, so a rejected join can't
   * leave an empty room behind.
   */
  join(name, member) {
    const existing = this.rooms.get(name);
    if (!existing && this.rooms.size >= this.maxRooms) return null;
    if (existing && existing.members.size >= this.maxClientsPerRoom) return null;

    const room = this.#keepAlive(existing ?? this.#create(name));
    room.members.add(member);
    return room;
  }

  leave(name, member) {
    const room = this.rooms.get(name);
    if (!room) return;
    room.members.delete(member);
    if (room.members.size === 0) {
      // Keep the log briefly so a page refresh or a flaky connection doesn't
      // wipe the document out from under the last person in the room.
      room.reapTimer = setTimeout(() => this.rooms.delete(name), this.ttlMs);
      room.reapTimer.unref?.();
    }
  }

  /**
   * Append ops to the room log, skipping any already stored. Dedup is by op id
   * only — still no interpretation of what an op means.
   *
   * Returns two lists, because they answer different questions:
   *   fresh    — newly stored, so this is what gets broadcast to other members.
   *   accepted — held by the server now, including ops that were already
   *              present. This is what gets acknowledged: a duplicate is safe to
   *              clear from the sender's outbox, whereas a malformed or
   *              over-capacity op must stay there to be retried.
   */
  record(name, ops) {
    const room = this.rooms.get(name);
    if (!room) return { fresh: [], accepted: [] };

    const fresh = [];
    const accepted = [];
    for (const op of ops) {
      if (!isWellFormed(op)) continue;
      const key = `${op.id.counter}:${op.id.replica}`;
      if (room.seen.has(key)) {
        accepted.push(op);
        continue;
      }
      if (room.log.length >= this.maxOps) break;
      room.seen.add(key);
      room.log.push(op);
      fresh.push(op);
      accepted.push(op);
    }
    return { fresh, accepted };
  }

  history(name) {
    return this.rooms.get(name)?.log ?? [];
  }

  members(name) {
    return this.rooms.get(name)?.members ?? new Set();
  }

  stats() {
    let clients = 0;
    let ops = 0;
    for (const room of this.rooms.values()) {
      clients += room.members.size;
      ops += room.log.length;
    }
    return { rooms: this.rooms.size, clients, ops };
  }
}

/**
 * The only validation performed anywhere on the server, and it is structural
 * rather than semantic: an op must have an addressable id, because that is what
 * dedup and acknowledgement are keyed on. The meaning of the op is none of the
 * server's business.
 */
function isWellFormed(op) {
  return (
    op !== null &&
    typeof op === 'object' &&
    typeof op.id === 'object' &&
    op.id !== null &&
    Number.isFinite(op.id.counter) &&
    typeof op.id.replica === 'string' &&
    op.id.replica.length > 0 &&
    op.id.replica.length <= 64
  );
}
