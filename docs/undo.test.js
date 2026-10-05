/**
 * Undo/redo tests, with the emphasis on behaviour *under concurrent remote
 * edits* — the case that breaks position-based undo stacks.
 */

import assert from 'node:assert/strict';
import { RGA } from '../crdt/rga.js';
import { OpLog } from '../crdt/oplog.js';
import { UndoManager } from './undo.js';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/**
 * A replica with the same plumbing main.js uses: document, op log, undo
 * manager, and an outbox of ops other replicas haven't seen yet.
 */
function makeClient(id, clock) {
  const doc = new RGA(id);
  const oplog = new OpLog(id);
  const outbound = [];

  const publish = (ops) => {
    oplog.appendMany(ops, { local: true });
    outbound.push(...ops);
  };

  const undo = new UndoManager({ doc, onOps: publish, now: clock });

  return {
    id,
    doc,
    oplog,
    undo,
    outbound,
    /** A local edit: apply, log, and make undoable — exactly as the UI does. */
    type(index, text) {
      const ops = doc.localInsertText(index, text);
      publish(ops);
      undo.record(ops);
      return ops;
    },
    erase(index, count) {
      const ops = doc.localDeleteRange(index, count).filter(Boolean);
      publish(ops);
      undo.record(ops);
      return ops;
    },
    receive(ops) {
      doc.applyMany(ops);
      oplog.appendMany(ops, { local: false });
    },
    text() {
      return doc.toString();
    },
  };
}

/** Clock that only advances when a test says so, to control coalescing. */
function manualClock(start = 0) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => {
    t += ms;
  };
  return fn;
}

function sync(a, b) {
  const fromA = a.outbound.splice(0);
  const fromB = b.outbound.splice(0);
  b.receive(fromA);
  a.receive(fromB);
}

// ------------------------------------------------------------ basic shape ---

test('undo removes an insert, redo puts it back', () => {
  const c = makeClient('A', manualClock());
  c.type(0, 'hello');
  assert.equal(c.text(), 'hello');

  c.undo.undo();
  assert.equal(c.text(), '');

  c.undo.redo();
  assert.equal(c.text(), 'hello');
});

test('undo restores a deletion, redo removes it again', () => {
  const c = makeClient('A', manualClock());
  c.type(0, 'hello world');
  const clock = manualClock();
  c.undo.now = clock;

  c.erase(5, 6);
  assert.equal(c.text(), 'hello');

  c.undo.undo();
  assert.equal(c.text(), 'hello world');

  c.undo.redo();
  assert.equal(c.text(), 'hello');
});

test('repeated undo walks back through separate steps', () => {
  const clock = manualClock();
  const c = makeClient('A', clock);
  c.type(0, 'one');
  clock.advance(5000);
  c.type(3, ' two');
  clock.advance(5000);
  c.type(7, ' three');

  assert.equal(c.text(), 'one two three');
  c.undo.undo();
  assert.equal(c.text(), 'one two');
  c.undo.undo();
  assert.equal(c.text(), 'one');
  c.undo.undo();
  assert.equal(c.text(), '');
  assert.equal(c.undo.canUndo, false);

  c.undo.redo();
  c.undo.redo();
  c.undo.redo();
  assert.equal(c.text(), 'one two three');
});

test('a new edit clears the redo branch', () => {
  const clock = manualClock();
  const c = makeClient('A', clock);
  c.type(0, 'abc');
  c.undo.undo();
  assert.equal(c.undo.canRedo, true);
  clock.advance(5000);
  c.type(0, 'z');
  assert.equal(c.undo.canRedo, false);
});

test('typing runs coalesce, but a pause starts a new step', () => {
  const clock = manualClock();
  const c = makeClient('A', clock);
  c.type(0, 'hello');
  clock.advance(5000);
  c.type(5, ' there');

  c.undo.undo();
  assert.equal(c.text(), 'hello', 'the second run should undo as one word');
  c.undo.undo();
  assert.equal(c.text(), '');
});

// ------------------------------------------- the part that actually matters ---

test('undo targets the right characters after a remote insert shifts positions', () => {
  // A types at the end; B then inserts *before* it, moving every index A used.
  // An index-based undo stack would now delete the wrong characters.
  const clock = manualClock();
  const a = makeClient('A', clock);
  const b = makeClient('B', manualClock());

  a.type(0, 'world');
  sync(a, b);

  clock.advance(5000);
  a.type(5, '!!!');
  b.type(0, '>>>>>>>>>> ');
  sync(a, b);

  assert.equal(a.text(), '>>>>>>>>>> world!!!');
  assert.equal(b.text(), a.text());

  a.undo.undo(); // should remove exactly "!!!"
  sync(a, b);

  assert.equal(a.text(), '>>>>>>>>>> world');
  assert.equal(b.text(), a.text());
});

