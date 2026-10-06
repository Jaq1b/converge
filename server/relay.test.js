/**
 * End-to-end tests through the real WebSocket relay.
 *
 * The tests in crdt/rga.test.js prove the *algorithm* converges. These prove the
 * *system* does: real sockets, real JSON serialisation, real late joiners, real
 * disconnects. Every client here drives the same RGA and OpLog the browser does,
 * so the only thing not exercised is the DOM wiring.
 *
 * Each test gets its own throwaway relay on an ephemeral port, so tests can't
 * leak room state into each other and nothing depends on port 8080 being free.
 */

import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { RGA } from '../crdt/rga.js';
import { OpLog } from '../crdt/oplog.js';
import { createRelay } from './index.js';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// -------------------------------------------------------------- harness ---

/** Start a relay, run the body against it, and always shut it down. */
async function withRelay(body, options = {}) {
  const relay = createRelay({ heartbeatMs: 60_000, ...options });
  const port = await relay.listen(0);
  try {
    return await body({ port, relay });
  } finally {
    await relay.close();
  }
}

/**
 * Poll until `predicate` holds. Used instead of fixed sleeps so the tests are
 * neither flaky on a slow machine nor artificially slow on a fast one.
 */
async function waitFor(predicate, { timeout = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A client with exactly the plumbing client/main.js has: a document, an op log
 * with an outbox, and the same tiny wire protocol.
 */
function makeClient(port, room, id) {
  const doc = new RGA(id);
  const oplog = new OpLog(id);
  const client = { id, doc, oplog, ws: null, connected: false, presence: [] };

  client.connect = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=${room}&replica=${id}`);
      client.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${id} could not connect`)), 3000);

      ws.on('open', () => {
        client.connected = true;
      });

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        switch (msg.type) {
          case 'welcome':
            // Mirror the real client: honour the advertised batch cap, then send
            // the backlog once the limits are known.
            if (msg.limits?.maxOpsPerMessage > 0) {
              client.maxOpsPerMessage = msg.limits.maxOpsPerMessage;
            }
            // Applying the room history is how a joiner — or a client that has
            // been away — catches up. Idempotent, so duplicates are free.
            doc.applyMany(msg.ops ?? []);
            oplog.appendMany(msg.ops ?? [], { local: false });
            client.flush();
            clearTimeout(timer);
            resolve();
            break;
          case 'ops':
            doc.applyMany(msg.ops);
            oplog.appendMany(msg.ops, { local: false });
            break;
          case 'ack':
            oplog.ack(msg.ids);
            break;
          case 'presence':
            client.presence.push(msg);
            break;
          default:
            break;
        }
      });

      ws.on('close', () => {
        client.connected = false;
      });
      ws.on('error', () => {});
    });

  client.maxOpsPerMessage = 500;

  client.flush = () => {
    if (!client.connected) return;
    const ops = oplog.pending();
    for (let i = 0; i < ops.length; i += client.maxOpsPerMessage) {
      const batch = ops.slice(i, i + client.maxOpsPerMessage);
      client.ws.send(JSON.stringify({ type: 'ops', ops: batch }));
    }
  };

  /** Deliberately ignore the advertised cap, to test server-side truncation. */
  client.flushOverlarge = () => {
    const ops = oplog.pending();
    if (ops.length > 0) client.ws.send(JSON.stringify({ type: 'ops', ops }));
  };

  /** Edit locally without sending, as if offline. */
  client.typeLocal = (index, text) => {
    const ops = doc.localInsertText(index, text);
    oplog.appendMany(ops, { local: true });
    return ops;
  };

  client.type = (index, text) => {
    const ops = client.typeLocal(index, text);
    client.flush();
    return ops;
  };

  client.erase = (index, count) => {
    const ops = doc.localDeleteRange(index, count).filter(Boolean);
    oplog.appendMany(ops, { local: true });
    client.flush();
    return ops;
  };

  client.disconnect = async () => {
    client.ws.close();
    await waitFor(() => !client.connected, { label: `${id} to disconnect` });
  };

  /** Connect without asserting success, for tests that expect a rejection. */
  client.tryConnect = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=${room}&replica=${id}`);
      client.ws = ws;
      ws.on('open', () => {
        client.connected = true;
      });
      ws.on('close', (code) => {
        client.connected = false;
        resolve({ accepted: false, code });
      });
      ws.on('message', (raw) => {
        if (JSON.parse(raw).type === 'welcome') resolve({ accepted: true });
      });
      ws.on('error', () => {});
    });

  client.text = () => doc.toString();
  client.snapshot = () => JSON.stringify(doc.debugState());
  return client;
}

const room = (name) => `${name}-${Math.random().toString(36).slice(2, 8)}`;

/** Wait until every client agrees, then assert tombstone layouts match too. */
async function waitForConvergence(clients, label, timeout = 3000) {
  await waitFor(() => clients.every((c) => c.text() === clients[0].text()), {
    timeout,
    label: `${label} (texts: ${clients.map((c) => JSON.stringify(c.text())).join(' vs ')})`,
  });
  for (const c of clients.slice(1)) {
    assert.equal(c.snapshot(), clients[0].snapshot(), `${label}: tombstone layout diverged`);
    assert.equal(c.doc.pendingCount, 0, `${label}: ${c.id} left ops buffered`);
  }
}

// ---------------------------------------------------------------- tests ---

test('two clients converge on concurrent inserts through the relay', () =>
  withRelay(async ({ port }) => {
    const r = room('concurrent');
    const a = makeClient(port, r, 'aaa');
    const b = makeClient(port, r, 'bbb');
    await a.connect();
    await b.connect();

    // Both type at position 0 with no knowledge of each other.
    a.type(0, 'Hello ');
    b.type(0, 'World');

    await waitForConvergence([a, b], 'concurrent inserts');
    assert.ok(a.text().includes('Hello'), 'A\'s text survived');
    assert.ok(a.text().includes('World'), 'B\'s text survived');
    assert.equal(a.text().length, 11, 'no characters lost or duplicated');
  }));

test('a late joiner replays room history to identical state', () =>
  withRelay(async ({ port }) => {
    const r = room('late');
    const a = makeClient(port, r, 'aaa');
    await a.connect();
    a.type(0, 'written before you arrived');
    a.erase(0, 8);
    await waitFor(() => a.oplog.pendingCount === 0, { label: 'acks' });

    const late = makeClient(port, r, 'zzz');
    await late.connect();

    await waitForConvergence([a, late], 'late joiner');
    assert.equal(late.text(), 'before you arrived');
    // Tombstones are part of convergence: the joiner must reconstruct them too,
    // or its next insert could land in a different place than everyone else's.
    assert.equal(late.doc.nodes.length, a.doc.nodes.length);
  }));

test('presence is relayed live but never replayed to joiners', () =>
  withRelay(async ({ port }) => {
    const r = room('presence');
    const a = makeClient(port, r, 'aaa');
    const b = makeClient(port, r, 'bbb');
    await a.connect();
    await b.connect();
    a.type(0, 'abc');
    await waitForConvergence([a, b], 'presence setup');

    a.ws.send(JSON.stringify({ type: 'presence', cursor: { id: a.doc.idAt(1) } }));
    await waitFor(() => b.presence.length > 0, { label: 'presence delivery' });
    assert.equal(b.presence[0].replica, 'aaa');

    // A joiner gets the op log, not a cursor backlog: presence is ephemeral and
    // deliberately outside the CRDT.
    const late = makeClient(port, r, 'ccc');
    await late.connect();
    await waitForConvergence([a, b, late], 'presence joiner');
    assert.equal(late.presence.length, 0);
  }));

test('ops written offline queue up and merge on reconnect', () =>
  withRelay(async ({ port }) => {
    const r = room('offline');
    const a = makeClient(port, r, 'aaa');
    const b = makeClient(port, r, 'bbb');
    await a.connect();
    await b.connect();

    a.type(0, 'shared text\n');
    await waitForConvergence([a, b], 'offline setup');

    await b.disconnect();

    // B keeps editing with nowhere to send. Its ops sit in the outbox.
    const offlineOps = b.type(0, '[offline] ');
    assert.equal(b.oplog.pendingCount, offlineOps.length, 'ops queued while offline');
    assert.ok(!a.text().includes('[offline]'), 'A cannot have seen them yet');

    // A edits the same document, including where B was typing.
    a.type(a.doc.length, 'A kept working\n');
    a.erase(0, 1);
    await waitFor(() => a.oplog.pendingCount === 0, { label: 'A acks' });

    await b.connect();

    await waitForConvergence([a, b], 'offline merge');
    await waitFor(() => b.oplog.pendingCount === 0, { label: 'B outbox drained' });
    assert.ok(a.text().includes('[offline]'), 'B\'s offline edits reached A');
    assert.ok(a.text().includes('A kept working'), 'A\'s edits survived the merge');
  }));

test('a client that reconnects repeatedly never duplicates its ops', () =>
  withRelay(async ({ port }) => {
    const r = room('flap');
    const a = makeClient(port, r, 'aaa');
    const b = makeClient(port, r, 'bbb');
    await a.connect();
    await b.connect();
    a.type(0, 'stable');
    await waitForConvergence([a, b], 'flap setup');

    // Disconnect, edit, reconnect, three times over. Because ops are idempotent
    // and acks are matched by id, replaying the outbox can't double-insert.
    for (let i = 0; i < 3; i += 1) {
      await b.disconnect();
      b.type(b.doc.length, `-${i}`);
      await b.connect();
      await waitForConvergence([a, b], `flap round ${i}`);
    }

    assert.equal(a.text(), 'stable-0-1-2');
    assert.equal(a.doc.length, 'stable-0-1-2'.length, 'no duplicated characters');
  }));

test('heavy concurrent typing across three clients converges', () =>
  withRelay(async ({ port }) => {
    const r = room('heavy');
    const clients = [
      makeClient(port, r, 'aaa'),
      makeClient(port, r, 'bbb'),
      makeClient(port, r, 'ccc'),
    ];
    for (const c of clients) await c.connect();

    clients[0].type(0, 'seed\n');
    await waitForConvergence(clients, 'heavy setup');

    // 150 inserts at random positions, with no synchronisation between clients.
    for (let i = 0; i < 50; i += 1) {
      for (const c of clients) {
        c.type(Math.floor(Math.random() * (c.doc.length + 1)), c.id[0].toUpperCase());
      }
    }

    await waitForConvergence(clients, 'heavy concurrent typing', 8000);
    assert.equal(clients[0].doc.length, 155);
  }));

test('the relay survives malformed and unknown frames', () =>
  withRelay(async ({ port }) => {
    const r = room('junk');
    const a = makeClient(port, r, 'aaa');
    const b = makeClient(port, r, 'bbb');
    await a.connect();
    await b.connect();

    // A dumb relay must not be crashable by a bad client, since it has no way
    // to validate payloads it deliberately doesn't understand.
    a.ws.send('not json at all');
    a.ws.send(JSON.stringify({ type: 'ops', ops: 'not-an-array' }));
    a.ws.send(JSON.stringify({ type: 'ops', ops: [{ nonsense: true }] }));
    a.ws.send(JSON.stringify({ type: 'totally-unknown' }));

    a.type(0, 'still working');
    await waitForConvergence([a, b], 'after malformed frames');
    assert.equal(b.text(), 'still working');
  }));

// ------------------------------------------------------ resource limits ---

test('a room at capacity rejects further clients instead of growing', () =>
  withRelay(
    async ({ port }) => {
      const r = room('capacity');
      const a = makeClient(port, r, 'aaa');
      const b = makeClient(port, r, 'bbb');
      await a.connect();
      await b.connect();

      const third = makeClient(port, r, 'ccc');
      const outcome = await third.tryConnect();
      assert.equal(outcome.accepted, false, 'the third client should be turned away');
      // 1013 "try again later" tells the client to back off and retry rather
      // than treat this as a permanent failure.
      assert.equal(outcome.code, 1013);

      // The rejection must not disturb the members already in the room.
      a.type(0, 'still here');
      await waitForConvergence([a, b], 'after a rejected join');
    },
    { roomOptions: { maxClientsPerRoom: 2 } },
  ));

test('the server stops creating rooms once the room cap is reached', () =>
  withRelay(
    async ({ port }) => {
      const first = makeClient(port, room('cap-one'), 'aaa');
      await first.connect();

      const second = makeClient(port, room('cap-two'), 'bbb');
      const outcome = await second.tryConnect();
      assert.equal(outcome.accepted, false);
      assert.equal(outcome.code, 1013);
      assert.equal(first.connected, true, 'the existing room is unaffected');
    },
    { roomOptions: { maxRooms: 1 } },
  ));

test('a client exceeding the message rate limit is closed and recovers on reconnect', () =>
  withRelay(
    async ({ port }) => {
      const r = room('ratelimit');
      const a = makeClient(port, r, 'aaa');
      const b = makeClient(port, r, 'bbb');
      await a.connect();
      await b.connect();

      // Far more frames than the bucket allows, in one tick.
      for (let i = 0; i < 40; i += 1) {
        a.ws.send(JSON.stringify({ type: 'presence', cursor: null }));
      }
      await waitFor(() => !a.connected, { label: 'the flooding client to be closed' });

      // The victim of the limit is the only one affected.
      assert.equal(b.connected, true, 'other clients keep their connections');
      b.type(0, 'unaffected');

      // And it recovers by itself: reconnecting replays the outbox, so the ops
      // it had queued before being cut off are not lost.
      a.type(0, 'queued before the cut');
      assert.ok(a.oplog.pendingCount > 0);
      await a.connect();
      await waitForConvergence([a, b], 'after rate-limit recovery');
      await waitFor(() => a.oplog.pendingCount === 0, { label: 'outbox drained' });
      assert.ok(b.text().includes('queued before the cut'));
    },
    { limits: { messagesPerSecond: 1, burstMessages: 5 } },
  ));

test('an oversized frame closes only the sender', () =>
  withRelay(
    async ({ port }) => {
      const r = room('oversize');
      const a = makeClient(port, r, 'aaa');
      const b = makeClient(port, r, 'bbb');
      await a.connect();
      await b.connect();

      a.ws.send(JSON.stringify({ type: 'presence', cursor: 'x'.repeat(32_768) }));
      await waitFor(() => !a.connected, { label: 'the oversized sender to be closed' });

      assert.equal(b.connected, true, 'other clients keep their connections');
      b.type(0, 'ok');
      await waitFor(() => b.oplog.pendingCount === 0, { label: 'b still acked' });
    },
    { limits: { maxPayloadBytes: 8192 } },
  ));

test('a client honouring the advertised op cap delivers its whole backlog', () =>
  withRelay(
    async ({ port }) => {
      const r = room('batchcap');
      const a = makeClient(port, r, 'aaa');
      await a.connect();
      assert.equal(a.maxOpsPerMessage, 4, 'the cap should be learned from the welcome message');

      // Ten ops against a cap of four: three frames, nothing stranded.
      a.type(0, 'abcdefghij');
      await waitFor(() => a.oplog.pendingCount === 0, { label: 'the whole backlog to be acked' });

      const late = makeClient(port, r, 'zzz');
      await late.connect();
      assert.equal(late.text(), 'abcdefghij', 'every op reached the room log');
    },
    { limits: { maxOpsPerMessage: 4 } },
  ));

test('ops past the per-message cap are truncated and left unacknowledged', () =>
  withRelay(
    async ({ port }) => {
      const r = room('truncate');
      const a = makeClient(port, r, 'aaa');
      await a.connect();

      // A client that ignores the advertised cap must not be told its whole
      // batch was stored, or it would clear ops the server never kept.
      a.typeLocal(0, 'abcdefghij');
      a.flushOverlarge();

      await waitFor(() => a.oplog.pendingCount === 6, {
        label: 'exactly the 4 stored ops to be acknowledged',
      });
      assert.equal(a.oplog.pendingCount, 6, 'the truncated remainder stays queued for retry');
    },
    { limits: { maxOpsPerMessage: 4 } },
  ));

test('malformed ops are never stored or acknowledged', () =>
  withRelay(async ({ port }) => {
    const r = room('malformed');
    const a = makeClient(port, r, 'aaa');
    await a.connect();

    a.ws.send(
      JSON.stringify({
        type: 'ops',
        ops: [{ id: null }, { id: { counter: 'not-a-number', replica: 'x' } }, { nope: 1 }],
      }),
    );

    const late = makeClient(port, r, 'zzz');
    await late.connect();
    assert.equal(late.doc.nodes.length, 0, 'nothing malformed reached the room log');
    assert.equal(a.connected, true, 'and the sender is not punished for it');
  }));

test('rooms are isolated from each other', () =>
  withRelay(async ({ port }) => {
    const one = makeClient(port, room('iso-one'), 'aaa');
    const two = makeClient(port, room('iso-two'), 'bbb');
    await one.connect();
    await two.connect();

    one.type(0, 'room one only');
    await waitFor(() => one.oplog.pendingCount === 0, { label: 'acks' });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(two.text(), '', 'ops must not leak between rooms');
  }));
