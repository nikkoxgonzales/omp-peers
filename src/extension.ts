/**
 * peers OMP/pi extension entry.
 *
 * Install is opt-in; every running instance is auto-present via its
 * `<state>/peers/<pid>.json` heartbeat — no join/leave/channels. Peers are
 * reached only through the `peer_*` tools; they are never registered in the
 * host's agent registry, so `agent://` messaging, Agent Hub and subagents
 * stay local to their own instance. Explicit names only, no `to:all`.
 *
 * Peer name = session name: the host's builtin `/rename <name>` is the only
 * naming surface. A raw session name is adopted as the peer address when it
 * matches `^[\w.-]{1,24}$`; anything else keeps the default name (one
 * popup warning per process — later ones log only, so model-written
 * auto-titles don't nag on every change).
 *
 * Session discipline: NOTHING session-shaped is captured at boot or in the
 * factory closure. The freshest `{pi, ctx}` is re-read from the live getter
 * on every delivery tick (updated by every host event below), and the own
 * agent id is re-discovered per delivery and cross-checked against
 * `sessionManager.getSessionId()`.
 */

import { registerPeersCommand } from './commands/peers.js';
import type { CommandContextLike, ExtensionHostLike } from './peers/host.js';
import { detectHarness, readNativeTodos, readTitleSource } from './peers/host.js';
import { defaultPeerName, isValidPeerName, peerNameFromSession, resolvePeerName } from './peers/ids.js';
import { deliverInboundPeerMessage, HOLD_POLL_MS, MAX_HELD_BATCHES, type HeldBatch } from './peers/inbound.js';
import { outboundHop, sendToPeer } from './peers/outbound.js';
import {
  HEARTBEAT_MS,
  listLivePeers,
  removePeerRecord,
  startPresenceBeat,
  writePeerBeat,
} from './peers/presence.js';
import { appendNoteToMessages, buildPeersNote } from './peers/roster.js';
import type { RosterMessage } from './peers/roster.js';
import { peerSocketAddress, startPeerServer } from './peers/server.js';
import type { PeerServerHandle } from './peers/server.js';
import { ensureStateDirs, resolveStateDir } from './store/paths.js';
import { registerPeerSendTool, registerPeerStatusTool, registerPeerRequestTool } from './tools.js';
import type { PeerRecord, PeerTodo, PendingReply } from './types.js';

const HARNESS = await detectHarness();

/** How long a started tool keeps naming the peer's activity before busy/idle takes over. */
const ACTIVITY_FRESH_MS = 120_000;

interface NodeState {
  stateDir: string;
  pid: number;
  startedAt: number;
  socketAddress: string;
  name: string;
  sessionId: string;
  peers: PeerRecord[];
  wakes: Map<string, number[]>;
  /** Peer whose message was last really delivered to this agent (undefined = fresh chain). */
  lastInboundPeer: string | undefined;
  /** Hop that last real delivery carried; 0 when there has been none. */
  lastInboundHop: number;
  /** Batches held while the peer types, oldest first (bounded, polled). */
  held: HeldBatch[];
  holdTimer: NodeJS.Timeout | undefined;
  /** First rejected session name this process saw; doubles as the warned-once flag (undefined = never warned). */
  lastRejectedSessionName: string | undefined;
  current: { pi: ExtensionHostLike; ctx: CommandContextLike } | undefined;
  server: PeerServerHandle | undefined;
  stopBeat: (() => void) | undefined;
  stopped: boolean;
  /** Native host todo list, re-read from the session transcript on every tick. */
  nativeTodos: PeerTodo[];
  /** Last tool the agent started; published as activity while fresh. */
  nativeActivity: { text: string; at: number } | undefined;
  /** In-flight peer_request promises keyed by reply id. */
  pendingReplies: Map<string, PendingReply>;
}

/** One node per process, even when several sessions load the extension. */
let node: NodeState | undefined;

/** The live node for this process, if one is running. */
function liveNode(): NodeState | undefined {
  return node !== undefined && !node.stopped ? node : undefined;
}

function currentOf(): { pi: ExtensionHostLike; ctx: CommandContextLike } | undefined {
  return liveNode()?.current;
}

