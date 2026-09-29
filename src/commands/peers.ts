/**
 * `/peers` — list live instances: name · harness(pid) · cwd · model ·
 * busy/idle · beat age. Text list always; the interactive picker runs ONLY
 * when `typeof ctx.ui?.select === 'function' && ctx.mode === 'tui'`, else
 * plain text. No UI module is ever imported — the primitive is probed on the
 * live ctx and invoked as a receiver method.
 */

import type { CommandContextLike, ExtensionHostLike } from '../peers/host.js';
import { formatBeatAge } from '../peers/presence.js';
import type { PeerRecord } from '../types.js';

export interface PeersSnapshot {
  ownName: string;
  peers: PeerRecord[];
  /** Batches held while the peer types — shown so held mail is visible. */
  held?: number;
}

/** `backend · omp(1234) · C:\work · model-id · working · beat 3s ago`. */
export function formatPeerLine(p: PeerRecord, now: number, selfName: string): string {
  const self = p.name === selfName ? ' · you' : '';
  const activity = p.activity ? ` · ${p.activity}` : '';
  const todos = p.todos?.length
    ? ` · ${p.todos.length} todo${p.todos.length === 1 ? '' : 's'}`
    : '';
  return `${p.name} · ${p.harness}(${p.pid}) · ${p.cwd} · ${p.model === '' ? '—' : p.model} · ${p.busy ? 'working' : 'idle'} · beat ${formatBeatAge(p.beatAt, now)}${activity}${todos}${self}`;
}

export function formatPeersText(snap: PeersSnapshot, now: number): string {
  const lines = [...snap.peers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => formatPeerLine(p, now, snap.ownName));
  const header = `peers (${snap.peers.length}) — you are \`${snap.ownName}\`${(snap.held ?? 0) > 0 ? ` · held ${snap.held}` : ''}`;
  return lines.length === 0 ? `${header} — no peers` : `${header}\n${lines.join('\n')}`;
}

export function registerPeersCommand(
  pi: ExtensionHostLike,
  getSnapshot: () => Promise<PeersSnapshot>
): void {
  pi.registerCommand('peers', {
    description: 'List live peer instances on this machine',
    handler: async (_args: string, ctx: CommandContextLike) => {
      try {
        const snap = await getSnapshot();
        const select = ctx.ui?.select;
        if (typeof select === 'function' && ctx.mode === 'tui' && snap.peers.length > 0) {
          try {
            const picked = await select.call(
              ctx.ui,
              'Peers — pick one for details',
              [...snap.peers]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => ({
                  label: p.name,
                  description: `${p.harness}(${p.pid}) · ${p.cwd}${p.busy ? ' · working' : ''}${p.activity ? ` · ${p.activity}` : ''}`,
                }))
            );
            if (typeof picked === 'string' && picked !== '') {
              const peer = snap.peers.find((p) => p.name === picked);
              ctx.ui.notify(
                peer !== undefined ? formatPeerLine(peer, Date.now(), snap.ownName) : formatPeersText(snap, Date.now()),
                'info'
              );
            }
            return;
          } catch {
            // Picker failed — fall through to the text list.
          }
        }
        ctx.ui.notify(formatPeersText(snap, Date.now()), 'info');
      } catch (err) {
        try {
          ctx.ui.notify(`/peers failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        } catch {
          // Notify is best-effort.
        }
      }
    },
  });
}
