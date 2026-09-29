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
import type { ExtensionHostLike } from './peers/host.js';
export default function peersExtension(pi: ExtensionHostLike): void;
