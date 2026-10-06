/**
 * Wires the textarea to the CRDT, the network, and the undo stack.
 *
 * The textarea is a dumb rendering surface: it never holds authoritative
 * state. On every `input` event we diff the DOM value against the last text we
 * rendered, translate that diff into CRDT ops, and re-render from the CRDT.
 * That keeps exactly one source of truth, so a remote op arriving mid-keystroke
 * can never be clobbered by stale textarea contents.
 *
 * Everything positional in here — the caret, remote carets, undo — is resolved
 * through op ids. Offsets are computed at the last possible moment, only to
 * talk to the DOM, and never stored or sent.
 */

import { RGA } from '../crdt/rga.js';
import { OpLog } from '../crdt/oplog.js';
import { Connection, Status } from './connection.js';
import { UndoManager } from './undo.js';

// -------------------------------------------------------------- text diff ---

/**
 * Reduce two versions of the text to a single replaced region.
 *
 * A textarea `input` event can only ever produce one contiguous change (typing,
 * pasting, selecting-and-replacing, backspace), so a common-prefix /
 * common-suffix scan recovers it exactly, in O(n), with no diff library.
 * Returns null when nothing changed.
 */
export function diffText(oldStr, newStr) {
  if (oldStr === newStr) return null;

  let start = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (start < minLen && oldStr[start] === newStr[start]) start += 1;

  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  return { index: start, removed: oldEnd - start, inserted: newStr.slice(start, newEnd) };
}

// ------------------------------------------------------------- identities ---

/**
 * Muted, dark-enough-to-read-on-paper hues. Deliberately desaturated to sit
 * inside the ink-on-paper palette instead of fighting it, while staying
 * distinguishable from each other at 9px.
 */
const PEER_COLORS = [
  '#25506e',
  '#2f6b4f',
  '#9a5b18',
  '#8c3a52',
  '#55507f',
  '#1f6b6b',
  '#8a4a2a',
  '#5c6327',
];

/** Deterministic colour per replica, so every tab agrees on who is what colour. */
export function colorFor(replicaId) {
  let hash = 0;
  for (let i = 0; i < replicaId.length; i += 1) {
    hash = (hash * 31 + replicaId.charCodeAt(i)) >>> 0;
  }
  return PEER_COLORS[hash % PEER_COLORS.length];
}

