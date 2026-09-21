'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const msgpack = require('../lib/msgpack');
const stub = require('./fixtures/stub');

function roundTrip(value) {
  const packed = msgpack.pack(value);
  assert.ok(Buffer.isBuffer(packed));
  return msgpack.unpack(packed);
}

describe('msgpack pack/unpack', () => {
  it('round-trips primitive and composite values', () => {
    const o = [
      'string',
      true,
      false,
      null,
      0,
      1,
      -1,
      1.1,
      -1.1,
      2,
      20,
      200,
      2000,
      20000,
      200000,
      2000000,
      20000000,
      200000000,
      2000000000,
      -2,
      -20,
      -200,
      -2000,
      -20000,
      -200000,
      -2000000,
      -20000000,
      -200000000,
      -2000000000,
      { foo: 'bar', baz: 'quux' },
      [1, 2, 3, 4],
      Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
    ];
    const got = roundTrip(o);
    assert.deepEqual(got, o);
    assert.ok(Buffer.isBuffer(got[got.length - 1]));
  });

  it('packs a top-level Buffer as bin, not a toJSON map', () => {
    const buf = Buffer.from([1, 2, 3]);
    const packed = msgpack.pack(buf);
    assert.ok(Buffer.isBuffer(packed));
    /* bin 8 for a 3-byte payload: 0xc4 len data, not fixstr and not a map. */
    assert.equal(packed[0], 0xc4);
    const got = msgpack.unpack(packed);
    assert.ok(Buffer.isBuffer(got));
    assert.deepEqual([...got], [1, 2, 3]);
  });

  it('unpacks a 7-bit integer', () => {
    assert.equal(msgpack.unpack(Buffer.from([0x05])), 5);
  });

  it('returns null for a truncated object', () => {
    const packed = msgpack.pack({ a: 'abc', b: 1, c: [1, 2, 3] });
    const truncated = packed.subarray(0, packed.length - 1);
    assert.equal(msgpack.unpack(truncated), null);
  });

  it('uses toJSON when packing', () => {
    const obj = { a: 1 };
    obj.toJSON = () => ({ b: 2 });
    assert.deepEqual(msgpack.unpack(msgpack.pack(obj)), { b: 2 });
  });

  it('uses toJSON on nested objects too', () => {
    const o = { inner: { toJSON: () => ({ b: 2 }) } };
    assert.deepEqual(msgpack.unpack(msgpack.pack(o)), { inner: { b: 2 } });
  });

  it('packs a top-level Date as its ISO string', () => {
    const d = new Date('2000-06-13T00:00:00.000Z');
    assert.equal(msgpack.unpack(msgpack.pack(d)), '2000-06-13T00:00:00.000Z');
  });

  it('packs a nested Date as its ISO string', () => {
    const d = new Date('2000-06-13T00:00:00.000Z');
    assert.deepEqual(msgpack.unpack(msgpack.pack({ d })), {
      d: '2000-06-13T00:00:00.000Z',
    });
  });

  it('packs numeric keys as well as string keys', () => {
    assert.deepEqual(msgpack.unpack(msgpack.pack({ 1: 'a', b: 'c' })), {
      1: 'a',
      b: 'c',
    });
  });

  it('does not drop a user key named _msgpack_stack', () => {
    /* Cycle marks are V8 private symbols now, so this is an ordinary key. */
    assert.deepEqual(msgpack.unpack(msgpack.pack({ _msgpack_stack: 1, b: 2 })), {
      _msgpack_stack: 1,
      b: 2,
    });
  });

  it('throws on circular object and array', () => {
    const o = {};
    o.a = o;
    assert.throws(() => msgpack.pack(o), /circular/);

    const a = [];
    a.push(a);
    assert.throws(() => msgpack.pack(a), /circular/);
  });
});

function mockWritable(returnSeq) {
  const s = new EventEmitter();
  const seq = returnSeq ? returnSeq.slice() : [];
  s.writes = [];
  s.write = function (chunk) {
    s.writes.push({
      chunk: chunk,
      extra: Array.prototype.slice.call(arguments, 1),
    });
    const last = arguments[arguments.length - 1];
    const ret = seq.length > 0 ? seq.shift() : true;
    if (typeof last === 'function') {
      last();
    }
    return ret;
  };
  return s;
}

