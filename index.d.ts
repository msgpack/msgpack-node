// Type definitions for msgpack 3.4.0
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
 * (smallest family that fits). Larger values pack as ext type 0x42 (msgpackr
 * BigInt extension) with a two's-complement payload of at most 256 bytes.
 * Still larger values throw. A `number` that has already lost bits below
 * 2^53 stays on the Number path; lost bits are not recovered. BigInt plus
 * an integer `type`/`family` uses the same 64-bit path (hints do not
 * truncate into ext).
 */
export function pack(value: any, options: PackOptions): Buffer;
export function pack(...values: any[]): Buffer;

/**
 * Deserialize the first MessagePack value in `buf`.
 *
 * Integers whose magnitude is greater than `Number.MAX_SAFE_INTEGER` return
 * as `bigint`. Values that fit stay `number`, even if the wire type is
 * uint64 or int64 (a uint64 of 1 is Number 1). Ext type 0x42 unpacks as
 * `bigint` (payload capped at 256 bytes). Other ext types throw.
 *
 * Returns `null` when the buffer holds an incomplete value, in which case
 * `unpack.bytes_remaining` equals `buf.length`. Throws on malformed input or
 * when a container/string/bin header exceeds the decoder's limits.
 *
 * Pass `{ lazy: true }` to wrap maps as objects with accessor own-properties
 * and arrays as array-likes with indexed accessors. Nested values are not
 * converted until read. `JSON.stringify` and `util.inspect` materialize via
 * `toJSON` / `inspect.custom`. Lazy arrays are not real `Array`s
 * (`Array.isArray` is false); `pack()` still round-trips them because it
 * calls `toJSON`. Primitives unpack eagerly even when `lazy` is set.
 */
export function unpack(buf: Buffer, opts?: { lazy?: boolean }): any;

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
 * Emits `'msg'` with each decoded value, `'drain'` when the underlying
 * writable is ready for more data and the send queue is empty, and
 * `'error'` if a packet cannot be decoded (the buffered data is then
 * dropped) or if queued sends are discarded because the underlying stream
 * emitted `error`/`close`/`end`.
 */
export class Stream extends EventEmitter {
    constructor(s: NodeJS.ReadWriteStream);

    /** Buffered bytes not yet forming a complete message, or `null`. */
    buf: Buffer | null;

    /**
     * Pack `m` and write it to the underlying stream. Extra arguments are
     * forwarded to `stream.write()` (encoding, callback) on an immediate
     * write. Returns the boolean from `write()`, or `false` if the message
     * was queued because a previous write returned false and `drain` has
     * not fired yet. At most 1024 messages may wait in that queue; further
     * `send()` throws. Queued flushes call `write(buf)` without inventing
     * an encoding; a supplied callback runs after that buffer is written
     * or if the queue is dropped.
     */
    send(m: any, ...args: any[]): boolean;
}