function randomId(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const randomReplicaId = () => randomId(6);

/* Longer than a replica id: a room name is a capability, so it should not be
   guessable by anyone poking at short strings. */
const randomRoomName = () => randomId(12);

function sanitizeRoom(value) {
  return String(value ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 40);
}

/** Keep other query params (`?server=` for split hosting) when the room changes. */
function writeRoomToUrl(room, { reload } = {}) {
  const params = new URLSearchParams(location.search);
  params.set('room', room);
  const next = `${location.pathname}?${params.toString()}${location.hash}`;
  if (reload) location.assign(next);
  else history.replaceState(null, '', next);
}

function roomFromUrl() {
  const asked = sanitizeRoom(new URLSearchParams(location.search).get('room'));
  if (asked) return asked;

  // Nobody asked for a room, so invent a private one. A shared default would
  // put every first-time visitor in the same document: two recruiters opening
  // the live demo at once would type over each other. Writing it back to the
  // address bar keeps the URL copyable, so a second tab can still join.
  const fresh = randomRoomName();
  writeRoomToUrl(fresh);
  return fresh;
}

// -------------------------------------------------------------- the editor ---

function init() {
  const el = {
    editor: document.getElementById('editor'),
    cursorLayer: document.getElementById('cursor-layer'),
    room: document.getElementById('room-input'),
    status: document.getElementById('status'),
    statusText: document.getElementById('status-text'),
    undoBtn: document.getElementById('undo-btn'),
    redoBtn: document.getElementById('redo-btn'),
    offlineBtn: document.getElementById('offline-btn'),
    waking: document.getElementById('waking'),
    queueBadge: document.getElementById('queue-badge'),
    pendingWrap: document.getElementById('pending-wrap'),
    peerList: document.getElementById('peer-list'),
    statReplica: document.getElementById('stat-replica'),
    statChars: document.getElementById('stat-chars'),
    statTombstones: document.getElementById('stat-tombstones'),
    statOps: document.getElementById('stat-ops'),
    statPending: document.getElementById('stat-pending'),
  };

  const replicaId = randomReplicaId();
  const room = roomFromUrl();

  const doc = new RGA(replicaId);
  const oplog = new OpLog(replicaId);

  el.room.value = room;
  el.statReplica.textContent = replicaId;
  el.statReplica.style.color = colorFor(replicaId);

  // The text as the textarea currently shows it. Diffs are always taken against
  // this, never against a fresh read of the CRDT, so a re-render caused by a
  // remote op can't be mistaken for local typing.
  let lastText = '';
  let opsApplied = 0;
  /** replicaId -> { id, cursor } for everyone else in the room. */
  const peers = new Map();

  // ------------------------------------------------------------ rendering ---

  function refreshStats() {
    const visible = doc.length;
    el.statChars.textContent = String(visible);
    el.statTombstones.textContent = String(doc.nodes.length - visible);
    el.statOps.textContent = String(opsApplied);

    // Both of these are zero in normal operation, so they only earn space on
    // screen when they are not: queued means "waiting for the network",
    // buffered means "waiting for a causally earlier op".
    const queued = oplog.pendingCount;
    el.queueBadge.textContent = `${queued} queued`;
    el.queueBadge.classList.toggle('hidden', queued === 0);

    el.statPending.textContent = String(doc.pendingCount);
    el.pendingWrap.classList.toggle('hidden', doc.pendingCount === 0);

    el.undoBtn.disabled = !undo.canUndo;
    el.redoBtn.disabled = !undo.canRedo;
  }

  /**
   * The caret, remembered as op ids instead of offsets.
   *
   * Captured continuously while the document and the textarea agree, because by
   * the time a remote op has been applied it is already too late: offset 40 now
   * points at different text than the user was looking at. Ids don't move, so
   * an anchor captured before a merge is still valid after it.
   */
  let caretAnchor = { startId: null, endId: null };

  function captureCaret() {
    if (document.activeElement !== el.editor) return;
    const start = el.editor.selectionStart;
    const end = el.editor.selectionEnd;
    caretAnchor = {
      startId: start > 0 ? doc.idAt(start - 1) : null,
      endId: end > 0 ? doc.idAt(end - 1) : null,
    };
  }

  /** Re-render from the CRDT, putting the caret back by id. */
  function render() {
    const text = doc.toString();
    if (text !== editorValue()) {
      const hasFocus = document.activeElement === el.editor;
      el.editor.value = text;
      lastText = text;

      if (hasFocus) {
        // indexAfterOrBefore degrades gracefully: if the anchored character was
        // deleted by a peer, the caret lands on its nearest surviving neighbour
        // instead of jumping to the top of the document.
        const start = caretAnchor.startId ? doc.indexAfterOrBefore(caretAnchor.startId) : 0;
        const end = caretAnchor.endId ? doc.indexAfterOrBefore(caretAnchor.endId) : 0;
        el.editor.selectionStart = start;
        el.editor.selectionEnd = Math.max(start, end);
      }
    } else {
      lastText = text;
    }

    renderRemoteCarets(text);
    refreshStats();
  }

  function editorValue() {
    return el.editor.value;
  }

  /**
   * Draw peers' carets in an overlay that mirrors the textarea's text metrics.
   *
   * The overlay holds a copy of the document with zero-width marker elements
   * spliced in, so the browser's own line-breaking decides where each caret
   * lands — no attempt to reimplement soft wrapping.
   */
  function renderRemoteCarets(text) {
    // Match the textarea's *content* width exactly (clientWidth excludes the
    // scrollbar), otherwise the overlay wraps at a different column.
    el.cursorLayer.style.width = `${el.editor.clientWidth}px`;

    const marks = [];
    for (const peer of peers.values()) {
      if (!peer.cursor) continue;
      // The peer sent an op id; we resolve it to a local offset right now,
      // against our own current state.
      const index = peer.cursor.id ? doc.indexAfterOrBefore(peer.cursor.id) : 0;
      marks.push({ index, replica: peer.id });
    }

    if (marks.length === 0) {
      if (el.cursorLayer.childNodes.length > 0) el.cursorLayer.replaceChildren();
      return;
    }

    marks.sort((a, b) => a.index - b.index);
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const mark of marks) {
      const at = Math.max(0, Math.min(text.length, mark.index));
      if (at > cursor) frag.append(document.createTextNode(text.slice(cursor, at)));
      const caret = document.createElement('span');
      caret.className = 'remote-caret';
      caret.style.setProperty('--peer-color', colorFor(mark.replica));
      const bar = document.createElement('i');
      bar.dataset.label = mark.replica;
      caret.append(bar);
      frag.append(caret);
      cursor = at;
    }
    // Trailing \u200b keeps a final newline from collapsing, so a caret on the
    // last (empty) line still has a box to sit in.
    frag.append(document.createTextNode(text.slice(cursor) + '\u200b'));

    el.cursorLayer.replaceChildren(frag);
    el.cursorLayer.scrollTop = el.editor.scrollTop;
    el.cursorLayer.scrollLeft = el.editor.scrollLeft;
  }

  function renderPeers() {
    const frag = document.createDocumentFragment();
    const all = [{ id: replicaId, self: true }, ...[...peers.values()].map((p) => ({ id: p.id }))];
    for (const peer of all) {
      const chip = document.createElement('span');
      chip.className = peer.self ? 'peer self' : 'peer';
      // Your own chip is drawn as an outline by the stylesheet; setting an
      // inline background here would override it, so leave it unset.
      if (!peer.self) chip.style.background = colorFor(peer.id);
      chip.title = peer.self ? `${peer.id} (you)` : peer.id;
      frag.append(chip);
    }
    el.peerList.replaceChildren(frag);
  }

  // ----------------------------------------------------------- publishing ---

  /** One path out for every locally-authored op: log it, queue it, count it. */
  function publish(ops) {
    if (ops.length === 0) return;
    oplog.appendMany(ops, { local: true });
    opsApplied += ops.length;
    connection.send();
    refreshStats();
  }

  const undo = new UndoManager({
    doc,
    onOps: (ops) => {
      publish(ops);
      render();
      sendPresence();
    },
  });

  // ------------------------------------------------------- local editing ---

  function onInput() {
    const change = diffText(lastText, editorValue());
    if (!change) return;

    const ops = [];
    // Delete first, then insert at the same index: a replacement is "remove the
    // old run, then anchor the new run where it started".
    if (change.removed > 0) {
      for (const op of doc.localDeleteRange(change.index, change.removed)) {
        if (op) ops.push(op);
      }
    }
    if (change.inserted) {
      ops.push(...doc.localInsertText(change.index, change.inserted));
    }
    if (ops.length === 0) return;

    publish(ops);
    undo.record(ops);
    lastText = doc.toString();

    if (lastText !== editorValue()) {
      // CRDT and DOM disagree, so the diff was wrong. Re-render from the CRDT,
      // which is the source of truth, rather than letting them drift apart.
      console.warn('[converge] textarea/CRDT mismatch, re-rendering from CRDT');
      render();
    } else {
      renderRemoteCarets(lastText);
      refreshStats();
    }
    captureCaret();
    sendPresence();
  }

  el.editor.addEventListener('input', onInput);

  el.editor.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();

    // The browser's native textarea undo must never run: it would rewrite the
    // DOM value behind the CRDT's back, and it works on positions, which is
    // exactly what breaks under concurrent edits.
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) undo.redo();
      else undo.undo();
    } else if (key === 'y') {
      event.preventDefault();
      undo.redo();
    }
  });

  el.undoBtn.addEventListener('click', () => {
    undo.undo();
    el.editor.focus();
  });
  el.redoBtn.addEventListener('click', () => {
    undo.redo();
    el.editor.focus();
  });

  // ------------------------------------------------------------- presence ---

  let presenceTimer = null;
  function sendPresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      const caret = el.editor.selectionStart;
      // Broadcast the *id* the caret sits after, not the offset — the offset
      // means something different on every other replica.
      const id = caret > 0 ? doc.idAt(caret - 1) : null;
      connection.sendPresence({ id });
    }, 80);
  }

  for (const evt of ['keyup', 'click', 'select', 'focus']) {
    el.editor.addEventListener(evt, () => {
      captureCaret();
      sendPresence();
    });
  }
  document.addEventListener('selectionchange', captureCaret);
  el.editor.addEventListener('scroll', () => {
    el.cursorLayer.scrollTop = el.editor.scrollTop;
    el.cursorLayer.scrollLeft = el.editor.scrollLeft;
  });
  window.addEventListener('resize', () => renderRemoteCarets(doc.toString()));

  // -------------------------------------------------------------- network ---

  /* A free host sleeps when idle and takes most of a minute to answer the first
     request. Without a word of explanation that reads as a broken page, so say
     what is happening. Delayed rather than immediate: against a warm server the
     socket opens in milliseconds, and a notice that flashes up and vanishes is
     worse than none at all.

     Kept up across reconnect attempts: a cold start fails the first socket,
     goes offline, then retries, and hiding on each failure would make the
     banner flicker for half a minute. */
  let wakingTimer = null;

  function showWakingNotice() {
    if (wakingTimer !== null) return; // Already counting down, or already shown.
    wakingTimer = setTimeout(() => el.waking.classList.remove('hidden'), 1500);
  }

  function hideWakingNotice() {
    clearTimeout(wakingTimer);
    wakingTimer = null;
    el.waking.classList.add('hidden');
  }

  const connection = new Connection({
    room,
    replica: replicaId,
    oplog,

    onOps: (ops) => {
      const changed = doc.applyMany(ops);
      oplog.appendMany(ops, { local: false });
      opsApplied += ops.length;
      if (changed) render();
      else refreshStats();
    },

    onStatus: (status) => {
      // Kept to one short word: the masthead lays these out on a single line,
      // and the indicator lamp already carries the severity.
      const label = {
        [Status.ONLINE]: 'live',
        [Status.CONNECTING]: 'connecting',
        [Status.OFFLINE]: connection?.simulatedOffline ? 'offline' : 'reconnecting',
      }[status];
      el.status.className = `status status-${status}`;
      el.statusText.textContent = label;
      document.body.classList.toggle('is-offline', status === Status.OFFLINE);
      if (status === Status.ONLINE || connection?.simulatedOffline) hideWakingNotice();
      else showWakingNotice();
      if (status === Status.ONLINE) sendPresence();
      refreshStats();
    },

    onPeers: (list) => {
      const seen = new Set();
      for (const p of list) {
        if (p.replica === replicaId) continue;
        seen.add(p.replica);
        if (!peers.has(p.replica)) peers.set(p.replica, { id: p.replica, cursor: null });
      }
      for (const id of [...peers.keys()]) if (!seen.has(id)) peers.delete(id);
      renderPeers();
      renderRemoteCarets(doc.toString());
    },

    onPresence: (msg) => {
      if (msg.type === 'peer-left') peers.delete(msg.replica);
      else if (msg.replica && msg.replica !== replicaId) {
        peers.set(msg.replica, { id: msg.replica, cursor: msg.cursor });
      }
      renderPeers();
      renderRemoteCarets(doc.toString());
    },
  });

  el.offlineBtn.addEventListener('click', () => {
    const goingOffline = !connection.simulatedOffline;
    connection.setSimulatedOffline(goingOffline);
    el.offlineBtn.classList.toggle('engaged', goingOffline);
    el.offlineBtn.textContent = goingOffline ? 'Go online' : 'Go offline';
    if (goingOffline) {
      peers.clear();
      renderPeers();
      renderRemoteCarets(doc.toString());
    }
    el.editor.focus();
  });

  el.room.addEventListener('change', () => {
    // Clearing the field earns a fresh private room, not a shared default.
    const next = sanitizeRoom(el.room.value) || randomRoomName();
    writeRoomToUrl(next, { reload: true });
  });

  // Started here rather than from onStatus: the connection is constructed
  // already in the connecting state, so setStatus('connecting') is a no-op and
  // never reaches the callback on this first attempt.
  showWakingNotice();
  connection.connect();
  renderPeers();
  render();
  el.editor.focus();

  // Handy in the console, and used by the browser-side integration checks.
  window.converge = { doc, oplog, undo, connection, render, replicaId, room, peers };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
