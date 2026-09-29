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
import type { PeerFrame, PeerReply } from '../types.js';
/** Why a decoded frame was refused; the text becomes the reply's `error`. */
export type FrameRejection = 'bad frame' | 'unknown frame';
export type FrameCheck = {
    ok: true;
    frame: PeerFrame;
} | {
    ok: false;
    error: FrameRejection;
};
/**
 * Accept a decoded socket value as a {@link PeerFrame}, checking every field
 * the receiver reads. Optional fields must be absent or of their declared
 * type; a wrong type rejects the frame rather than being silently dropped.
 */
export declare function checkFrame(value: unknown): FrameCheck;
/** Accept a decoded socket value as a {@link PeerReply}, or `undefined`. */
export declare function checkReply(value: unknown): PeerReply | undefined;
