/**
 * Convergence tests for the RGA.
 *
 * The point of these is not line coverage — it is to assert the two properties
 * that make the data structure a CRDT at all:
 *
 *   1. Commutativity: replicas that have seen the same *set* of ops hold the
 *      same state, regardless of the order the ops arrived in.
 *   2. Idempotency: delivering an op twice is a no-op, so a client can blindly
 *      replay its whole backlog after a reconnect.
 *
 * Convergence is checked on `debugState()` rather than `toString()`, because
 * two replicas can print the same text while disagreeing about tombstone
 * placement — a latent divergence that only shows up several edits later.
 */

import assert from 'node:assert/strict';
import { RGA, compareIds, idKey } from './rga.js';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// -------------------------------------------------------------- utilities ---

/** Deterministic PRNG (mulberry32) so a failing fuzz seed can be replayed. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function stateSignature(doc) {
  return JSON.stringify(doc.debugState());
}

function assertConverged(replicas, context) {
  const [first, ...rest] = replicas;
  for (const other of rest) {
    assert.equal(
      other.toString(),
      first.toString(),
      `${context}: text diverged between ${first.replicaId} and ${other.replicaId}\n` +
        `  ${first.replicaId}: ${JSON.stringify(first.toString())}\n` +
        `  ${other.replicaId}: ${JSON.stringify(other.toString())}`,
    );
    assert.equal(
      stateSignature(other),
      stateSignature(first),
      `${context}: tombstone layout diverged between ${first.replicaId} and ${other.replicaId}`,
    );
    assert.equal(other.pendingCount, 0, `${context}: ${other.replicaId} has unresolved pending ops`);
  }
}

// ------------------------------------------------------- single-replica ---

test('inserts text in order', () => {
  const doc = new RGA('A');
  doc.localInsertText(0, 'hello');
  assert.equal(doc.toString(), 'hello');
});

test('inserts in the middle and at the head', () => {
  const doc = new RGA('A');
  doc.localInsertText(0, 'hell');
  doc.localInsertText(4, ' word');
  doc.localInsertText(9, '!');
  doc.localInsertText(0, '> ');
  assert.equal(doc.toString(), '> hell word!');
});

test('deletes leave tombstones but hide characters', () => {
  const doc = new RGA('A');
  doc.localInsertText(0, 'hello');
  doc.localDeleteRange(1, 3);
  assert.equal(doc.toString(), 'ho');
  assert.equal(doc.nodes.length, 5, 'tombstones must be retained as anchors');
});

test('deleting a range deletes the intended characters', () => {
  // Regression guard: deleting by index in a loop deletes the wrong characters
  // once the first removal shifts everything after it.
  const doc = new RGA('A');
  doc.localInsertText(0, 'abcdef');
  doc.localDeleteRange(2, 3);
  assert.equal(doc.toString(), 'abf');
});

test('ids are totally ordered with replicaId as tie-break', () => {
  assert.equal(compareIds({ counter: 1, replica: 'A' }, { counter: 2, replica: 'A' }), -1);
  assert.equal(compareIds({ counter: 2, replica: 'A' }, { counter: 2, replica: 'B' }), -1);
  assert.equal(compareIds({ counter: 2, replica: 'B' }, { counter: 2, replica: 'A' }), 1);
  assert.equal(compareIds({ counter: 2, replica: 'A' }, { counter: 2, replica: 'A' }), 0);
});

// -------------------------------------------------- cursor id resolution ---

test('idAt and indexOf are inverses over visible characters', () => {
  const doc = new RGA('A');
  doc.localInsertText(0, 'abcdef');
  for (let i = 0; i < 6; i += 1) {
    assert.equal(doc.indexOf(doc.idAt(i)), i, `round trip failed at ${i}`);
  }
  assert.equal(doc.idAt(6), null, 'past the end has no id');
  assert.equal(doc.indexOf({ counter: 999, replica: 'Z' }), -1);
});

test('idAt skips tombstones', () => {
  const doc = new RGA('A');
  const ops = doc.localInsertText(0, 'abcdef');
  doc.localDeleteById(ops[1].id); // hide 'b'
  doc.localDeleteById(ops[2].id); // hide 'c'
  assert.equal(doc.toString(), 'adef');
  assert.equal(doc.idAt(1).counter, ops[3].id.counter, 'index 1 is now d');
  assert.equal(doc.indexOf(ops[1].id), -1, 'a tombstone has no visible index');
});

test('a caret anchor resolves to the offset just after its character', () => {
  // A caret is stored as the id of the character before it, so resolving it
  // must land *after* that character. An off-by-one here drags every remote
  // cursor one character to the left.
  const doc = new RGA('A');
  doc.localInsertText(0, 'hello');
  for (let caret = 1; caret <= 5; caret += 1) {
    const anchor = doc.idAt(caret - 1);
    assert.equal(doc.indexAfterOrBefore(anchor), caret, `caret ${caret} moved`);
  }
  assert.equal(doc.indexAfterOrBefore(null), 0, 'a null anchor means the start');
});

test('a caret anchored to a remotely deleted character falls back gracefully', () => {
  const a = new RGA('A');
  const b = new RGA('B');
  const ops = a.localInsertText(0, 'abcdef');
  b.applyMany(ops);

  // A's caret sits after 'c' (offset 3); B deletes 'c'.
  const anchor = a.idAt(2);
  a.apply(b.localDeleteById(ops[2].id));

  assert.equal(a.toString(), 'abdef');
  // The anchored character is gone, so the caret lands after 'b' — the nearest
  // surviving character before it — rather than at the top of the document.
  assert.equal(a.indexAfterOrBefore(anchor), 2);
});

test('a caret anchor survives inserts above it', () => {
  const a = new RGA('A');
  const b = new RGA('B');
  b.applyMany(a.localInsertText(0, 'tail'));

  const anchor = a.idAt(1); // caret after 'a', offset 2
  assert.equal(a.indexAfterOrBefore(anchor), 2);

  // B inserts 6 characters above the caret; the raw offset 2 is now wrong, but
  // the id-based anchor tracks the character it was attached to.
  a.applyMany(b.localInsertText(0, 'PREFIX'));
  assert.equal(a.toString(), 'PREFIXtail');
  assert.equal(a.indexAfterOrBefore(anchor), 8);
});

// ------------------------------------------------------ two-replica merge ---

test('concurrent inserts at the same position keep both, deterministically', () => {
  const a = new RGA('A');
  const b = new RGA('B');
  const seed = a.localInsertText(0, 'ab');
  b.applyMany(seed);

  const fromA = a.localInsert(1, 'X');
  const fromB = b.localInsert(1, 'Y');

  b.apply(fromA);
  a.apply(fromB);

  assert.equal(a.toString(), b.toString());
  // Both characters survive — a CRDT never drops a concurrent insert.
  assert.ok(a.toString().includes('X') && a.toString().includes('Y'));
  assert.equal(a.toString().length, 4);
});

test('concurrent inserts converge in either delivery order', () => {
  const build = (deliverAFirst) => {
    const a = new RGA('A');
    const b = new RGA('B');
    const seed = a.localInsertText(0, 'ab');
    b.applyMany(seed);
    const fromA = a.localInsert(1, 'X');
    const fromB = b.localInsert(1, 'Y');
    const target = new RGA('C');
    target.applyMany(seed);
    target.applyMany(deliverAFirst ? [fromA, fromB] : [fromB, fromA]);
    return target.toString();
  };
  assert.equal(build(true), build(false));
});

test('concurrent delete and insert at the same spot both take effect', () => {
  const a = new RGA('A');
  const b = new RGA('B');
  b.applyMany(a.localInsertText(0, 'abc'));

  const del = a.localDeleteAt(1); // A removes 'b'
  const ins = b.localInsert(1, 'Z'); // B types before 'b'

  b.apply(del);
  a.apply(ins);

  assertConverged([a, b], 'delete/insert');
  assert.equal(a.toString(), 'aZc');
});

test('concurrent deletes of the same character are safe', () => {
  const a = new RGA('A');
  const b = new RGA('B');
  b.applyMany(a.localInsertText(0, 'abc'));

  const delA = a.localDeleteAt(1);
  const delB = b.localDeleteAt(1);
  b.apply(delA);
  a.apply(delB);

  assertConverged([a, b], 'double delete');
  assert.equal(a.toString(), 'ac');
});

test('typed words do not interleave character by character', () => {
  // Naive "insert after index" schemes shred concurrent words into "hweolrllod".
  // Chaining each character onto the previous one keeps runs contiguous.
  const a = new RGA('A');
  const b = new RGA('B');
  b.applyMany(a.localInsertText(0, '\n'));

  const opsA = a.localInsertText(0, 'hello');
  const opsB = b.localInsertText(0, 'world');
  b.applyMany(opsA);
  a.applyMany(opsB);

  assertConverged([a, b], 'interleaving');
  const text = a.toString().trim();
  assert.ok(
    text === 'helloworld' || text === 'worldhello',
    `expected contiguous words, got ${JSON.stringify(text)}`,
  );
});

// --------------------------------------------------- delivery robustness ---

test('applying the same op twice is a no-op', () => {
  const a = new RGA('A');
  const b = new RGA('B');
  const ops = a.localInsertText(0, 'hey');
  const del = a.localDeleteAt(0);

  b.applyMany(ops);
  b.apply(del);
  const before = stateSignature(b);
  // Replay the entire backlog, as a client does after reconnecting.
  b.applyMany([...ops, del, ...ops]);
  assert.equal(stateSignature(b), before);
});

test('ops that arrive before their causal dependency are buffered, not dropped', () => {
  const a = new RGA('A');
  const ops = a.localInsertText(0, 'abcdef');
  const del = a.localDeleteById(ops[2].id);

  const b = new RGA('B');
  // Fully reversed delivery: every op arrives before the one it depends on.
  b.applyMany([del, ...ops].reverse());

  assert.equal(b.pendingCount, 0, 'every buffered op should eventually apply');
  assert.equal(b.toString(), a.toString());
  assert.equal(stateSignature(b), stateSignature(a));
});

test('undelete cancels a specific delete and commutes with it', () => {
  const a = new RGA('A');
  const ops = a.localInsertText(0, 'abc');
  const del = a.localDeleteById(ops[1].id);
  const undel = a.localUndelete(ops[1].id, del.id);
  assert.equal(a.toString(), 'abc');

  // Same ops, worst-case order: undelete first, then its delete, then the insert.
  const b = new RGA('B');
  b.applyMany([undel, del, ...ops]);
  assert.equal(b.toString(), 'abc');
  assert.equal(stateSignature(b), stateSignature(a));
});

test('undoing your own delete does not resurrect someone else\'s delete', () => {
  // A and B independently delete the same character; A undoes its delete.
  // B's delete is untouched, so the character must stay hidden.
  const a = new RGA('A');
  const b = new RGA('B');
  const ops = a.localInsertText(0, 'abc');
  b.applyMany(ops);

  const delA = a.localDeleteById(ops[1].id);
  const delB = b.localDeleteById(ops[1].id);
  a.apply(delB);
  b.apply(delA);

  const undoA = a.localUndelete(ops[1].id, delA.id);
  b.apply(undoA);

  assert.equal(a.toString(), 'ac', 'B\'s delete must still hide the character');
  assertConverged([a, b], 'independent deletes');
});

// -------------------------------------------------------------- fuzzing ---

/**
 * Random concurrent editing across N replicas with random partial delivery,
 * then a full shuffled flush. This is the test that would actually catch a
 * broken tie-break rule.
 */
