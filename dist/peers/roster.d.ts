/**
 * Roster — identity + peer list injected on the host `context` event.
 *
 * The event payload's messages are a provider-bound clone that never reaches
 * the transcript. The note is always injected — even with no peers — so the
 * agent always knows its own peer name; rows degrade to a solo line.
 *
 * The note is rebuilt for every provider request and lands in the latest
 * user message, so any text in it that changes mid-turn invalidates the
 * provider's prompt cache from that message on. It therefore carries only
 * what changes when peers join, leave or rename: never busy/idle, activity
 * or todo counts, which `peer_status` reports on demand.
 */
import type { PeerRecord } from '../types.js';
export interface RosterMessage {
    role: string;
    content: string | Array<{
        type: string;
        text?: string;
    }>;
}
/** Identity line + contact rule + peer definition + one row per peer (solo compacts to one line). */
export declare function buildPeersNote(ownName: string, peers: PeerRecord[]): string;
/**
 * Fold `note` into the last user message (string content is suffixed, array
 * content is pushed) or append a fresh user message when none exists.
 * Mutates `messages` in place and returns it.
 */
export declare function appendNoteToMessages(messages: RosterMessage[], note: string): RosterMessage[];