/** Stash a held batch (bounded) and ensure the retry poller runs. */
function holdBatch(st: NodeState, msg: { from: string; body: string; replyTo?: string; hop: number }): void {
  st.held.push({ message: { ...msg }, receivedAt: Date.now() });
  while (st.held.length > MAX_HELD_BATCHES) {
    // Overflow drops the oldest batch — the sender got a 'held' receipt
    // promising delivery, so the drop must not be silent.
    const dropped = st.held.shift();
    if (dropped !== undefined) {
      warnOf(st, `peers: held queue full — dropped a message from ${dropped.message.from}`);
    }
  }
  if (st.holdTimer !== undefined) return;
  st.holdTimer = setInterval(() => {
    void pumpHeld(st).catch((err: unknown) => logOf(st, `peers: held retry failed: ${err instanceof Error ? err.message : String(err)}`));
  }, HOLD_POLL_MS);
  st.holdTimer.unref?.();
}

/** Retry held batches oldest-first; drop each once it delivers or ages out. */
async function pumpHeld(st: NodeState): Promise<void> {
  if (st.stopped || node !== st) return;
  for (const batch of [...st.held]) {
    if (st.stopped || node !== st) return;
    const res = await deliverInboundPeerMessage(batch.message, {
      getCurrent: () => currentOf(),
      getDraftText: () => {
        try {
          const text = currentOf()?.ctx.ui.getEditorText?.() ?? '';
          return typeof text === 'string' ? text : '';
        } catch {
          return '';
        }
      },
      receivedAt: batch.receivedAt,
      wakes: st.wakes,
    });
    // Only a real delivery advances the relay chain — 'held'/'dropped'/'aside'
    // never reached the agent, so they must not consume a hop.
    if (res.outcome === 'woken' || res.outcome === 'injected') {
      st.lastInboundPeer = batch.message.from;
      st.lastInboundHop = batch.message.hop;
    }
    if (res.outcome !== 'held') st.held = st.held.filter((b) => b !== batch);
  }
  if (st.held.length === 0 && st.holdTimer !== undefined) {
    clearInterval(st.holdTimer);
    st.holdTimer = undefined;
  }
}

function warnOf(st: NodeState, text: string): void {
  try {
    st.current?.ctx.ui.notify(text, 'warning');
  } catch {
    // Warnings never throw into the host.
  }
}

function logOf(st: NodeState, text: string): void {
  try {
    st.current?.pi.logger?.warn(text);
  } catch {
    // Logging never throws into the host.
  }
}

