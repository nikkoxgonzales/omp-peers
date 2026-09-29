/**
 * Socket transport between peer processes.
 *
 * Address seam: Windows serves a named pipe (`\\.\pipe\peers-<pid>`),
 * everywhere else a unix socket (`<state>/peers/<pid>.sock`). Both sides go
 * through `node:net` with a plain string address, so one code path covers
 * both. Frames are newline-delimited JSON (`PeerFrame`); every frame gets a
 * one-line `PeerReply`.
 *
 * Inbound policy lives here: hop cap (4 — a chain of agent-to-agent relays
 * past a human prompt is refused, never relayed) and 400ms per-sender burst
 * coalescing (N frames in one window cost one wake, not N).
 */
import type { PeerFrame, PeerReply } from '../types.js';
/** Max agent-to-agent relays from the last human prompt before refusal. */
export declare const MAX_HOPS = 4;
/** Burst window: frames from one sender inside it become a single wake. */
export declare const COALESCE_MS = 400;
/** Socket round-trip timeout for outbound sends. */
export declare const PEER_REQUEST_TIMEOUT_MS = 8000;
/** Idle server-side sockets are destroyed after this long without a frame. */
export declare const SOCKET_IDLE_MS = 30000;
/** Largest buffered frame per socket before the connection is dropped. */
export declare const MAX_FRAME_BYTES = 1048576;
/** Where this peer listens (and where others reach it). */
export declare function peerSocketAddress(stateDir: string, pid: number): string;
export interface InboundMessage {
    from: string;
    body: string;
    replyTo?: string;
    hop: number;
    /** PURE RECEIPT — NEVER WAKES THE RECEIVER; RENDERED AS ONE DIM TOAST. */
    ack?: boolean;
}
export interface PeerServerOptions {
    address: string;
    ownName: () => string;
    onMessage: (msg: InboundMessage) => Promise<string>;
    onWarn?: (message: string) => void;
    coalesceMs?: number;
}
export interface PeerServerHandle {
    address: string;
    /** `unlinkSocket: false` leaves the unix socket path for a successor node. */
    stop(opts?: {
        unlinkSocket?: boolean;
    }): void;
}
/**
 * Serve one peer address. `onMessage` runs once per coalesced batch and its
 * return becomes the reply `outcome`. Never throws into the host.
 */
export declare function startPeerServer(opts: PeerServerOptions): PeerServerHandle;
/**
 * One request/response round trip to a peer socket. Resolves `undefined`
 * when the socket closes before replying (peer gone — caller reaps).
 */
export declare function requestPeer(address: string, frame: PeerFrame, timeoutMs?: number): Promise<PeerReply | undefined>;
