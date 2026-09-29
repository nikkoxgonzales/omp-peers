/**
 * peers — opt-in live peer awareness for OMP/pi agent instances.
 *
 * Install is opt-in; every running instance is auto-present via its
 * `<state>/peers/<pid>.json` heartbeat. Library entry (storage + presence +
 * transport + delivery); the extension entry is `./extension.js`.
 */
// Store layer.
export { resolveStateDir, ensureStateDirs, peersDir, peerPath, } from './store/paths.js';
export { durableWriteJson, readJsonFile, } from './store/atomic.js';
// Peer identity.
export { PEER_NAME_PATTERN, isValidPeerName, validatePeerName, defaultPeerName, peerNameFromSession, resolvePeerName, } from './peers/ids.js';
// Presence.
export { writePeerBeat, listLivePeers, removePeerRecord, startPresenceBeat, formatBeatAge, HEARTBEAT_MS, PEER_TTL_MS, } from './peers/presence.js';
// Transport.
export { MAX_HOPS, COALESCE_MS, PEER_REQUEST_TIMEOUT_MS, SOCKET_IDLE_MS, MAX_FRAME_BYTES, peerSocketAddress, startPeerServer, requestPeer, } from './peers/server.js';
// Delivery.
export { deliverInboundPeerMessage, formatPeerText, isWakeOverBudget, recordPeerWake, MAX_WAKES_PER_PEER_PER_HOUR, WAKE_WINDOW_MS, HOLD_TIMEOUT_MS, MAX_HELD_BATCHES, HOLD_POLL_MS, } from './peers/inbound.js';
export { sendToPeer, outboundHop } from './peers/outbound.js';
// Roster.
export { buildPeersNote, appendNoteToMessages, } from './peers/roster.js';
// Host seam.
export { detectHarness, readTitleSource, readNativeTodos, MAX_PEER_TODOS, MAX_PEER_TODO_TEXT_CHARS, } from './peers/host.js';
// Socket input checks.
export { checkFrame, checkReply } from './peers/wire.js';
// Commands (pure text formatters for tests/consumers).
export { formatPeersText, formatPeerLine } from './commands/peers.js';
// Agent tool surface (registered unconditionally in every mode).
export { registerPeerSendTool, registerPeerStatusTool, registerPeerRequestTool, } from './tools.js';
// Errors and shared schemas.
export * from './errors.js';
