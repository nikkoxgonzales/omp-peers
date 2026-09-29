/**
 * Peer-name validation and cross-process deconfliction.
 *
 * A peer name is an address: `^[\w.-]{1,24}$`. `Main` is refused
 * (case-sensitive exact match — it names the host's driving agent and must
 * never be taken by a peer), as is any live local subagent id handed in via
 * `localIds`. Cross-process collisions resolve first-wins by `startedAt`;
 * the younger instance auto-suffixes `-<pid>`.
 */
import { basename } from 'node:path';
import { PeerNameError } from '../errors.js';
export const PEER_NAME_PATTERN = /^[\w.-]{1,24}$/;
/**
 * The host driving agent's id. This is a REFUSED NAME, never a delivery
 * address — the inbound path always targets this instance's own discovered
 * local agent id (see `peers/inbound.ts`).
 */
const REFUSED_HOST_NAME = 'Main';
export function isValidPeerName(name) {
    return PEER_NAME_PATTERN.test(name) && name !== REFUSED_HOST_NAME;
}
/** Throw {@link PeerNameError} unless `name` is usable as a peer address. */
export function validatePeerName(name, opts = {}) {
    if (!PEER_NAME_PATTERN.test(name)) {
        throw new PeerNameError(`invalid peer name "${name}" — use 1-24 of a-z A-Z 0-9 _ . - (no spaces)`);
    }
    if (name === REFUSED_HOST_NAME) {
        throw new PeerNameError(`"${name}" names the host driving agent — pick another peer name`);
    }
    if (opts.localIds !== undefined) {
        for (const id of opts.localIds) {
            if (id === name) {
                throw new PeerNameError(`"${name}" collides with a live local subagent id — pick another peer name`);
            }
        }
    }
}
/** Default address for an instance: sanitized `<basename(cwd)>-<pid>`. */
export function defaultPeerName(cwd, pid) {
    // The pid suffix is computed first so the 24-char cap can never truncate
    // pid digits — a truncated pid would collide across processes.
    const suffix = `-${pid}`;
    const base = basename(cwd)
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24 - suffix.length) || 'peer';
    return `${base}${suffix}`.slice(0, 24);
}
/**
 * Derive a peer address from the host session name. A session name qualifies
 * as an address ONLY in raw form: non-empty, matching
 * {@link PEER_NAME_PATTERN} (1-24 of a-z A-Z 0-9 _ . -), and not the refused
 * host name `Main`. Anything else falls back to {@link defaultPeerName} with
 * `rejected` carrying the raw name so the caller can warn once — except
 * model-generated titles (`titleSource` `"auto"`), which fall back silently:
 * they express no user intent and the host rewrites them. Cross-process
 * collisions still resolve later via {@link resolvePeerName}.
 */
export function peerNameFromSession(raw, cwd, pid, opts = {}) {
    // Model-generated titles are never addresses: they express no user intent
    // and the host rewrites them (replan refresh), so adopting one would flap
    // the peer name mid-life. Fall back silently — no warning.
    if (opts.titleSource === 'auto')
        return { name: defaultPeerName(cwd, pid) };
    if (raw !== undefined && raw !== '' && PEER_NAME_PATTERN.test(raw) && raw !== REFUSED_HOST_NAME) {
        return { name: raw };
    }
    return raw !== undefined && raw !== ''
        ? { name: defaultPeerName(cwd, pid), rejected: raw }
        : { name: defaultPeerName(cwd, pid) };
}
/**
 * First-wins by `startedAt`: when another live peer holds `candidate` and
 * started no later than us, take `<candidate>-<pid>`. The suffixed form is
 * intentionally exempt from the 24-char cap so it stays deterministic and
 * searchable.
 */
export function resolvePeerName(input) {
    const clash = input.peers.some((p) => p.pid !== input.pid && p.name === input.candidate && p.startedAt <= input.startedAt);
    return clash ? `${input.candidate}-${input.pid}` : input.candidate;
}