async function tick(st: NodeState): Promise<void> {
  const ctx = st.current?.ctx;
  const cwd = typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
  let sessionId = '';
  try {
    sessionId = ctx?.sessionManager?.getSessionId?.() ?? '';
  } catch {
    sessionId = '';
  }
  let model = '';
  try {
    model = ctx?.model?.id ?? '';
  } catch {
    model = '';
  }
  let busy = false;
  try {
    busy = !(ctx?.isIdle?.() ?? true);
  } catch {
    busy = false;
  }
  let sessionName: string | undefined;
  try {
    sessionName = st.current?.pi.getSessionName?.();
  } catch {
    sessionName = undefined;
  }
  if (sessionName === undefined) {
    try {
      sessionName = ctx?.sessionManager?.getSessionName?.();
    } catch {
      sessionName = undefined;
    }
  }
  // The host marks model-generated titles `"auto"`: those are never peer
  // addresses (no user intent, rewritten on replan) — peerNameFromSession
  // falls back to the default silently instead of warning.
  const derived = peerNameFromSession(sessionName, cwd, st.pid, {
    titleSource: readTitleSource(ctx?.sessionManager),
  });
  if (derived.rejected !== undefined && derived.rejected !== st.lastRejectedSessionName) {
    const first = st.lastRejectedSessionName === undefined;
    st.lastRejectedSessionName = derived.rejected;
    const text =
      `session name "${derived.rejected}" can't be a peer name (1-24 of a-z A-Z 0-9 _ . -); ` +
      `using ${derived.name} — /rename the session to a valid name`;
    if (first) warnOf(st, text);
    else logOf(st, `peers: ${text}`);
  }
  const base = derived.name;
  let others: PeerRecord[] | undefined;
  try {
    others = (await listLivePeers(st.stateDir, st.pid)).filter((p) => p.pid !== st.pid);
  } catch {
    // Transient listing failure: fall back to the last-good roster below.
    others = undefined;
  }
  st.name = resolvePeerName({
    candidate: base,
    pid: st.pid,
    startedAt: st.startedAt,
    peers: others ?? st.peers.filter((p) => p.pid !== st.pid),
  });
  st.sessionId = sessionId;
  st.nativeTodos = readNativeTodos(st.current?.ctx.sessionManager);
  const lastActivity = st.nativeActivity;
  const activity =
    lastActivity !== undefined && Date.now() - lastActivity.at <= ACTIVITY_FRESH_MS
      ? lastActivity.text
      : busy
        ? 'working'
        : undefined;
  let own: PeerRecord | undefined;
  try {
    own = await writePeerBeat({
      stateDir: st.stateDir,
      pid: st.pid,
      name: st.name,
      cwd,
      harness: HARNESS,
      ...(sessionId !== '' ? { sessionId } : {}),
      ...(model !== '' ? { model } : {}),
      socket: st.socketAddress,
      startedAt: st.startedAt,
      busy,
      ...(activity !== undefined && activity !== '' ? { activity } : {}),
      ...(st.nativeTodos.length > 0 ? { todos: st.nativeTodos } : {}),
    });
  } catch (err) {
    logOf(st, `peers: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lastOthers = st.peers.filter((p) => p.pid !== st.pid);
  st.peers =
    own !== undefined
      ? [...(others ?? lastOthers), own].sort((a, b) => a.name.localeCompare(b.name))
      : (others ?? lastOthers);
}

function armBeatTimer(st: NodeState, ctx: CommandContextLike): void {
  try {
    st.stopBeat?.();
  } catch {
    // Replacing a dead timer must not break re-arm.
  }
  const managed =
    typeof ctx.setInterval === 'function' && typeof ctx.clearTimer === 'function'
      ? { setInterval: ctx.setInterval.bind(ctx), clearTimer: ctx.clearTimer.bind(ctx) }
      : {};
  st.stopBeat = startPresenceBeat(() => tick(st), {
    intervalMs: HEARTBEAT_MS,
    onError: (err) => logOf(st, `peers: tick failed: ${err instanceof Error ? err.message : String(err)}`),
    ...managed,
  }).stop;
}

/** Get the live node, starting one if this process has none. Re-arms on every event. */
function ensureNode(pi: ExtensionHostLike, ctx: CommandContextLike): NodeState | undefined {
  const existing = liveNode();
  if (existing !== undefined) {
    existing.current = { pi, ctx };
    let sessionId = '';
    try {
      sessionId = ctx.sessionManager?.getSessionId?.() ?? '';
    } catch {
      sessionId = '';
    }
    if (sessionId !== '' && sessionId !== existing.sessionId) armBeatTimer(existing, ctx);
    return existing;
  }
  try {
    const stateDir = resolveStateDir();
    const st: NodeState = {
      stateDir,
      pid: process.pid,
      startedAt: Date.now(),
      socketAddress: peerSocketAddress(stateDir, process.pid),
      name: '',
      sessionId: '',
      peers: [],
      wakes: new Map<string, number[]>(),
      lastInboundPeer: undefined,
      lastInboundHop: 0,
      held: [],
      holdTimer: undefined,
      current: { pi, ctx },
      server: undefined,
      stopBeat: undefined,
      lastRejectedSessionName: undefined,
      stopped: false,
      nativeTodos: [],
      nativeActivity: undefined,
      pendingReplies: new Map<string, PendingReply>(),
    };
    st.name = defaultPeerName(
      typeof ctx.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd(),
      st.pid
    );
    node = st;
    void ensureStateDirs(stateDir)
      .then(() => {
        if (st.stopped) return;
        st.server = startPeerServer({
          address: st.socketAddress,
          ownName: () => liveNode()?.name ?? '',
          onMessage: async (msg) => {
            const live = liveNode();
            if (
              live !== undefined &&
              msg.replyTo !== undefined &&
              msg.replyTo !== '' &&
              live.pendingReplies.has(msg.replyTo)
            ) {
              const entry = live.pendingReplies.get(msg.replyTo)!;
              live.pendingReplies.delete(msg.replyTo);
              clearTimeout(entry.timer);
              entry.resolve(msg.body);
              live.lastInboundPeer = msg.from;
              live.lastInboundHop = msg.hop;
              return 'replied';
            }
            const res = await deliverInboundPeerMessage(msg, {
              getCurrent: () => currentOf(),
              getDraftText: () => {
                try {
                  const text = currentOf()?.ctx.ui.getEditorText?.() ?? '';
                  return typeof text === 'string' ? text : '';
                } catch {
                  return '';
                }
              },
              ...(live !== undefined ? { wakes: live.wakes } : {}),
            });
            // Only a real delivery advances the relay chain — 'held'/'dropped'/
            // 'aside' never reached the agent, so they must not consume a hop.
            if ((res.outcome === 'woken' || res.outcome === 'injected') && live !== undefined) {
              live.lastInboundPeer = msg.from;
              live.lastInboundHop = msg.hop;
            }
            if (res.outcome === 'held' && live !== undefined) holdBatch(live, msg);
            return res.outcome;
          },
          onWarn: (text) => {
            const live = liveNode();
            if (live !== undefined) warnOf(live, text);
          },
        });
        armBeatTimer(st, ctx);
        void tick(st);
      })
      .catch((err: unknown) => {
        try {
          ctx.ui.notify(`peers: could not start — ${err instanceof Error ? err.message : String(err)}`, 'warning');
        } catch {
          // Boot failures never throw into the host.
        }
      });
    return st;
  } catch (err) {
    node = undefined;
    try {
      pi.logger?.warn(`peers: could not start (${String(err)})`);
    } catch {
      // Logging never throws.
    }
    return undefined;
  }
}
async function stopNode(st: NodeState): Promise<void> {
  st.stopped = true;
  // A successor node for this same pid may already exist (session_switch →
  // ensureNode after `node` was cleared). When it does, this teardown must
  // not delete the successor's live record or socket file.
  const hasSuccessor = (): boolean => {
    const successor = liveNode();
    return successor !== undefined && successor !== st;
  };
  try {
    st.stopBeat?.();
  } catch {
    // Shutdown never throws.
  }
  st.stopBeat = undefined;
  if (st.holdTimer !== undefined) {
    try {
      clearInterval(st.holdTimer);
    } catch {
      // Shutdown never throws.
    }
    st.holdTimer = undefined;
  }
  if (st.held.length > 0) {
    logOf(st, `peers: dropping ${st.held.length} held message(s) on shutdown`);
  }
  st.held = [];
  for (const entry of st.pendingReplies.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('shutting down'));
  }
  st.pendingReplies.clear();
  try {
    st.server?.stop({ unlinkSocket: !hasSuccessor() });
  } catch {
    // Shutdown never throws.
  }
  st.server = undefined;
  if (hasSuccessor()) return;
  try {
    await removePeerRecord(st.stateDir, st.pid);
  } catch {
    // Final unlink is best-effort.
  }
}

export default function peersExtension(pi: ExtensionHostLike): void {
  registerPeersCommand(pi, async () => {
    const st = liveNode();
    if (st !== undefined) {
      // Fresh beat before rendering: a just-run /rename must be visible
      // immediately, not on the next 15s tick. tick() owns its failures.
      try {
        await tick(st);
      } catch {
        // Snapshot stays last-good.
      }
      return { ownName: st.name, peers: st.peers, held: st.held.length };
    }
    return { ownName: '', peers: [], held: 0 };
  });

  // Sends resolve names from the presence directory at call time, not from
  // the heartbeat cache: a /rename reaches the directory at the renamer's next
  // beat, and a cached roster answers "Unknown peer" until the sender's own
  // next beat as well. The pid filter drops our own record, so a stale own
  // name (post-/rename) can't route a send back to ourselves.
  const freshPeers = async () => {
    const st = liveNode();
    if (st === undefined) return [];
    return (await listLivePeers(st.stateDir, st.pid)).filter((p) => p.pid !== st.pid);
  };

  registerPeerSendTool(pi, {
    send: (to, message, replyTo, ack) => {
      const st = liveNode();
      return sendToPeer(to, message, {
        ownName: st?.name ?? '',
        ...(st !== undefined ? { state: st } : {}),
        isReply: replyTo !== undefined,
        listPeers: freshPeers,
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(ack ? { ack: true } : {}),
        reap: (record) => {
          if (st !== undefined) void removePeerRecord(st.stateDir, record.pid);
        },
      });
    },
  });

  registerPeerStatusTool(pi, {
    listPeers: freshPeers,
  });

  registerPeerRequestTool(pi, {
    ownName: () => liveNode()?.name ?? '',
    getHop: (to) => {
      const st = liveNode();
      return st === undefined ? 0 : outboundHop(st, to, false);
    },
    listPeers: freshPeers,
    send: (to, message, outDeps) => {
      const st = liveNode();
      return sendToPeer(to, message, {
        ...outDeps,
        ...(st !== undefined
          ? { reap: (record) => { void removePeerRecord(st.stateDir, record.pid); } }
          : {}),
      });
    },
    getPendingReplies: () => liveNode()?.pendingReplies,
  });

  pi.on('session_start', (_event, ctx) => {
    ensureNode(pi, ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    // omp disposes every finished `task` subagent session, which fires
    // session_shutdown on that session's own extension instance. Only the
    // root session's shutdown ends this peer.
    if (ctx?.agent?.kind === 'sub') return;
    const st = node;
    node = undefined;
    if (st !== undefined) void stopNode(st);
  });
  for (const event of ['session_switch', 'session_branch', 'session_tree']) {
    pi.on(event, (_payload, ctx) => {
      ensureNode(pi, ctx);
    });
  }

  pi.on('input', (event) => {
    const source = (event as { source?: string } | undefined)?.source;
    if (source === 'extension') return;
    // A human prompt ends any relay chain: the next send starts at hop 0.
    // (No re-beat here: the context handler builds the roster from the last
    // good tick, so an async beat could never land in time for this prompt.)
    const live = liveNode();
    if (live !== undefined) {
      live.lastInboundPeer = undefined;
      live.lastInboundHop = 0;
    }
  });
  // `input` only fires for interactive TTY submits — on rpc/print/headless
  // hosts it never runs, so `before_agent_start` (emitted by the agent loop
  // in every mode) is the reset that keeps the hop state from sticking
  // forever. Peer injections are identified by the `[peer <name>]` prefix
  // formatPeerText stamps on every delivery; a human prompt that happens to
  // start with `[peer ` won't reset — conservative direction, acceptable.
  pi.on('before_agent_start', (event) => {
    const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
    if (typeof prompt === 'string' && prompt.startsWith('[peer ')) return;
    const live = liveNode();
    if (live !== undefined) {
      live.lastInboundPeer = undefined;
      live.lastInboundHop = 0;
    }
  });
  // Activity is never synchronous on ctx, so it is captured from the agent's
  // own tool events: a started tool names what the peer is doing right now,
  // and its end clears the name (busy/idle still describes the turn).
  pi.on('tool_execution_start', (event) => {
    const st = liveNode();
    if (st === undefined) return;
    const payload = event as { toolName?: unknown; intent?: unknown } | undefined;
    const toolName = typeof payload?.toolName === 'string' ? payload.toolName : '';
    const intent = typeof payload?.intent === 'string' ? payload.intent.trim() : '';
    const text = intent !== '' ? intent : toolName;
    if (text === '') return;
    st.nativeActivity = { text, at: Date.now() };
  });
  pi.on('tool_execution_end', (event) => {
    const st = liveNode();
    if (st !== undefined) {
      st.nativeActivity = undefined;
      // A todo flip must land before the next 15s beat, not after it.
      if ((event as { toolName?: unknown } | undefined)?.toolName === 'todo') {
        void tick(st).catch((err: unknown) => logOf(st, `peers: tick failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  });
  pi.on('agent_end', () => {
    const st = liveNode();
    if (st !== undefined) st.nativeActivity = undefined;
  });
  // The reminder fires after the turn's todos came back unfinished; the beat
  // that follows must carry the fresh phases.
  pi.on('todo_reminder', () => {
    const st = liveNode();
    if (st === undefined) return;
    void tick(st).catch((err: unknown) => logOf(st, `peers: tick failed: ${err instanceof Error ? err.message : String(err)}`));
  });
  pi.on('context', (event, ctx) => {
    const st = ensureNode(pi, ctx);
    if (st === undefined) return undefined;
    // Hot-rename: recompute the name from the LIVE session name before
    // building the note — the async re-beat may not have landed yet, and
    // the first prompt after /rename must not show a stale name.
    const cwd = typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
    let sessionName: string | undefined;
    try {
      sessionName = pi.getSessionName?.() ?? ctx?.sessionManager?.getSessionName?.();
    } catch {
      sessionName = undefined;
    }
    // Auto-titles never claim the peer name, even valid-looking ones: the
    // host rewrites them, which would flap the address mid-life.
    if (sessionName !== undefined && isValidPeerName(sessionName) && readTitleSource(ctx?.sessionManager) !== 'auto') {
      st.name = resolvePeerName({
        candidate: sessionName,
        pid: st.pid,
        startedAt: st.startedAt,
        peers: st.peers.filter((p) => p.pid !== st.pid),
      });
    }
    // Always inject: the agent learns its OWN peer name here, even solo.
    const others = st.peers.filter((p) => p.pid !== st.pid);
    const note = buildPeersNote(st.name, others);
    const payload = event as { messages?: unknown } | undefined;
    if (payload === undefined || !Array.isArray(payload.messages)) return undefined;
    return { messages: appendNoteToMessages(payload.messages as RosterMessage[], note) };
  });
}
