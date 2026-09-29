/**
 * Host seam: narrow structural types plus the harness probe.
 *
 * STRUCTURAL RULE: never read or write host singletons (`registry/agent-registry`,
 * `irc/bus`). The extension's module graph may bind a FOREIGN copy of the
 * host modules, and even the host's own registry is the host's local agent
 * list: a peer registered there becomes a fake subagent that `agent://all`
 * broadcasts reach, Agent Hub lists, and every spawned subagent can message.
 * The host is touched ONLY through `ctx`/`pi` surfaces.
 */

import type { HarnessKind, PeerTodo } from '../types.js';

export interface SessionManagerLike {
  getSessionId?: () => string | undefined;
  /** Host session title (omp `ReadonlySessionManager.getSessionName`). */
  getSessionName?: () => string | undefined;
  /** Session header (omp `ReadonlySessionManager.getHeader`) — carries `titleSource`. */
  getHeader?: () => unknown;
  /** Title source on hosts exposing the full manager (`"user"` | `"auto"`). */
  titleSource?: unknown;
  /** Active-branch session entries, oldest first (omp `ReadonlySessionManager.getBranch`). */
  getBranch?: () => unknown;
  /** Every session entry, oldest first (omp `ReadonlySessionManager.getEntries`). */
  getEntries?: () => unknown;
}

export interface SelectOption {
  label: string;
  description?: string;
}

export interface UiLike {
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  select?: (
    title: string,
    options: SelectOption[],
    dialogOptions?: unknown
  ) => Promise<string | undefined>;
  /** Live composer text in interactive mode (absent headless) — typing protection reads this. */
  getEditorText?: () => string;
  [key: string]: unknown;
}

export interface CommandContextLike {
  cwd: string;
  mode: string;
  ui: UiLike;
  sessionManager: SessionManagerLike;
  model?: { id?: string };
  isIdle: () => boolean;
  setInterval?: (callback: () => void, ms?: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** The session's agent identity (omp `ExtensionContext.agent`): `main` for the root, `sub` for a task subagent. */
  agent?: { kind?: string };
  [key: string]: unknown;
}

export interface ToolInvokeResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
}

export interface ExtensionHostLike {
  on(event: string, handler: (event: unknown, ctx: CommandContextLike) => unknown): void;
  registerCommand(
    name: string,
    opts: { description?: string; handler: (args: string, ctx: CommandContextLike) => unknown }
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    /**
     * omp mounts `discoverable` tools (its default) behind `write xd://<name>`
     * rather than as direct tools; `essential` keeps them callable by name.
     */
    loadMode?: 'essential' | 'discoverable';
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal
    ) => Promise<ToolInvokeResult>;
  }): void;
  sendUserMessage?: (
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' | 'aside'; attribution?: 'user' | 'agent' }
  ) => void | Promise<void>;
  getSessionName?: () => string | undefined;
  logger?: { warn(message: string): void };
}

/**
 * omp or pi? omp resolves its own package's module paths for extensions and
 * pi does not, so the import is dynamic: a static one would fail to load
 * under pi. Only the resolution is used; nothing on the module is read.
 */
export async function detectHarness(): Promise<HarnessKind> {
  try {
    await import('@oh-my-pi/pi-coding-agent/registry/agent-registry');
    return 'omp';
  } catch {
    return 'pi';
  }
}

/**
 * Who named this session. The host marks explicit renames `"user"` and
 * model-generated titles `"auto"` on the session header (on-contract via
 * `ReadonlySessionManager.getHeader`) and on the manager itself (structural —
 * the runtime object is the full SessionManager). Returns undefined when the
 * host exposes neither; callers keep legacy adopt-or-warn behavior.
 */
export function readTitleSource(manager: SessionManagerLike | undefined | null): string | undefined {
  if (manager === undefined || manager === null) return undefined;
  // Header first (on-contract), then the manager itself (structural) — first
  // non-empty string wins. Every read is guarded: unknown host shapes fall
  // through to undefined and callers keep legacy adopt-or-warn behavior.
  const candidates: unknown[] = [];
  try {
    candidates.push(manager.getHeader?.());
  } catch {
    // Header read is best-effort.
  }
  candidates.push(manager);
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (!('titleSource' in candidate)) continue;
    const source: unknown = candidate.titleSource;
    if (typeof source === 'string' && source !== '') return source;
  }
  return undefined;
}