function fuzzRound(seed, replicaCount, rounds) {
  const rand = rng(seed);
  const names = ['A', 'B', 'C', 'D', 'E'].slice(0, replicaCount);
  const replicas = names.map((n) => new RGA(n));
  const inbox = new Map(); // replicaId -> ops generated elsewhere, not yet delivered
  const allOps = [];
  for (const n of names) inbox.set(n, []);

  const alphabet = 'abcdefghijklmnopqrstuvwxyz \n';

  for (let round = 0; round < rounds; round += 1) {
    const doc = replicas[Math.floor(rand() * replicas.length)];
    const roll = rand();

    if (roll < 0.55 || doc.length === 0) {
      const at = Math.floor(rand() * (doc.length + 1));
      const ch = alphabet[Math.floor(rand() * alphabet.length)];
      const op = doc.localInsert(at, ch);
      allOps.push(op);
      for (const other of replicas) {
        if (other !== doc) inbox.get(other.replicaId).push(op);
      }
    } else if (roll < 0.85) {
      const at = Math.floor(rand() * doc.length);
      const op = doc.localDeleteAt(at);
      if (op) {
        allOps.push(op);
        for (const other of replicas) {
          if (other !== doc) inbox.get(other.replicaId).push(op);
        }
      }
    } else {
      // Partial, out-of-order sync: deliver a random slice of one replica's
      // inbox. This is what a flaky connection looks like.
      const queue = inbox.get(doc.replicaId);
      if (queue.length > 0) {
        const take = 1 + Math.floor(rand() * queue.length);
        const chosen = shuffle(queue, rand).slice(0, take);
        doc.applyMany(chosen);
        const delivered = new Set(chosen.map((op) => idKey(op.id)));
        inbox.set(
          doc.replicaId,
          queue.filter((op) => !delivered.has(idKey(op.id))),
        );
      }
    }
  }

  // Reconnect everybody: flush every outstanding op in a random order.
  for (const doc of replicas) {
    doc.applyMany(shuffle(inbox.get(doc.replicaId), rand));
  }
  assertConverged(replicas, `fuzz seed=${seed}`);
  return { replicas, allOps };
}