test('undo still finds its target after a remote edit inside the undone run', () => {
  const clock = manualClock();
  const a = makeClient('A', clock);
  const b = makeClient('B', manualClock());

  a.type(0, 'abcdef');
  sync(a, b);

  clock.advance(5000);
  a.type(6, 'XYZ');
  sync(a, b);

  // B types in the middle of the run A is about to undo.
  b.type(7, '-');
  sync(a, b);
  assert.equal(a.text(), 'abcdefX-YZ');

  a.undo.undo();
  sync(a, b);

  // A's three characters go, B's survives — nobody's edit is silently lost.
  assert.equal(a.text(), 'abcdef-');
  assert.equal(b.text(), a.text());
});

test('undoing a delete does not resurrect text a peer also deleted', () => {
  const clock = manualClock();
  const a = makeClient('A', clock);
  const b = makeClient('B', manualClock());

  a.type(0, 'secret data');
  sync(a, b);

  // Both delete "secret " concurrently.
  a.erase(0, 7);
  b.erase(0, 7);
  sync(a, b);
  assert.equal(a.text(), 'data');
  assert.equal(b.text(), 'data');

  // A changes its mind. B's deletes are untouched, so the text stays gone.
  a.undo.undo();
  sync(a, b);
  assert.equal(a.text(), 'data', 'B never undid its delete');
  assert.equal(b.text(), a.text());

  // Once B undoes as well, every delete is cancelled and the text returns.
  b.undo.undo();
  sync(a, b);
  assert.equal(a.text(), 'secret data');
  assert.equal(b.text(), a.text());
});

test('you cannot undo a collaborator\'s edit', () => {
  const a = makeClient('A', manualClock());
  const b = makeClient('B', manualClock());

  b.type(0, 'from B');
  sync(a, b);
  assert.equal(a.text(), 'from B');
  assert.equal(a.undo.canUndo, false, 'remote ops must never enter the local undo stack');
  assert.equal(a.oplog.localOps().length, 0);
});

test('undo works while offline and merges correctly on reconnect', () => {
  const clock = manualClock();
  const a = makeClient('A', clock);
  const b = makeClient('B', manualClock());

  a.type(0, 'shared\n');
  sync(a, b);

  // A goes offline: it types, then undoes, all without talking to anyone.
  const offlineOps = [];
  clock.advance(5000);
  a.type(0, 'draft ');
  clock.advance(5000);
  a.type(6, 'MISTAKE');
  a.undo.undo();
  assert.equal(a.text(), 'draft shared\n');

  // Meanwhile B edits the shared text.
  b.type(b.doc.length, 'from B');

  // Reconnect. Both the edits and the undo replay as ordinary ops.
  offlineOps.push(...a.outbound.splice(0));
  b.receive(offlineOps);
  a.receive(b.outbound.splice(0));

  assert.equal(a.text(), b.text());
  assert.equal(JSON.stringify(a.doc.debugState()), JSON.stringify(b.doc.debugState()));
  assert.ok(!a.text().includes('MISTAKE'), 'the undone text must not reappear on merge');
  assert.ok(a.text().includes('draft shared'));
  assert.ok(a.text().includes('from B'));
});

test('interleaved undo/redo on two replicas still converges', () => {
  const clockA = manualClock();
  const clockB = manualClock();
  const a = makeClient('A', clockA);
  const b = makeClient('B', clockB);

  a.type(0, 'base\n');
  sync(a, b);

  for (let round = 0; round < 12; round += 1) {
    clockA.advance(5000);
    clockB.advance(5000);
    a.type(0, `a${round} `);
    b.type(b.doc.length, ` b${round}`);
    if (round % 3 === 0) sync(a, b);
    if (round % 2 === 0) a.undo.undo();
    if (round % 4 === 1) b.undo.undo();
    if (round % 5 === 2) a.undo.redo();
  }
  sync(a, b);
  sync(a, b);

  assert.equal(a.text(), b.text(), 'text diverged after interleaved undo/redo');
  assert.equal(
    JSON.stringify(a.doc.debugState()),
    JSON.stringify(b.doc.debugState()),
    'tombstone layout diverged after interleaved undo/redo',
  );
});

test('undo/redo cycled many times stays stable', () => {
  const clock = manualClock();
  const a = makeClient('A', clock);
  const b = makeClient('B', manualClock());
  a.type(0, 'toggle me');
  sync(a, b);

  for (let i = 0; i < 25; i += 1) {
    a.undo.undo();
    sync(a, b);
    assert.equal(a.text(), '', `cycle ${i}: undo failed`);
    assert.equal(b.text(), '', `cycle ${i}: peer disagreed after undo`);

    a.undo.redo();
    sync(a, b);
    assert.equal(a.text(), 'toggle me', `cycle ${i}: redo failed`);
    assert.equal(b.text(), 'toggle me', `cycle ${i}: peer disagreed after redo`);
  }
});