/** Marker the host stamps on a user todo edit entry (`tools/todo.ts`). */
const USER_TODO_EDIT_CUSTOM_TYPE = 'user_todo_edit';
/** Cap on published todos: the heartbeat is a glance, not a transcript. */
export const MAX_PEER_TODOS = 20;
/** Cap on each published text field (phase, task, blocker). */
export const MAX_PEER_TODO_TEXT_CHARS = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function clampTodoText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > MAX_PEER_TODO_TEXT_CHARS ? text.slice(0, MAX_PEER_TODO_TEXT_CHARS) : text;
}

/** Native `TodoStatus`, defaulting anything unrecognized (incl. legacy spellings) to pending. */
function nativeTodoStatus(raw: unknown): NonNullable<PeerTodo['status']> {
  switch (raw) {
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'abandoned':
      return 'abandoned';
    case 'blocked':
      return 'blocked';
    default:
      return 'pending';
  }
}

/** Phases carried by one session entry, or undefined when the entry is not a todo snapshot. */
function nativePhasesFromEntry(entry: unknown): unknown[] | undefined {
  const e = asRecord(entry);
  if (e === undefined) return undefined;
  if (e['type'] === 'custom' && e['customType'] === USER_TODO_EDIT_CUSTOM_TYPE) {
    const phases = asRecord(e['data'])?.['phases'];
    return Array.isArray(phases) ? phases : undefined;
  }
  if (e['type'] !== 'message') return undefined;
  const message = asRecord(e['message']);
  if (message === undefined) return undefined;
  if (message['role'] !== 'toolResult' || message['toolName'] !== 'todo' || message['isError']) return undefined;
  const phases = asRecord(message['details'])?.['phases'];
  return Array.isArray(phases) ? phases : undefined;
}

/** Flatten native phases/tasks into bounded peer todos. */
function mapNativeTodos(phases: unknown[]): PeerTodo[] {
  const flat: Array<{ todo: PeerTodo; order: number }> = [];
  let order = 0;
  for (const rawPhase of phases) {
    const phase = asRecord(rawPhase);
    if (phase === undefined) continue;
    const tasks = phase['tasks'];
    if (!Array.isArray(tasks)) continue;
    const phaseName = clampTodoText(phase['name']);
    for (const rawTask of tasks) {
      const task = asRecord(rawTask);
      if (task === undefined) continue;
      const text = clampTodoText(task['content']);
      if (text === '') continue;
      const status = nativeTodoStatus(task['status']);
      const blocker = status === 'blocked' ? clampTodoText(task['blocker']) : '';
      flat.push({
        order: order++,
        todo: {
          text,
          status,
          ...(phaseName !== '' ? { phase: phaseName } : {}),
          ...(blocker !== '' ? { blocker } : {}),
        },
      });
    }
  }
  if (flat.length > MAX_PEER_TODOS) {
    // Trim by usefulness — an in-progress task tells a peer more than a
    // completed one — then restore the host's own order for display.
    const priority = (todo: PeerTodo): number =>
      todo.status === 'in_progress' ? 0 : todo.status === 'pending' ? 1 : 2;
    flat.sort((a, b) => priority(a.todo) - priority(b.todo) || a.order - b.order);
    flat.length = MAX_PEER_TODOS;
    flat.sort((a, b) => a.order - b.order);
  }
  return flat.map((entry) => entry.todo);
}

/**
 * Read the host's NATIVE todo state out of the session transcript, newest
 * entry first: a `user_todo_edit` custom entry, else the latest successful
 * `todo` toolResult. Never throws — a host without the surface reads as [].
 */
export function readNativeTodos(manager: SessionManagerLike | undefined | null): PeerTodo[] {
  let entries: unknown;
  try {
    entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const phases = nativePhasesFromEntry(entries[index]);
    if (phases !== undefined) return mapNativeTodos(phases);
  }
  return [];
}
