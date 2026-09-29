/**
 * Agent tool surface: `peer_send`, `peer_status`, and `peer_request`.
 *
 * Registered in every mode, as the only way to reach a peer: peers are never
 * placed in the host's agent registry. `peer_status` reads the heartbeat,
 * which mirrors each peer's NATIVE todo list and current activity — there is
 * no peer-owned todo to maintain. Explicit names only — `to:"all"` is
 * refused. On omp each tool is `essential`, so agents call it by name rather
 * than through a `write xd://` device.
 */
import type { ExtensionHostLike } from './peers/host.js';
import type { OutboundDeps } from './peers/outbound.js';
import type { PeerRecord, PendingReply } from './types.js';
export interface PeerSendDeps {
    send: (to: string, message: string, replyTo?: string, ack?: boolean) => Promise<string>;
}
export declare function registerPeerSendTool(pi: ExtensionHostLike, deps: PeerSendDeps): void;
export interface PeerStatusDeps {
    listPeers: () => Promise<PeerRecord[]>;
    now?: () => number;
}
export declare function registerPeerStatusTool(pi: ExtensionHostLike, deps: PeerStatusDeps): void;
export interface PeerRequestDeps {
    ownName: () => string;
    /** Hop for a request to `to` — a request is never a reply, so it may only stay level or advance. */
    getHop: (to: string) => number;
    send: (to: string, message: string, deps: OutboundDeps) => Promise<string>;
    listPeers: () => Promise<PeerRecord[]>;
    getPendingReplies: () => Map<string, PendingReply> | undefined;
    getNow?: () => number;
}
export declare function registerPeerRequestTool(pi: ExtensionHostLike, deps: PeerRequestDeps): void;