describe('msgpack.Stream', () => {
  it('sends a packed message through write', () => {
    const s = new EventEmitter();
    s.writable = true;
    s.write = stub();
    const ms = new msgpack.Stream(s);
    ms.send('hello');
    assert.equal(s.write.called, true);
    assert.equal(s.write.args.length, 1);
    assert.deepEqual(msgpack.unpack(s.write.args[0]), 'hello');
  });

  it('passes extra send arguments to write', () => {
    const s = new EventEmitter();
    s.writable = true;
    s.write = stub();
    const ms = new msgpack.Stream(s);
    ms.send('hello', 1, 2, 3);
    assert.equal(s.write.called, true);
    assert.equal(s.write.args.length, 4);
    assert.deepEqual(msgpack.unpack(s.write.args[0]), 'hello');
    assert.deepEqual(Array.prototype.slice.call(s.write.args, 1), [1, 2, 3]);
  });

  it('returns true when write returns true and does not queue', () => {
    const s = mockWritable([true]);
    const ms = new msgpack.Stream(s);
    assert.equal(ms.send('hello'), true);
    assert.equal(s.writes.length, 1);
    assert.deepEqual(msgpack.unpack(s.writes[0].chunk), 'hello');
    assert.equal(ms.send('again'), true);
    assert.equal(s.writes.length, 2);
  });

  it('queues send after write returns false and flushes FIFO on drain', () => {
    const s = mockWritable([false, true]);
    const ms = new msgpack.Stream(s);
    const drained = [];
    ms.on('drain', () => drained.push(true));

    assert.equal(ms.send('one'), false);
    assert.equal(s.writes.length, 1);
    assert.equal(ms.send('two'), false);
    assert.equal(ms.send('three'), false);
    assert.equal(s.writes.length, 1);

    s.emit('drain');

    assert.equal(s.writes.length, 3);
    assert.deepEqual(
      s.writes.map((w) => msgpack.unpack(w.chunk)),
      ['one', 'two', 'three']
    );
    assert.equal(drained.length, 1);
  });

  it('re-emits drain when the underlying writable drains with an empty queue', () => {
    const s = mockWritable([false]);
    const ms = new msgpack.Stream(s);
    let got = 0;
    ms.on('drain', () => {
      got += 1;
    });
    assert.equal(ms.send('x'), false);
    s.emit('drain');
    assert.equal(got, 1);
    assert.equal(s.writes.length, 1);
  });

  it('throws when more than 1024 messages are queued', () => {
    const s = mockWritable();
    s.writes = [];
    s.write = function (chunk) {
      s.writes.push({ chunk: chunk, extra: [] });
      return false;
    };
    const ms = new msgpack.Stream(s);
    assert.equal(ms.send('head'), false);
    for (let i = 0; i < 1024; i++) {
      assert.equal(ms.send(i), false);
    }
    assert.equal(s.writes.length, 1);
    assert.throws(() => ms.send('overflow'), /backpressure|queue full/);
  });

  it('runs the extra callback argument on send', () => {
    const s = mockWritable([true]);
    const ms = new msgpack.Stream(s);
    let n = 0;
    assert.equal(
      ms.send('hello', () => {
        n += 1;
      }),
      true
    );
    assert.equal(n, 1);
  });

  it('runs the callback of a queued send after that buffer is written', () => {
    const s = mockWritable([false, true]);
    const ms = new msgpack.Stream(s);
    let n = 0;
    assert.equal(ms.send('one'), false);
    assert.equal(
      ms.send('two', () => {
        n += 1;
      }),
      false
    );
    assert.equal(n, 0);
    s.emit('drain');
    assert.equal(n, 1);
    assert.deepEqual(
      s.writes.map((w) => msgpack.unpack(w.chunk)),
      ['one', 'two']
    );
    assert.equal(s.writes[1].extra.length, 1);
    assert.equal(typeof s.writes[1].extra[0], 'function');
  });

  it('does not pass encoding to a queued flush write', () => {
    const s = mockWritable([false, true]);
    const ms = new msgpack.Stream(s);
    ms.send('one');
    ms.send('two', 'utf8');
    s.emit('drain');
    assert.equal(s.writes[1].extra.length, 0);
    assert.deepEqual(msgpack.unpack(s.writes[1].chunk), 'two');
  });

  it('stops a flush when write returns false again', () => {
    const s = mockWritable([false, false, true]);
    const ms = new msgpack.Stream(s);
    ms.send('a');
    ms.send('b');
    ms.send('c');
    s.emit('drain');
    assert.equal(s.writes.length, 2);
    s.emit('drain');
    assert.equal(s.writes.length, 3);
    assert.deepEqual(
      s.writes.map((w) => msgpack.unpack(w.chunk)),
      ['a', 'b', 'c']
    );
  });

  it('does not spin if write emits drain synchronously during flush', () => {
    const s = new EventEmitter();
    let n = 0;
    s.write = function () {
      n += 1;
      if (n === 1) {
        return false;
      }
      s.emit('drain');
      return true;
    };
    const ms = new msgpack.Stream(s);
    ms.send('a');
    ms.send('b');
    ms.send('c');
    s.emit('drain');
    assert.equal(n, 3);
  });

  it('emits error and drops the queue on close with pending sends', () => {
    const s = mockWritable([false]);
    const ms = new msgpack.Stream(s);
    const errors = [];
    ms.on('error', (e) => errors.push(e));
    ms.send('one');
    ms.send('two');
    s.emit('close');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /unsent|backpressure/);
    s.emit('drain');
    assert.equal(s.writes.length, 1);
  });

  it('does not emit error on close or end when the queue is empty', () => {
    const s = mockWritable([true]);
    const ms = new msgpack.Stream(s);
    const errors = [];
    ms.on('error', (e) => errors.push(e));
    ms.send('one');
    s.emit('close');
    s.emit('end');
    assert.equal(errors.length, 0);
    const sockErr = new Error('socket');
    s.emit('error', sockErr);
    /* An 'error' listener on the socket counts as handled in Node, so the
     * original socket error must still reach Stream. */
    assert.equal(errors.length, 1);
    assert.strictEqual(errors[0], sockErr);
  });

  it('drops the queue on underlying error and end', () => {
    const s = mockWritable([false]);
    const ms = new msgpack.Stream(s);
    const errors = [];
    ms.on('error', (e) => errors.push(e));
    ms.send('a');
    ms.send('b');
    const sockErr = new Error('socket');
    s.emit('error', sockErr);
    /* Queue-drop error first, then the original socket error once. */
    assert.equal(errors.length, 2);
    assert.match(errors[0].message, /unsent|backpressure/);
    assert.strictEqual(errors[1], sockErr);

    const s2 = mockWritable([false]);
    const ms2 = new msgpack.Stream(s2);
    const errors2 = [];
    ms2.on('error', (e) => errors2.push(e));
    ms2.send('a');
    ms2.send('b');
    s2.emit('end');
    assert.equal(errors2.length, 1);
  });

  it('invokes queued callbacks when the queue is dropped', (t, done) => {
    const s = mockWritable([false]);
    const ms = new msgpack.Stream(s);
    ms.on('error', () => {});
    ms.send('one');
    ms.send('two', (err) => {
      assert.ok(err);
      assert.match(err.message, /unsent|backpressure/);
      done();
    });
    s.emit('close');
  });

  it('emits msg for a complete packet', () => {
    const s = new EventEmitter();
    const ms = new msgpack.Stream(s);
    ms.addListener('msg', stub());
    s.emit('data', msgpack.pack('hello'));
    assert.equal(ms.listeners('msg')[0].called, true);
    assert.equal(ms.listeners('msg')[0].args.length, 1);
    assert.equal(ms.listeners('msg')[0].args[0], 'hello');
  });

  it('parses two messages split across data events', () => {
    const s = new EventEmitter();
    const ms = new msgpack.Stream(s);
    ms.addListener('msg', stub());
    const packed = msgpack.pack('hello');
    s.emit('data', packed.subarray(0, packed.length - 1));
    assert.equal(ms.listeners('msg')[0].called, false);
    s.emit('data', packed.subarray(packed.length - 1));
    assert.equal(ms.listeners('msg')[0].called, true);
    assert.equal(ms.listeners('msg')[0].args.length, 1);
    assert.equal(ms.listeners('msg')[0].args[0], 'hello');
  });

  it('emits msg for a packed zero', () => {
    /* msgpack-node#44: the loop tested `msg === null` against a falsy check,
     * so a packed integer 0 was swallowed as "incomplete". */
    const s = new EventEmitter();
    const ms = new msgpack.Stream(s);
    const msgs = [];
    ms.addListener('msg', (m) => msgs.push(m));

    s.emit('data', msgpack.pack(0));

    assert.equal(msgs.length, 1);
    assert.equal(typeof msgs[0], 'number');
    assert.equal(msgs[0], 0);

    /* And a 0 framed alongside neighbours still advances the buffer. */
    s.emit('data', Buffer.concat([msgpack.pack(0), msgpack.pack('after')]));
    assert.deepEqual(msgs, [0, 0, 'after']);
  });

  it('emits msg for a packed null', () => {
    /* A decoded nil is a message, not an incomplete buffer. */
    const s = new EventEmitter();
    const ms = new msgpack.Stream(s);
    const msgs = [];
    ms.addListener('msg', (m) => msgs.push(m));
    s.emit('data', msgpack.pack(null));
    s.emit('data', Buffer.concat([msgpack.pack(null), msgpack.pack('after')]));
    assert.deepEqual(msgs, [null, null, 'after']);
  });

  it('waits on a truncated payload without emitting', () => {
    const s = new EventEmitter();
    const ms = new msgpack.Stream(s);
    ms.addListener('msg', stub());
    const packed = msgpack.pack({ a: 'abc', b: [1, 2, 3] });
    s.emit('data', packed.subarray(0, packed.length - 1));
    assert.equal(ms.listeners('msg')[0].called, false);
  });

  it('emits error instead of throwing when unpack fails', () => {
    /* array32 header claiming 0xff000000 elements: unpack throws, and the
     * data listener must not turn that into an uncaughtException. */
    const s = new EventEmitter();
    const ms = new msgpack.Stream(s);
    const errors = [];
    ms.addListener('error', (e) => errors.push(e));
    ms.addListener('msg', stub());

    s.emit('data', Buffer.from([0xdd, 0xff, 0x00, 0x00, 0x00]));

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /limit exceeded/);
    assert.equal(ms.listeners('msg')[0].called, false);
    /* The bomb is dropped, not retried: a following good packet parses. */
    s.emit('data', msgpack.pack('ok'));
    assert.equal(ms.listeners('msg')[0].args[0], 'ok');
    assert.equal(errors.length, 1);
  });

  it('delivers both frames when a msg listener calls unpack', () => {
    /* bytesRemaining is thread_local native state: a listener that unpacks
     * anything overwrites the value this loop needs to advance self.buf. */
    const s = new EventEmitter();
    const ms = new msgpack.Stream(s);
    const msgs = [];
    ms.addListener('msg', (m) => {
      msgs.push(m);
      msgpack.unpack(Buffer.from([0x02]));
    });

    s.emit('data', Buffer.concat([msgpack.pack({ n: 1 }), msgpack.pack({ n: 2 })]));

    assert.deepEqual(msgs, [{ n: 1 }, { n: 2 }]);
  });

  it('does not re-emit a frame whose msg listener threw', () => {
    /* Emitting before advancing self.buf left the frame queued, so the next
     * data event replayed it: seen became ['one', 'one', 'two', 'three']. */
    const s = new EventEmitter();
    const ms = new msgpack.Stream(s);
    const seen = [];
    let first = true;
    ms.addListener('msg', (m) => {
      seen.push(m);
      if (first) {
        first = false;
        throw new Error('listener blew up');
      }
    });

    assert.throws(() => s.emit('data', msgpack.pack('one')), /listener blew up/);
    s.emit('data', Buffer.concat([msgpack.pack('two'), msgpack.pack('three')]));

    assert.deepEqual(seen, ['one', 'two', 'three']);
  });

  function hugeChunk(n) {
    return {
      length: n,
      copy() {
        throw new Error('copy should not run');
      },
    };
  }

  it('rejects a receive concat that would exceed MAX_STREAM_BYTES before allocate', () => {
    const s = new EventEmitter();
    let destroyed = 0;
    /* Node's stream.destroy(err) emits 'error' on the socket. */
    s.destroy = function (err) {
      destroyed += 1;
      if (err) s.emit('error', err);
    };
    const ms = new msgpack.Stream(s);
    const errors = [];
    ms.addListener('error', (e) => errors.push(e));
    const packed = msgpack.pack('hello');
    s.emit('data', packed.subarray(0, packed.length - 1));
    assert.ok(ms.buf);
    s.emit('data', hugeChunk(msgpack.MAX_STREAM_BYTES));
    assert.equal(ms.buf, null);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /stream limit exceeded/);
    assert.equal(destroyed, 1);
    /* Further data is ignored after the cap fires. */
    s.emit('data', msgpack.pack('ok'));
    assert.equal(errors.length, 1);
  });

  it('rejects a first chunk longer than MAX_STREAM_BYTES', () => {
    const s = new EventEmitter();
    let destroyed = 0;
    s.destroy = function (err) {
      destroyed += 1;
      if (err) s.emit('error', err);
    };
    const ms = new msgpack.Stream(s);
    const errors = [];
    ms.addListener('error', (e) => errors.push(e));
    s.emit('data', hugeChunk(msgpack.MAX_STREAM_BYTES + 1));
    assert.equal(ms.buf, null);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /stream limit exceeded/);
    assert.equal(destroyed, 1);
  });

  it('drops buf on close, end, and error of the underlying stream', () => {
    const packed = msgpack.pack('hello');
    for (const ev of ['close', 'end', 'error']) {
      const s = new EventEmitter();
      const ms = new msgpack.Stream(s);
      const errors = [];
      ms.addListener('error', (e) => errors.push(e));
      s.emit('data', packed.subarray(0, packed.length - 1));
      assert.ok(ms.buf, ev);
      if (ev === 'error') {
        const sockErr = new Error('socket down');
        s.emit('error', sockErr);
        assert.equal(errors.length, 1, ev);
        assert.strictEqual(errors[0], sockErr, ev);
      } else {
        s.emit(ev);
        assert.equal(errors.length, 0, ev);
      }
      assert.equal(ms.buf, null, ev);
    }
  });

  it('round-trips over a TCP socket', (t, done) => {
    const server = net.createServer((c) => {
      c.write(msgpack.pack('hello '));
      setTimeout(() => {
        c.end(msgpack.pack('world'));
      }, 50);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const client = net.createConnection(addr.port, addr.address);
      const msgs = [];
      client.on('connect', () => {
        const ms = new msgpack.Stream(client);
        ms.addListener('msg', (m) => {
          msgs.push(m);
          if (msgs.length === 2) {
            assert.deepEqual(msgs, ['hello ', 'world']);
            server.close();
            done();
          }
        });
      });
    });
  });
});

