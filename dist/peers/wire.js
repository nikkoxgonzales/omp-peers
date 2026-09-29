/**
 * Runtime checks for everything that crosses a peer socket.
 *
 * `JSON.parse` returns whatever the other side sent: `null`, a number, an
 * array, or an object with the wrong field types. A cast (`as PeerFrame`)
 * hides that from the compiler, and the first property read then throws
 * inside a fire-and-forget handler — an unhandled rejection that terminates
 * the whole host process. Every decoded value goes through these functions
 * instead, and anything they reject is answered or dropped, never read.
 */
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Accept a decoded socket value as a {@link PeerFrame}, checking every field
 * the receiver reads. Optional fields must be absent or of their declared
 * type; a wrong type rejects the frame rather than being silently dropped.
 */
export function checkFrame(value) {
    if (!isObject(value))
        return { ok: false, error: 'bad frame' };
    const { t, from } = value;
    if (t !== 'ping' && t !== 'msg')
        return { ok: false, error: 'unknown frame' };
    if (typeof from !== 'string')
        return { ok: false, error: 'bad frame' };
    if (t === 'ping')
        return { ok: true, frame: { t: 'ping', from } };
    const { body, replyTo, hop, ack } = value;
    if (from === '' ||
        typeof body !== 'string' ||
        (replyTo !== undefined && typeof replyTo !== 'string') ||
        (hop !== undefined && typeof hop !== 'number') ||
        (ack !== undefined && typeof ack !== 'boolean')) {
        return { ok: false, error: 'bad frame' };
    }
    return {
        ok: true,
        frame: {
            t: 'msg',
            from,
            body,
            ...(replyTo !== undefined ? { replyTo } : {}),
            ...(hop !== undefined ? { hop } : {}),
            ...(ack !== undefined ? { ack } : {}),
        },
    };
}
/** Accept a decoded socket value as a {@link PeerReply}, or `undefined`. */
export function checkReply(value) {
    if (!isObject(value))
        return undefined;
    const { ok, outcome, name, error } = value;
    if (typeof ok !== 'boolean')
        return undefined;
    if ((outcome !== undefined && typeof outcome !== 'string') ||
        (name !== undefined && typeof name !== 'string') ||
        (error !== undefined && typeof error !== 'string')) {
        return undefined;
    }
    return {
        ok,
        ...(outcome !== undefined ? { outcome } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(error !== undefined ? { error } : {}),
    };
}
