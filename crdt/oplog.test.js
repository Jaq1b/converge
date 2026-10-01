/**
 * Tests for the local op log — specifically the outbox behaviour that offline
 * editing depends on.
 */

import assert from 'node:assert/strict';
import { RGA } from './rga.js';
import { OpLog } from './oplog.js';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function localEdit(doc, log, index, text) {
  const ops = doc.localInsertText(index, text);
  log.appendMany(ops, { local: true });
  return ops;
}

test('records local ops and exposes them in authoring order', () => {
  const doc = new RGA('A');
  const log = new OpLog('A');
  localEdit(doc, log, 0, 'abc');
  assert.deepEqual(
    log.localOps().map((op) => op.ch),
    ['a', 'b', 'c'],
  );
});

test('remote ops are logged but never queued for sending', () => {
  const remote = new RGA('B');
  const remoteOps = remote.localInsertText(0, 'hi');

  const doc = new RGA('A');
  const log = new OpLog('A');
  doc.applyMany(remoteOps);
  log.appendMany(remoteOps, { local: false });

  assert.equal(log.pendingCount, 0, 'relaying someone else\'s ops back is not our job');
  assert.equal(log.localOps().length, 0, 'remote ops must not be undoable locally');
  assert.equal(log.allOps().length, 2);
});

test('duplicate appends are ignored', () => {
  const doc = new RGA('A');
  const log = new OpLog('A');
  const ops = localEdit(doc, log, 0, 'ab');
  assert.equal(log.appendMany(ops, { local: true }), 0);
  assert.equal(log.pendingCount, 2);
});

test('acks clear the outbox by id, not by count', () => {
  const doc = new RGA('A');
  const log = new OpLog('A');
  const ops = localEdit(doc, log, 0, 'abcd');

  // Ack out of order and with a duplicate — both happen with a flaky socket.
  log.ack([ops[2].id, ops[0].id, ops[0].id]);
  assert.equal(log.pendingCount, 2);
  assert.deepEqual(
    log.pending().map((op) => op.ch),
    ['b', 'd'],
  );

  log.ack(ops.map((op) => op.id));
  assert.equal(log.pendingCount, 0);
});

test('acks for unknown ops do not disturb the outbox', () => {
  const doc = new RGA('A');
  const log = new OpLog('A');
  localEdit(doc, log, 0, 'ab');
  log.ack([{ counter: 99, replica: 'Z' }]);
  assert.equal(log.pendingCount, 2);
});

test('an offline session replays its outbox and converges', () => {
  // Full offline round-trip using only the log's own API.
  const alice = new RGA('alice');
  const aliceLog = new OpLog('alice');
  const bob = new RGA('bob');
  const bobLog = new OpLog('bob');

  const shared = localEdit(alice, aliceLog, 0, 'shared\n');
  aliceLog.ack(shared.map((o) => o.id));
  bob.applyMany(shared);
  bobLog.appendMany(shared, { local: false });

  // Alice drops offline: her ops pile up in the outbox, unacked.
  const offlineOps = localEdit(alice, aliceLog, 0, 'offline ');
  assert.equal(aliceLog.pendingCount, offlineOps.length);

  // Bob keeps working, and the server records his ops.
  const bobOps = localEdit(bob, bobLog, bob.length, 'bob was here');
  bobLog.ack(bobOps.map((o) => o.id));

  // Alice reconnects: she receives the room history and flushes her outbox.
  const serverHistory = [...shared, ...bobOps];
  alice.applyMany(serverHistory);
  aliceLog.appendMany(serverHistory, { local: false });

  const flushed = aliceLog.pending();
  bob.applyMany(flushed);
  aliceLog.ack(flushed.map((o) => o.id));

  assert.equal(aliceLog.pendingCount, 0);
  assert.equal(alice.toString(), bob.toString());
  assert.equal(JSON.stringify(alice.debugState()), JSON.stringify(bob.debugState()));
  assert.ok(alice.toString().startsWith('offline shared'));
});

test('replaying the whole log into a fresh replica reproduces the document', () => {
  const doc = new RGA('A');
  const log = new OpLog('A');
  localEdit(doc, log, 0, 'hello world');
  const del = doc.localDeleteRange(5, 6);
  log.appendMany(del, { local: true });

  const rebuilt = new RGA('rebuild');
  rebuilt.applyMany(log.allOps());
  assert.equal(rebuilt.toString(), doc.toString());
  assert.equal(JSON.stringify(rebuilt.debugState()), JSON.stringify(doc.debugState()));
});
