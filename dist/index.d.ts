/**
 * peers — opt-in live peer awareness for OMP/pi agent instances.
 *
 * Install is opt-in; every running instance is auto-present via its
 * `<state>/peers/<pid>.json` heartbeat. Library entry (storage + presence +
 * transport + delivery); the extension entry is `./extension.js`.
 */
export { resolveStateDir, ensureStateDirs, peersDir, peerPath, } from './store/paths.js';
export { durableWriteJson, readJsonFile, } from './store/atomic.js';
export { PEER_NAME_PATTERN, isValidPeerName, validatePeerName, defaultPeerName, peerNameFromSession, resolvePeerName, type ResolveNameInput, } from './peers/ids.js';
export { writePeerBeat, listLivePeers, removePeerRecord, startPresenceBeat, formatBeatAge, HEARTBEAT_MS, PEER_TTL_MS, type BeatInput, type ListPeersOptions, type PresenceBeatOptions, } from './peers/presence.js';
export { MAX_HOPS, COALESCE_MS, PEER_REQUEST_TIMEOUT_MS, SOCKET_IDLE_MS, MAX_FRAME_BYTES, peerSocketAddress, startPeerServer, requestPeer, type InboundMessage, type PeerServerOptions, type PeerServerHandle, } from './peers/server.js';
export { deliverInboundPeerMessage, formatPeerText, isWakeOverBudget, recordPeerWake, MAX_WAKES_PER_PEER_PER_HOUR, WAKE_WINDOW_MS, HOLD_TIMEOUT_MS, MAX_HELD_BATCHES, HOLD_POLL_MS, type InboundCarrier, type CurrentHost, type InboundOutcome, type InboundDeps, type HeldBatch, } from './peers/inbound.js';
export { sendToPeer, outboundHop, type HopState, type OutboundDeps } from './peers/outbound.js';
export { buildPeersNote, appendNoteToMessages, type RosterMessage, } from './peers/roster.js';
export { detectHarness, readTitleSource, readNativeTodos, MAX_PEER_TODOS, MAX_PEER_TODO_TEXT_CHARS, type CommandContextLike, type ExtensionHostLike, type UiLike, type SelectOption, } from './peers/host.js';
export { checkFrame, checkReply, type FrameCheck, type FrameRejection } from './peers/wire.js';
export { formatPeersText, formatPeerLine, type PeersSnapshot } from './commands/peers.js';
export { registerPeerSendTool, registerPeerStatusTool, registerPeerRequestTool, type PeerSendDeps, type PeerStatusDeps, type PeerRequestDeps, } from './tools.js';
export * from './errors.js';
export type { HarnessKind, PeerRecord, PeerTodo, PendingReply, PeerFrame, PeerReply, } from './types.js';