test('random concurrent edits across 3 replicas always converge', () => {
  for (let seed = 1; seed <= 40; seed += 1) fuzzRound(seed, 3, 120);
});

test('random concurrent edits across 5 replicas always converge', () => {
  for (let seed = 100; seed <= 120; seed += 1) fuzzRound(seed, 5, 250);
});

test('the same op set converges from any merge order', () => {
  for (let seed = 500; seed <= 515; seed += 1) {
    const { replicas, allOps } = fuzzRound(seed, 3, 150);
    const expected = stateSignature(replicas[0]);

    // Feed the identical op set to fresh replicas in ten random orders.
    for (let trial = 0; trial < 10; trial += 1) {
      const fresh = new RGA(`fresh${trial}`);
      fresh.applyMany(shuffle(allOps, rng(seed * 31 + trial)));
      assert.equal(fresh.pendingCount, 0, `seed=${seed} trial=${trial}: ops left pending`);
      assert.equal(
        stateSignature(fresh),
        expected,
        `seed=${seed} trial=${trial}: merge order changed the result`,
      );
    }
  }
});

test('a replica that goes offline mid-session catches up exactly', () => {
  for (let seed = 900; seed <= 915; seed += 1) {
    const rand = rng(seed);
    const online1 = new RGA('A');
    const online2 = new RGA('B');
    const offline = new RGA('C');

    const shared = online1.localInsertText(0, 'shared document\n');
    online2.applyMany(shared);
    offline.applyMany(shared);

    // C is disconnected: it keeps editing, and never hears about A/B.
    const offlineOps = [];
    for (let i = 0; i < 40; i += 1) {
      const at = Math.floor(rand() * (offline.length + 1));
      offlineOps.push(offline.localInsert(at, 'xyz'[i % 3]));
    }

    const onlineOps = [];
    for (let i = 0; i < 40; i += 1) {
      const doc = rand() < 0.5 ? online1 : online2;
      const at = Math.floor(rand() * (doc.length + 1));
      const op = doc.localInsert(at, 'PQR'[i % 3]);
      onlineOps.push(op);
      (doc === online1 ? online2 : online1).apply(op);
    }

    // Reconnect: C replays its backlog, and receives everything it missed.
    offline.applyMany(shuffle(onlineOps, rand));
    online1.applyMany(shuffle(offlineOps, rand));
    online2.applyMany(shuffle(offlineOps, rand));

    assertConverged([online1, online2, offline], `offline merge seed=${seed}`);
  }
});
