/**
 * Outbound delivery — name→socket send. Never throws into the agent turn:
 * every failure (unknown name, refused relay, dead socket, timeout) resolves
 * to a human-readable text receipt. Dead sockets reap the stale presence
 * record on sight so the next `/peers` is accurate.
 */
import type { PeerRecord } from '../types.js';
/** Hop accounting state: where this node's last real inbound delivery came from. */
export interface HopState {
    lastInboundPeer: string | undefined;
    lastInboundHop: number;
}
/**
 * The hop an outbound send from `st` must carry.
 *
 * A single hop counter per node cannot tell a relay from a conversation: every
 * send would advance the chain, so an orchestrator<->agent request/reply round
 * trip hit the cap after a few rounds. Tracking the last inbound peer instead
 * keeps a conversation (or a reply) at the depth it arrived — only relaying to
 * a DIFFERENT peer advances the chain. Nothing received since the last human
 * prompt means a fresh chain: hop 0.
 */
export declare function outboundHop(st: HopState, to: string, isReply: boolean): number;
export interface OutboundDeps {
    ownName: string;
    /** Live per-node hop state; when present the hop is derived via {@link outboundHop}. */
    state?: HopState;
    /** True when this send answers the last inbound message (never advances the chain). */
    isReply?: boolean;
    /** Explicit hop override — wins over `state`. */
    hop?: number;
    replyTo?: string;
    /** PURE RECEIPT — RECEIVER SHOWS A TOAST, NEVER WAKES, NO REPLY EXPECTED. */
    ack?: boolean;
    listPeers: () => Promise<PeerRecord[]>;
    reap?: (record: PeerRecord) => Promise<void> | void;
}
/** Send one message to the peer named `to`. Never throws. */
export declare function sendToPeer(to: string, message: string, deps: OutboundDeps): Promise<string>;
