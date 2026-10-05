/**
 * WebSocket transport: offline detection, reconnect with backoff, and replay.
 *
 * The reconnect story is deliberately boring, which is the payoff of using a
 * CRDT. There is no session resumption, no "since sequence number" cursor, no
 * server-side merge:
 *
 *   on connect  -> the server sends the room's whole op log; we apply all of it
 *                  (idempotent, so already-known ops cost nothing)
 *   on connect  -> we re-send every op the server never acked
 *
 * Those two lines are the entire offline-sync algorithm. It is correct no
 * matter how long the client was away, how many ops it missed, whether the
 * disconnect happened mid-send, or whether ops get delivered twice.
 */

const FLUSH_INTERVAL_MS = 20; // Coalesce keystrokes into one frame.
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

const opKey = (id) => `${id.counter}:${id.replica}`;

export const Status = {
  CONNECTING: 'connecting',
  ONLINE: 'online',
  OFFLINE: 'offline',
};

/** Where the relay lives. Lets the client be hosted separately from the server. */
function resolveServerUrl(room, replica) {
  const override =
    new URLSearchParams(location.search).get('server') || window.CONVERGE_SERVER || null;

  const base = override
    ? override.replace(/^http/, 'ws').replace(/\/+$/, '')
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

  return `${base}/?room=${encodeURIComponent(room)}&replica=${encodeURIComponent(replica)}`;
}

export class Connection {
  /**
   * @param {object} options
   * @param {string} options.room
   * @param {string} options.replica
   * @param {import('./crdt/oplog.js').OpLog} options.oplog
   * @param {(ops: object[]) => void} options.onOps      remote ops to apply
   * @param {(status: string) => void} options.onStatus
   * @param {(peers: object[]) => void} options.onPeers
   * @param {(msg: object) => void} options.onPresence
   */
  constructor({ room, replica, oplog, onOps, onStatus, onPeers, onPresence }) {
    this.room = room;
    this.replica = replica;
    this.oplog = oplog;
    this.onOps = onOps ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onPeers = onPeers ?? (() => {});
    this.onPresence = onPresence ?? (() => {});

    this.ws = null;
    /**
     * Ops already written to the *current* socket. The outbox can't be cleared
     * until the server acks, but there's no point re-sending on every 20 ms
     * flush while we wait — that turns a slow link into quadratic traffic.
     * Cleared on every new connection, so a reconnect resends everything
     * unacked, which is exactly the recovery behaviour we want.
     */
    this.inflight = new Set();
    /**
     * Ops per frame. The server advertises its own cap in the welcome message
     * and anything beyond it is truncated and left unacknowledged, so an outbox
     * larger than one frame has to be sent in slices. Starts conservative and is
     * replaced by the server's real figure on connect.
     */
    this.maxOpsPerMessage = 500;
    this.status = Status.CONNECTING;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.flushTimer = null;
    /** Demo switch: pretend the network is gone without touching devtools. */
    this.simulatedOffline = false;
    this.destroyed = false;

    // The browser's own signal, so pulling the wifi behaves like the button.
    window.addEventListener('online', () => this.#onBrowserOnline());
    window.addEventListener('offline', () => this.#setStatus(Status.OFFLINE));
  }

  // ------------------------------------------------------------ lifecycle ---

  connect() {
    if (this.destroyed || this.simulatedOffline) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.#setStatus(Status.CONNECTING);
    let socket;
    try {
      socket = new WebSocket(resolveServerUrl(this.room, this.replica));
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.inflight.clear();
      this.#setStatus(Status.ONLINE);
      // The backlog is not sent here but on `welcome`, so that it goes out in
      // frames the server has said it will accept.
    });

    socket.addEventListener('message', (event) => this.#handleMessage(event));

    socket.addEventListener('close', () => {
      if (this.ws === socket) this.ws = null;
      if (this.destroyed || this.simulatedOffline) return;
      this.#setStatus(Status.OFFLINE);
      this.#scheduleReconnect();
    });

    socket.addEventListener('error', () => socket.close());
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.flushTimer);
    this.ws?.close();
  }

  #handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'welcome':
        if (msg.limits?.maxOpsPerMessage > 0) {
          this.maxOpsPerMessage = msg.limits.maxOpsPerMessage;
        }
        // The full room history. Applying it is how a fresh tab — or a client
        // that was offline for an hour — catches up.
        if (msg.ops?.length) this.onOps(msg.ops);
        if (msg.peers) this.onPeers(msg.peers);
        // Everything the server never confirmed goes back out. Duplicates are
        // free, so we never have to reason about what did or didn't arrive.
        this.#flushOutbox();
        break;
      case 'ops':
        this.onOps(msg.ops ?? []);
        break;
      case 'ack':
        this.oplog.ack(msg.ids ?? []);
        for (const id of msg.ids ?? []) this.inflight.delete(opKey(id));
        this.onStatus(this.status);
        break;
      case 'peers':
        this.onPeers(msg.peers ?? []);
        break;
      case 'presence':
      case 'peer-left':
        this.onPresence(msg);
        break;
      default:
        break;
    }
  }

  #scheduleReconnect() {
    if (this.destroyed || this.simulatedOffline) return;
    clearTimeout(this.reconnectTimer);
    // Exponential backoff with jitter, so a server restart doesn't get
    // hammered by every client reconnecting on the same tick.
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.attempt, MAX_BACKOFF_MS);
    const jittered = delay * (0.7 + Math.random() * 0.6);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), jittered);
  }

  #onBrowserOnline() {
    if (this.simulatedOffline) return;
    this.attempt = 0;
    this.connect();
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  get isOnline() {
    return this.status === Status.ONLINE && this.ws?.readyState === WebSocket.OPEN;
  }

  // -------------------------------------------------------------- sending ---

  /**
   * Queue local ops for delivery. They are already in the oplog outbox, so this
   * is only about *when* bytes go out — if the send fails or never happens, the
   * outbox still has them and the next connect will replay them.
   */
  send() {
    if (!this.isOnline) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.#flushOutbox(), FLUSH_INTERVAL_MS);
  }

  #flushOutbox() {
    if (!this.isOnline) return;
    const ops = this.oplog.pending().filter((op) => !this.inflight.has(opKey(op.id)));
    if (ops.length === 0) return;

    // Sliced to the server's advertised cap: a frame carrying more than that has
    // its tail truncated and left unacknowledged, which would strand those ops
    // in the outbox until some later reconnect.
    for (let i = 0; i < ops.length; i += this.maxOpsPerMessage) {
      const batch = ops.slice(i, i + this.maxOpsPerMessage);
      for (const op of batch) this.inflight.add(opKey(op.id));
      this.ws.send(JSON.stringify({ type: 'ops', ops: batch }));
    }
  }

  sendPresence(cursor) {
    if (!this.isOnline) return;
    this.ws.send(JSON.stringify({ type: 'presence', cursor }));
  }

  // ----------------------------------------------------------- demo toggle ---

  /**
   * Simulate losing the network. Edits keep working and pile up in the outbox;
   * flipping back replays them and merges with whatever changed meanwhile.
   */
  setSimulatedOffline(offline) {
    this.simulatedOffline = offline;
    if (offline) {
      clearTimeout(this.reconnectTimer);
      this.#setStatus(Status.OFFLINE);
      this.ws?.close();
      this.ws = null;
    } else {
      this.attempt = 0;
      this.connect();
    }
  }
}
