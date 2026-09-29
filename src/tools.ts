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

import { randomUUID } from 'node:crypto';
import type { ExtensionHostLike } from './peers/host.js';
import { formatBeatAge } from './peers/presence.js';
import type { OutboundDeps } from './peers/outbound.js';
import type { PeerRecord, PeerTodo, PendingReply } from './types.js';

export interface PeerSendDeps {
  send: (to: string, message: string, replyTo?: string, ack?: boolean) => Promise<string>;
}

export function registerPeerSendTool(pi: ExtensionHostLike, deps: PeerSendDeps): void {
  pi.registerTool({
    name: 'peer_send',
    label: 'Peer Send',
    loadMode: 'essential',
    description:
      'Send a message to another live peer instance by name (see `/peers`). Only use when the user explicitly asks for cross-instance contact, or to reply to an inbound peer message — never use peers as subagents on your own. It is delivered as a real prompt: it steers the peer mid-turn or wakes it if idle. Fire-and-forget — the peer\'s reply arrives as a separate peer message.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer name, as listed by `/peers`' },
        message: { type: 'string', description: 'Message body' },
        replyTo: { type: 'string', description: 'Message id being answered' },
        ack: {
          type: 'boolean',
          description:
            'True when this message is a pure ack/receipt/closure ("received", "done", "loop closed"). Renders as a dim toast on the receiver — never wakes it, never enters its transcript, needs no reply. Prefer this over a normal send for confirmations.',
        },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      try {
        const to = typeof params['to'] === 'string' ? (params['to'] as string) : '';
        const message = typeof params['message'] === 'string' ? (params['message'] as string) : '';
        const replyTo = typeof params['replyTo'] === 'string' ? (params['replyTo'] as string) : undefined;
        const ack = typeof params['ack'] === 'boolean' ? (params['ack'] as boolean) : undefined;
        return { content: [{ type: 'text', text: await deps.send(to, message, replyTo, ack) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `peer_send failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });
}

export interface PeerStatusDeps {
  listPeers: () => Promise<PeerRecord[]>;
  now?: () => number;
}

/** Checklist box for one native/legacy todo status. */
function todoBox(status: PeerTodo['status']): string {
  switch (status) {
    case 'completed':
    case 'done':
      return '[x]';
    case 'in_progress':
    case 'doing':
      return '[~]';
    case 'blocked':
      return '[!]';
    case 'abandoned':
      return '[-]';
    default:
      return '[ ]';
  }
}

function todoLine(todo: PeerTodo): string {
  const blocker = todo.status === 'blocked' && todo.blocker ? ` — ${todo.blocker}` : '';
  return `- ${todoBox(todo.status)} ${todo.text}${blocker}`;
}

/** Native phases render as headers; todos without one stay flat. */
function renderTodos(todos: PeerTodo[]): string[] {
  const lines = [`Todos (${todos.length}):`];
  const groups = new Map<string, PeerTodo[]>();
  for (const todo of todos) {
    const phase = todo.phase ?? '';
    const group = groups.get(phase);
    if (group === undefined) groups.set(phase, [todo]);
    else group.push(todo);
  }
  for (const [phase, group] of groups) {
    if (phase !== '') lines.push(`Phase: ${phase}`);
    for (const todo of group) lines.push(todoLine(todo));
  }
  return lines;
}

export function registerPeerStatusTool(pi: ExtensionHostLike, deps: PeerStatusDeps): void {
  pi.registerTool({
    name: 'peer_status',
    label: 'Peer Status',
    loadMode: 'essential',
    description:
      "Check what another live peer is doing: busy/idle, current activity, its native todo list (grouped by phase, newest state), and last heartbeat age. `to` is the peer name from `/peers`.",
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer name, as listed by `/peers`' },
      },
      required: ['to'],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      try {
        const to = typeof params['to'] === 'string' ? (params['to'] as string) : '';
        if (to === '') return { content: [{ type: 'text', text: 'Peer name (`to`) is required.' }] };
        const peers = await deps.listPeers();
        const peer = peers.find((p) => p.name === to);
        if (peer === undefined) {
          return { content: [{ type: 'text', text: `No live peer named "${to}". Use /peers to see who is live.` }] };
        }
        const now = deps.now?.() ?? Date.now();
        const lines = [
          `\`${peer.name}\` is ${peer.busy ? 'working' : 'idle'} in ${peer.cwd} · beat ${formatBeatAge(peer.beatAt, now)}.`,
          `Activity: ${peer.activity ?? '—'}`,
        ];
        if (peer.todos !== undefined && peer.todos.length > 0) {
          lines.push(...renderTodos(peer.todos));
        } else {
          lines.push('Todos: none');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `peer_status failed: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  });
}

export interface PeerRequestDeps {
  ownName: () => string;
  /** Hop for a request to `to` — a request is never a reply, so it may only stay level or advance. */
  getHop: (to: string) => number;
  send: (to: string, message: string, deps: OutboundDeps) => Promise<string>;
  listPeers: () => Promise<PeerRecord[]>;
  getPendingReplies: () => Map<string, PendingReply> | undefined;
  getNow?: () => number;
}

async function statusHintFor(to: string, listPeers: () => Promise<PeerRecord[]>, now: number): Promise<string> {
  try {
    const peers = await listPeers();
    const peer = peers.find((p) => p.name === to);
    if (peer === undefined) return `No live peer named "${to}". Use /peers to see who is live.`;
    return `\`${peer.name}\` is ${peer.busy ? 'working' : 'idle'} · ${peer.activity ?? 'no activity'} · ${peer.todos?.length ?? 0} todos · beat ${formatBeatAge(peer.beatAt, now)}.`;
  } catch {
    return 'Use peer_status for details.';
  }
}

export function registerPeerRequestTool(pi: ExtensionHostLike, deps: PeerRequestDeps): void {
  pi.registerTool({
    name: 'peer_request',
    label: 'Peer Request',
    loadMode: 'essential',
    description:
      'Send a message to another live peer and wait for a matching reply with a timeout. `to` is the peer name, `message` the body. `timeout_ms` defaults to 30000 and is clamped between 5000 and 120000. `replyTo` is an optional correlation id; one is generated if omitted. The tool returns the reply body or a timeout message with a peer_status hint.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer name, as listed by `/peers`' },
        message: { type: 'string', description: 'Message body' },
        timeout_ms: { type: 'number', description: 'Reply timeout in milliseconds (5000–120000, default 30000)' },
        replyTo: { type: 'string', description: 'Optional correlation id; generated if omitted' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const to = typeof params['to'] === 'string' ? (params['to'] as string) : '';
      const message = typeof params['message'] === 'string' ? (params['message'] as string) : '';
      if (to === '' || message === '') {
        return { content: [{ type: 'text', text: 'Both `to` and `message` are required.' }] };
      }

      let timeoutMs = 30_000;
      if ('timeout_ms' in params) {
        const n = Number(params['timeout_ms']);
        if (Number.isFinite(n)) {
          timeoutMs = Math.max(5_000, Math.min(120_000, Math.trunc(n)));
        }
      }

      const replyTo =
        typeof params['replyTo'] === 'string' && (params['replyTo'] as string) !== ''
          ? (params['replyTo'] as string)
          : randomUUID();

      const pending = deps.getPendingReplies();
      if (pending === undefined) {
        return { content: [{ type: 'text', text: 'peers not started.' }] };
      }

      let resolve!: (body: string) => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending.set(replyTo, { resolve, reject });

      try {
        const receipt = await deps.send(to, message, {
          ownName: deps.ownName(),
          hop: deps.getHop(to),
          isReply: false,
          listPeers: deps.listPeers,
          replyTo,
        });

        const queueable =
          receipt.startsWith('Delivered to') ||
          receipt.startsWith('Held at') ||
          receipt.startsWith('Queued at');

        if (!queueable) {
          // Not a queueable delivery — e.g. unknown peer, refused, or it
          // matched a pending request on the far end and was consumed.
          pending.delete(replyTo);
          resolve(receipt); // never reject an unawaited promise — unhandledRejection terminates bun (crash 2026-09-22)
          return { content: [{ type: 'text', text: receipt }] };
        }

        if (!pending.has(replyTo)) {
          // A very fast reply already arrived and resolved before sendToPeer
          // returned; the promise is already resolved.
          const body = await promise;
          return { content: [{ type: 'text', text: `Reply from ${to}: ${body}` }] };
        }

        const entry = pending.get(replyTo)!;
        entry.timer = setTimeout(() => {
          if (pending.has(replyTo)) {
            pending.delete(replyTo);
            reject(new Error('timeout'));
          }
        }, timeoutMs);

        const body = await promise;
        return { content: [{ type: 'text', text: `Reply from ${to}: ${body}` }] };
      } catch (err) {
        pending.delete(replyTo);
        if (err instanceof Error && err.message === 'timeout') {
          const now = deps.getNow?.() ?? Date.now();
          const hint = await statusHintFor(to, deps.listPeers, now);
          return { content: [{ type: 'text', text: `Request to ${to} timed out after ${timeoutMs}ms. ${hint}` }] };
        }
        return { content: [{ type: 'text', text: `peer_request failed: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  });
}
