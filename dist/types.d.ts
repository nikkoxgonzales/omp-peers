/**
 * Shared on-disk + wire schemas for the peers extension.
 *
 * Every presence record is schema-versioned (`v: 1`) and plain
 * JSON-serializable. These interfaces are the cross-process contract:
 * every running instance reads every other instance's `<state>/peers/<pid>.json`.
 */
/** Which harness a peer runs under (drives roster wording + tool hints). */
export type HarnessKind = 'omp' | 'pi';
/** Native host todo statuses (`tools/todo.ts`) plus the 1.3.0 legacy pair. */
export type PeerTodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'
/** Legacy 1.3.0 spelling of `in_progress`. */
 | 'doing'
/** Legacy 1.3.0 spelling of `completed`. */
 | 'done';
/**
 * One entry in a peer's published todo list — mirrored from the host's NATIVE
 * todo state, not a peer-owned list (see `readNativeTodos`).
 */
export interface PeerTodo {
    id?: string;
    /** Owning phase name from the native list (absent on 1.3.0 legacy records). */
    phase?: string;
    text: string;
    status?: PeerTodoStatus;
    /** What a `blocked` task waits on (native `TodoItem.blocker`). */
    blocker?: string;
}
/**
 * `<state>/peers/<pid>.json` — single-writer, owner-only presence record.
 * Written on a 15s beat; live while `now - beatAt <= 45s` and the pid answers
 * `process.kill(pid, 0)`.
 */
export interface PeerRecord {
    v: 1;
    pid: number;
    name: string;
    cwd: string;
    project: string;
    harness: HarnessKind;
    /** Owning session id (empty string when the host exposes none). */
    sessionId: string;
    /** Model id (empty string when the host exposes none). */
    model: string;
    /**
     * Socket address to reach this peer: a named-pipe path
     * (`\\.\pipe\peers-<pid>`) on Windows, a unix-socket path
     * (`<state>/peers/<pid>.sock`) elsewhere.
     */
    socket: string;
    /** `Date.now()` at process start — decides cross-process name collisions. */
    startedAt: number;
    /** `Date.now()` at the last beat — drives TTL reap + beat age. */
    beatAt: number;
    /** True when the owner's agent loop is mid-turn. */
    busy: boolean;
    /** Optional short activity description published by the owner. */
    activity?: string;
    /** Optional published todo list. */
    todos?: PeerTodo[];
}
/** Frame exchanged over a peer socket, one JSON object per line. */
export type PeerFrame = {
    t: 'msg';
    from: string;
    body: string;
    replyTo?: string;
    hop?: number;
    ack?: boolean;
} | {
    t: 'ping';
    from: string;
};
/** One-line JSON reply to a {@link PeerFrame}. */
export interface PeerReply {
    ok: boolean;
    outcome?: string;
    name?: string;
    error?: string;
}
/** In-flight request a peer is waiting for a reply to. */
export interface PendingReply {
    resolve: (body: string) => void;
    reject: (err: Error) => void;
    timer?: NodeJS.Timeout;
}
