// Wrap a nicer JavaScript API around the MessagePack native bindings.

'use strict';

const buffer = require('buffer');
const events = require('events');
const util = require('util');

const mpBindings = require(__dirname + '/../build/Release/msgpackBinding');

const bpack = mpBindings.pack;
const rawUnpack = mpBindings.unpack;

/* 32 MiB payload (same as unpack str/bin) plus 16 bytes of MessagePack
 * framing so a max-legal bin32/str32 still fits in one Stream buffer. */
const MAX_STREAM_BYTES = 32 * 1024 * 1024 + 16;
/* CLI stdin is capped at 32 MiB before concat/parse. */
const MAX_STDIN_BYTES = 32 * 1024 * 1024;

/* No JS pre-pass: the binding already applies toJSON at every level and
 * packs Dates as ISO strings. Calling toJSON here instead turned a top-level
 * Buffer into Buffer.prototype.toJSON's {type,data} map rather than bin. */
function pack() {
  return bpack.apply(null, arguments);
}

function unpack(buf) {
  const result = rawUnpack(buf);
  unpack.bytes_remaining = mpBindings.bytesRemaining();
  return result;
}

unpack.bytes_remaining = 0;

function Stream(s) {
  const self = this;
  events.EventEmitter.call(self);
  self.buf = null;
  let dead = false;

  function dropBuf() {
    self.buf = null;
  }

  function rejectLimit() {
    if (dead) return;
    dead = true;
    dropBuf();
    const err = new Error('msgpack stream limit exceeded');
    self.emit('error', err);
    if (typeof s.destroy === 'function') {
      s.destroy(err);
    }
  }

  self.send = function (m) {
    const args = [pack(m)];
    for (let i = 1; i < arguments.length; i++) {
      args.push(arguments[i]);
    }
    return s.write.apply(s, args);
  };

  s.addListener('data', function (d) {
    if (dead) return;
    const have = self.buf ? self.buf.length : 0;
    if (have + d.length > MAX_STREAM_BYTES) {
      rejectLimit();
      return;
    }
    if (self.buf) {
      const b = buffer.Buffer.allocUnsafe(have + d.length);
      self.buf.copy(b, 0, 0, have);
      d.copy(b, have, 0, d.length);
      self.buf = b;
    } else {
      self.buf = d;
    }

    while (self.buf && self.buf.length > 0) {
      let msg;
      try {
        msg = unpack(self.buf);
      } catch (err) {
        /* A malformed or oversized packet is unrecoverable for this stream:
         * drop the buffer rather than re-parsing the same bomb forever. */
        self.buf = null;
        self.emit('error', err);
        return;
      }
      /* bytesRemaining is thread_local native state, overwritten by the next
       * unpack() on this thread. Snapshot it before anything else can run, so
       * a 'msg' listener that unpacks cannot desync this loop. */
      const remaining = unpack.bytes_remaining;
      /* null means "incomplete" only when nothing was consumed; a decoded
       * nil (0xc0) is a real message and must be emitted. */
      if (msg === null && remaining === self.buf.length) {
        break;
      }
      /* Consume the frame before emitting: a listener that throws must not
       * leave its own bytes queued for a later data event to re-deliver. */
      if (remaining > 0) {
        self.buf = self.buf.slice(self.buf.length - remaining);
      } else {
        self.buf = null;
      }
      self.emit('msg', msg);
    }
  });

  s.addListener('close', dropBuf);
  s.addListener('end', dropBuf);
  s.addListener('error', dropBuf);
}

util.inherits(Stream, events.EventEmitter);

exports.pack = pack;
exports.unpack = unpack;
exports.Stream = Stream;
exports.MAX_STREAM_BYTES = MAX_STREAM_BYTES;
exports.MAX_STDIN_BYTES = MAX_STDIN_BYTES;
