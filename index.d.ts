// Type definitions for msgpack 3.1.0
// Project: https://github.com/msgpack/msgpack-node

/// <reference types="node" />

import { EventEmitter } from 'events';

export type PackType =
  | 'fixint'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'float32'
  | 'float64'
  | 'fixstr'
  | 'str8'
  | 'str16'
  | 'str32'
  | 'bin8'
  | 'bin16'
  | 'bin32'
  | 'nil'
  | 'true'
  | 'false';

export type PackFamily = 'int' | 'float' | 'str' | 'bin';

export interface PackInterpretResult {
  data: any;
  type?: PackType;
  family?: PackFamily;
}

export interface PackOptions {
  type?: PackType;
  family?: PackFamily;
  interpret?: (item: any) => PackInterpretResult;
}

/**
 * Serialize values to MessagePack.
 *
 * A single argument is packed as itself; two or more are packed as an array
 * of that many elements.
 *
 * When the second argument own-enumerates only `type`, `family`, and/or
 * `interpret`, it is pack options rather than a second value. `type` forces
 * a MessagePack wire type; `family` picks a compact encoding in that family
 * (`type` wins if both are set). `interpret` is used when packing an Array:
 * each element is replaced by `interpret(item)`, which must return `{ data }`
 * and may also set `type` / `family`.
 *
 * `bigint` values in the int64/uint64 range pack as MessagePack integers
 * (smallest family that fits). Values outside that range throw. A `number`
 * that has already lost bits below 2^53 stays on the Number path; lost bits
 * are not recovered. BigInt plus an integer `type`/`family` uses the same
 * 64-bit path.
 */
export function pack(value: any, options: PackOptions): Buffer;
export function pack(...values: any[]): Buffer;

/**
 * Deserialize the first MessagePack value in `buf`.
 *
 * Integers whose magnitude is greater than `Number.MAX_SAFE_INTEGER` return
 * as `bigint`. Values that fit stay `number`, even if the wire type is
 * uint64 or int64 (a uint64 of 1 is Number 1).
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
