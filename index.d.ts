// Type definitions for msgpack 2.0.0
// Project: https://github.com/msgpack/msgpack-node

/// <reference types="node" />

import { EventEmitter } from 'events';

/**
 * Serialize values to MessagePack.
 *
 * A single argument is packed as itself; two or more are packed as an array
 * of that many elements.
 */
export function pack(...values: any[]): Buffer;

/**
 * Deserialize the first MessagePack value in `buf`.
 *
 * Returns `null` when the buffer holds an incomplete value, in which case
 * `unpack.bytes_remaining` equals `buf.length`. Throws on malformed input or
 * when a container/string/bin header exceeds the decoder's limits.
 */
export function unpack(buf: Buffer): any;

export namespace unpack {
    /**
     * Bytes left in the buffer passed to the most recent `unpack()` call on
     * this thread. Read it immediately after `unpack()`: the next call
     * overwrites it.
     */
    let bytes_remaining: number;
}

/**
 * Frames MessagePack messages over a stream.
 *
 * Emits `'msg'` with each decoded value, and `'error'` if a packet cannot be
 * decoded (the buffered data is then dropped).
 */
export class Stream extends EventEmitter {
    constructor(s: NodeJS.ReadWriteStream);

    /** Buffered bytes not yet forming a complete message, or `null`. */
    buf: Buffer | null;

    /**
     * Pack `m` and write it to the underlying stream. Extra arguments are
     * forwarded to `stream.write()` (encoding, callback).
     */
    send(m: any, ...args: any[]): boolean;
}