describe('bin scripts', () => {
  const bin = (name) => path.join(__dirname, '..', 'bin', name);
  const run = (name, input) =>
    execFileSync(process.execPath, [bin(name)], { input, maxBuffer: 1 << 20 });

  it('msgpack2json writes JSON for a packed value', () => {
    const out = run('msgpack2json', msgpack.pack({ a: 1, b: [2, 3] }));
    assert.deepEqual(JSON.parse(out.toString('utf8')), { a: 1, b: [2, 3] });
  });

  it('msgpack2json writes one line per concatenated message', () => {
    const input = Buffer.concat([msgpack.pack('one'), msgpack.pack('two')]);
    const lines = run('msgpack2json', input).toString('utf8').trim().split('\n');
    assert.deepEqual(lines, ['"one"', '"two"']);
  });

  it('json2msgpack writes MessagePack for JSON on stdin', () => {
    const out = run('json2msgpack', '{"a":1,"b":[2,3]}');
    assert.deepEqual(msgpack.unpack(out), { a: 1, b: [2, 3] });
  });

  it('json2msgpack and msgpack2json round-trip', () => {
    const packed = run('json2msgpack', '{"hello":"world"}');
    const json = run('msgpack2json', packed).toString('utf8');
    assert.deepEqual(JSON.parse(json), { hello: 'world' });
  });
});
