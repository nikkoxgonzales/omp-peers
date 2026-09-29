/**
 * Inbound delivery — hand a socket message to the LOCAL agent.
 *
 * PRIMARY PATH: `cur.pi.sendUserMessage(text)` on the CURRENT context's pi
 * with default semantics — streaming queues as steer, idle starts a turn,
 * plan mode folds it into context. No registry lookup, no own-agent-id
 * discovery, no drop-for-undiscovered: the host's bus copy is unreachable
 * from a compiled extension, so delivery goes through the extension-host
 * surface that is always live on the current context.
 *
 * STRUCTURAL RULE: the session is NEVER snapshotted at boot. The current
 * `{pi, ctx}` comes from a live getter (refreshed on every host event).
 * Over-budget wakes queue as asides
 * (`pi.sendUserMessage(text, {deliverAs:'aside'})`), as does delivery on a
 * bridgeless host — and always on the CURRENT pi, never a
 * factory-captured one.
 */
import type { InboundMessage } from './server.js';
import type { CommandContextLike, ExtensionHostLike } from './host.js';
/** Per-peer wakes allowed per rolling hour before excess queues as asides. */
export declare const MAX_WAKES_PER_PEER_PER_HOUR = 20;
export declare const WAKE_WINDOW_MS = 3600000;
/** A batch held while the peer types waits at most this long before delivering anyway. */
export declare const HOLD_TIMEOUT_MS = 120000;
/** Upper bound on batches waiting for the peer's composer to clear. */
export declare const MAX_HELD_BATCHES = 20;
/** How often a process retries its held batches. */
export declare const HOLD_POLL_MS = 500;
export interface InboundCarrier {
    from: string;
    body: string;
    replyTo?: string;
    /** PURE RECEIPT — DISPLAY-ONLY TOAST PATH, NEVER A WAKE. */
    ack?: boolean;
}
export interface CurrentHost {
    pi: ExtensionHostLike;
    ctx: CommandContextLike;
}
/** One coalesced batch waiting for the peer's composer to clear. */
export interface HeldBatch {
    message: InboundMessage;
    receivedAt: number;
}
export type InboundOutcome = 'injected' | 'woken' | 'aside' | 'dropped' | 'held' | 'acked';
export interface InboundDeps {
    /** Live getter for the freshest host handles — called on every delivery. */
    getCurrent: () => CurrentHost | undefined;
    /** Live composer text — non-empty means the peer is typing. Absent headless. */
    getDraftText?: () => string;
    /** When this batch first arrived — bounds how long a hold may last. */
    receivedAt?: number;
    /** In-memory per-peer wake timestamps; owned by the caller. */
    wakes?: Map<string, number[]>;
    now?: () => number;
}
/** Every injection carries the `[peer <name>]` prefix plus a peer-not-user line. */
export declare function formatPeerText(from: string, body: string, opts?: {
    replyTo?: string | undefined;
}): string;
/** True when `from` already consumed its hourly wake budget (prunes first). */
export declare function isWakeOverBudget(wakes: Map<string, number[]>, from: string, now: number, max?: number): boolean;
/** Record one real wake for `from` (prunes expired stamps). */
export declare function recordPeerWake(wakes: Map<string, number[]>, from: string, now: number): void;
/**
 * Deliver one coalesced inbound message. Never throws; the outcome tells the
 * socket layer what receipt to send back.
 */
export declare function deliverInboundPeerMessage(frame: InboundCarrier, deps: InboundDeps): Promise<{
    outcome: InboundOutcome;
    detail?: string;
}>;
