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
