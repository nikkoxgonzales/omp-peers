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
    select?: (title: string, options: SelectOption[], dialogOptions?: unknown) => Promise<string | undefined>;
    /** Live composer text in interactive mode (absent headless) — typing protection reads this. */
    getEditorText?: () => string;
    [key: string]: unknown;
}
export interface CommandContextLike {
    cwd: string;
    mode: string;
    ui: UiLike;
    sessionManager: SessionManagerLike;
    model?: {
        id?: string;
    };
    isIdle: () => boolean;
    setInterval?: (callback: () => void, ms?: number) => unknown;
    clearTimer?: (timer: unknown) => void;
    /** The session's agent identity (omp `ExtensionContext.agent`): `main` for the root, `sub` for a task subagent. */
    agent?: {
        kind?: string;
    };
    [key: string]: unknown;
}
export interface ToolInvokeResult {
    content: Array<{
        type: string;
        text: string;
    }>;
    details?: unknown;
}
export interface ExtensionHostLike {
    on(event: string, handler: (event: unknown, ctx: CommandContextLike) => unknown): void;
    registerCommand(name: string, opts: {
        description?: string;
        handler: (args: string, ctx: CommandContextLike) => unknown;
    }): void;
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
        execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolInvokeResult>;
    }): void;
    sendUserMessage?: (content: string, options?: {
        deliverAs?: 'steer' | 'followUp' | 'aside';
        attribution?: 'user' | 'agent';
    }) => void | Promise<void>;
    getSessionName?: () => string | undefined;
    logger?: {
        warn(message: string): void;
    };
}
/**
 * omp or pi? omp resolves its own package's module paths for extensions and
 * pi does not, so the import is dynamic: a static one would fail to load
 * under pi. Only the resolution is used; nothing on the module is read.
 */
export declare function detectHarness(): Promise<HarnessKind>;
/**
 * Who named this session. The host marks explicit renames `"user"` and
 * model-generated titles `"auto"` on the session header (on-contract via
 * `ReadonlySessionManager.getHeader`) and on the manager itself (structural —
 * the runtime object is the full SessionManager). Returns undefined when the
 * host exposes neither; callers keep legacy adopt-or-warn behavior.
 */
export declare function readTitleSource(manager: SessionManagerLike | undefined | null): string | undefined;
/** Cap on published todos: the heartbeat is a glance, not a transcript. */
export declare const MAX_PEER_TODOS = 20;
/** Cap on each published text field (phase, task, blocker). */
export declare const MAX_PEER_TODO_TEXT_CHARS = 200;
/**
 * Read the host's NATIVE todo state out of the session transcript, newest
 * entry first: a `user_todo_edit` custom entry, else the latest successful
 * `todo` toolResult. Never throws — a host without the surface reads as [].
 */
export declare function readNativeTodos(manager: SessionManagerLike | undefined | null): PeerTodo[];
