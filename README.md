# Converge

Live Demo: _(paste URL here after deploying)_

A real-time collaborative plain-text editor. Several people type in the same
document at once, go offline, come back, and everyone ends up with identical text.
The merge engine is an RGA sequence CRDT written directly in this repo. No Yjs,
no Automerge, no operational-transform library.

```
npm install
npm start          # http://localhost:8080
npm test           # 57 tests
```

## What everything does

- **CRDT** (`crdt/rga.js`): a flat array of character nodes, each with a Lamport
  id and an anchor saying which character it was inserted after. One insertion
  scan resolves concurrent edits. Deletes are logical. ~350 lines, no deps.
- **Op log** (`crdt/oplog.js`): every local edit is appended and held in an outbox
  until the server acknowledges it. Acks are matched by operation id, never by
  count or position, since they can arrive twice or out of order.
- **Undo** (`client/undo.js`): stores operation ids and undoes by emitting inverse
  operations, so it stays correct while other people are editing.
- **Relay** (`server/`): keeps an append-only list of opaque JSON per room,
  replays it to whoever joins, forwards new ops to everyone else. It never parses
  an operation.
- **Offline**: edits keep applying locally. On reconnect the client applies the
  room's whole log and re-sends everything unacknowledged. Both are idempotent, so
  duplicates are free.
- **Presence**: live cursors, broadcast outside the CRDT as operation ids rather
  than offsets, because an offset means something different on every replica.

## High-level architecture

```
      browser A                                     browser B
 ┌──────────────────┐                        ┌──────────────────┐
 │ textarea         │                        │ textarea         │
 │   ↕ diff/render  │                        │   ↕ diff/render  │
 │ RGA (merge here) │                        │ RGA (merge here) │
 │   ↓              │                        │   ↓              │
 │ op log + outbox  │                        │ op log + outbox  │
 └─────────┬────────┘                        └────────┬─────────┘
           └──────────── WebSocket ───────────────────┘
                              │
                 ┌────────────▼─────────────┐
                 │ relay (no CRDT logic)    │
                 │ room → [opaque ops ...]  │
                 │ replayed to late joiners │
                 └──────────────────────────┘
```

## Design choices

**RGA over OT:** operational transformation needs a central server to impose a
total order on edits, and that dependency is what makes offline editing hard. A
CRDT makes operations commute by construction instead, so any replica can apply
anything in any order. Among sequence CRDTs, RGA was the one whose correctness
argument is short enough to actually verify by hand.

**Tombstones are never collected:** if A deletes a character while B concurrently
types a character anchored to it, removing it would leave B's insert pointing at
nothing. Collecting them safely needs causal stability across every replica, so
the array only grows, and the editor shows the live tombstone count rather than
hiding the cost.

**Undo is keyed by operation id, not position:** a stack that records "five
characters at index 12" will delete someone else's text if they inserted above
index 12 in the meantime. Ids never move, so an undo entry stays valid regardless
of what peers did. The tradeoff is that undo means "revert my operation", not
"restore the document to how it looked". The latter isn't well-defined under
concurrency.

**The server doesn't understand the CRDT:** merge correctness lives entirely in
the clients, so the relay can't corrupt a document. The worst it can do is deliver
ops late, twice, or out of order, all of which clients already tolerate. It also
means most of the test suite needs no server at all.

**No database:** rooms are in-memory and dropped 10 minutes after the last
participant leaves, so documents reset when the process restarts. Durability sits
outside the merge semantics this project is about, and since the op log is already
append-only, adding it later means writing that log somewhere rather than changing
any of the above.

## Stack

- Backend: Node, `ws` (the only runtime dependency)
- Frontend: vanilla JS, no framework, no build step
- Tests: 57, custom runner. Multi-replica convergence fuzzing plus end-to-end
  over real sockets
- Deploy: Render (`render.yaml` included), CI on Node 20 and 22
