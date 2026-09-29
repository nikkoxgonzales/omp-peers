/**
 * `/peers` — list live instances: name · harness(pid) · cwd · model ·
 * busy/idle · beat age. Text list always; the interactive picker runs ONLY
 * when `typeof ctx.ui?.select === 'function' && ctx.mode === 'tui'`, else
 * plain text. No UI module is ever imported — the primitive is probed on the
 * live ctx and invoked as a receiver method.
 */
import type { ExtensionHostLike } from '../peers/host.js';
import type { PeerRecord } from '../types.js';
export interface PeersSnapshot {
    ownName: string;
    peers: PeerRecord[];
    /** Batches held while the peer types — shown so held mail is visible. */
    held?: number;
}
/** `backend · omp(1234) · C:\work · model-id · working · beat 3s ago`. */
export declare function formatPeerLine(p: PeerRecord, now: number, selfName: string): string;
export declare function formatPeersText(snap: PeersSnapshot, now: number): string;
export declare function registerPeersCommand(pi: ExtensionHostLike, getSnapshot: () => Promise<PeersSnapshot>): void;
