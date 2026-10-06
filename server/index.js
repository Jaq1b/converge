/**
 * WebSocket relay + static file server.
 *
 * The relay is intentionally ignorant of CRDT semantics. It:
 *   - keeps an append-only list of opaque op blobs per room,
 *   - hands that list to whoever joins,
 *   - forwards new ops to everyone else in the room,
 *   - forwards presence messages without storing them.
 *
 * It never merges, orders, transforms, or interprets ops. With a CRDT the server
 * does not need to be smart, and keeping it dumb is what makes offline editing
 * work: a client that has been disconnected for ten minutes just replays its
 * backlog and everyone converges.
 *
 * What the server *does* take seriously is resource limits. Since it accepts
 * payloads it deliberately refuses to parse, every input is bounded: frame size,
 * message rate, ops per message, clients per room, and total rooms. Violations
 * close the offending connection rather than dropping messages silently, because
 * the client's reconnect path already replays anything unacknowledged, whereas a
 * silently dropped op would sit unnoticed in its outbox until the next reconnect.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Rooms } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const LIMITS = {
  /** Largest single frame accepted. `ws` closes the connection above this. */
  maxPayloadBytes: 1024 * 1024,
  /**
   * Sustained messages per second per connection, with burst headroom. The
   * client batches ops on a 20 ms timer (≈50/s) and presence on 80 ms (≈12/s),
   * so this sits comfortably above normal typing.
   */
  messagesPerSecond: 120,
  burstMessages: 240,
  /** Ops accepted in a single frame. */
  maxOpsPerMessage: 2000,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Only these directories are reachable over HTTP, so the server can't be talked
// into serving node_modules, .env, or a stray dotfile.
const SERVE_DIRS = ['client', 'crdt'];

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // 'unsafe-inline' for styles is required: peer colours and the caret overlay's
  // width are set as inline style attributes, which style-src governs.
  // connect-src allows ws:/wss: so the client can be hosted separately from the
  // relay via ?server=, without opening up arbitrary http origins.
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function resolveStatic(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // Malformed percent-encoding.
  }
  if (clean.includes('\0')) return null;

  const rel = clean === '/' ? 'client/index.html' : clean.replace(/^\/+/, '');

  // Try the path as written, then inside client/. The index page is served at
  // `/`, so its relative asset links resolve to `/main.js`; falling back to
  // client/ makes those work without hard-coding absolute paths into the HTML.
  for (const candidate of [rel, path.join('client', rel)]) {
    const abs = path.resolve(ROOT, candidate);
    // Resolve first, then check: this rejects `..` traversal after
    // normalisation rather than trying to pattern-match it beforehand.
    const allowed = SERVE_DIRS.some((dir) => abs.startsWith(path.join(ROOT, dir) + path.sep));
    if (!allowed) continue;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

function sanitizeRoom(value) {
  const cleaned = String(value ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 40);
  return cleaned || 'demo';
}

/** Token bucket, refilled continuously. Cheap enough to run per message. */
function createRateLimiter({ messagesPerSecond, burstMessages }) {
  let tokens = burstMessages;
  let last = Date.now();
  return function allow() {
    const now = Date.now();
    tokens = Math.min(burstMessages, tokens + ((now - last) / 1000) * messagesPerSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/**
 * Build a relay without starting it. Returned as a factory rather than as
 * module-level side effects so tests can run a throwaway server on an ephemeral
 * port, with tightened limits, and shut it down cleanly.
 */
export function createRelay({ heartbeatMs = 30_000, roomOptions, limits } = {}) {
  const config = { ...LIMITS, ...limits };
  const rooms = new Rooms(roomOptions);

  const httpServer = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', ...SECURITY_HEADERS });
      res.end();
      return;
    }

    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ ok: true, ...rooms.stats() }));
      return;
    }

    const file = resolveStatic(req.url);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('not found');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      ...SECURITY_HEADERS,
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: config.maxPayloadBytes });

  const send = (ws, payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  const broadcast = (roomName, payload, except) => {
    const message = JSON.stringify(payload);
    for (const member of rooms.members(roomName)) {
      if (member.ws !== except && member.ws.readyState === member.ws.OPEN) {
        member.ws.send(message);
      }
    }
  };

  const peerList = (roomName) =>
    [...rooms.members(roomName)].map((m) => ({ replica: m.replica }));

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const roomName = sanitizeRoom(url.searchParams.get('room'));
    const replica = String(url.searchParams.get('replica') ?? '').slice(0, 32) || 'anon';

    // Attached before anything that can reject the connection: an unhandled
    // 'error' event on a socket throws, which would take the whole relay down.
    ws.on('error', () => ws.terminate());

    const member = { ws, replica, room: roomName };
    if (!rooms.join(roomName, member)) {
      // 1013 "try again later": the room or the server is at capacity. The
      // client's backoff will retry, and its outbox is untouched.
      ws.close(1013, 'at capacity');
      return;
    }

    const allow = createRateLimiter(config);

    // The backlog is the entire document: a joining client replays it through
    // its own CRDT and lands on exactly the same state as everyone else.
    send(ws, {
      type: 'welcome',
      room: roomName,
      replica,
      ops: rooms.history(roomName),
      peers: peerList(roomName),
      // Advertise the batch cap rather than making clients guess it. A client
      // returning from a long offline session can hold more ops than fit in one
      // frame, and a client that has to guess will either under-fill every frame
      // or have its backlog silently truncated.
      limits: { maxOpsPerMessage: config.maxOpsPerMessage },
    });
    broadcast(roomName, { type: 'peers', peers: peerList(roomName) }, null);

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      if (!allow()) {
        // 1008 "policy violation". Closing rather than dropping is deliberate:
        // the client resends everything unacknowledged on reconnect, so nothing
        // is lost, whereas a dropped frame would strand ops in its outbox.
        ws.close(1008, 'rate limit');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return; // Malformed frame: drop it, never crash the relay.
      }
      if (msg === null || typeof msg !== 'object') return;

      if (msg.type === 'ops' && Array.isArray(msg.ops)) {
        const batch = msg.ops.slice(0, config.maxOpsPerMessage);
        const { fresh, accepted } = rooms.record(roomName, batch);
        if (fresh.length > 0) {
          broadcast(roomName, { type: 'ops', ops: fresh, from: replica }, ws);
        }
        // Acknowledge only what the server actually holds, so anything truncated
        // past the batch cap or rejected as malformed stays in the sender's
        // outbox and is retried on its next reconnect.
        send(ws, { type: 'ack', ids: accepted.map((op) => op.id) });
        return;
      }

      if (msg.type === 'presence') {
        // Cursor positions are ephemeral: relayed, never stored, never replayed.
        broadcast(roomName, { type: 'presence', replica, cursor: msg.cursor ?? null }, ws);
      }
    });

    ws.on('close', () => {
      rooms.leave(roomName, member);
      broadcast(roomName, { type: 'peers', peers: peerList(roomName) }, null);
      broadcast(roomName, { type: 'peer-left', replica }, null);
    });
  });

  // Drop connections that stopped responding, so peer lists don't fill with
  // ghosts after a laptop lid closes.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    httpServer,
    wss,
    rooms,
    limits: config,

    listen(port) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => resolve(httpServer.address().port));
      });
    },

    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => {
        wss.close(() => httpServer.close(resolve));
      });
    },
  };
}

// Only listen when run as a program, so importing this module (from a test, or
// to embed the relay elsewhere) has no side effects.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const relay = createRelay();

  relay.listen(port).then(
    (actual) => console.log(`converge relay listening on http://localhost:${actual}`),
    (err) => {
      console.error(`failed to bind port ${port}: ${err.message}`);
      process.exit(1);
    },
  );

  // Platforms like Render and Fly send SIGTERM and then SIGKILL a short time
  // later. Closing sockets deliberately means clients see a clean close and
  // reconnect on their own schedule instead of hanging until a timeout.
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received, shutting down`);
      const forced = setTimeout(() => process.exit(1), 5000);
      forced.unref?.();
      relay.close().then(() => process.exit(0));
    });
  }

  // A relay that dies on an unexpected throw takes every session with it.
  process.on('uncaughtException', (err) => console.error('uncaught exception:', err));
  process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));
}
