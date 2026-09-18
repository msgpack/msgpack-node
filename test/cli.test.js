'use strict';

/*
 * Error and edge paths of bin/json2msgpack and bin/msgpack2json. The happy
 * paths live in msgpack.test.js; these cover the branches that set
 * process.exitCode and write to stderr.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const msgpack = require('../lib/msgpack');

const bin = (name) => path.join(__dirname, '..', 'bin', name);

function run(name, input) {
  const r = spawnSync(process.execPath, [bin(name)], {
    input,
    maxBuffer: 1 << 22,
  });
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null, 'child must not be killed by a signal');
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr.toString('utf8'),
  };
}

describe('json2msgpack error paths', () => {
  it('exits 1 with a message on invalid JSON', () => {
    const r = run('json2msgpack', '{not json');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /json2msgpack: invalid JSON on stdin: /);
    assert.equal(r.stdout.length, 0);
  });

  it('exits 1 on empty stdin', () => {
    /* JSON.parse('') throws, so empty input is an invalid-JSON error. */
    const r = run('json2msgpack', '');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /json2msgpack: invalid JSON on stdin: /);
  });

  it('exits 1 when pack rejects the parsed value', () => {
    /* JSON.parse can produce arbitrarily deep nesting, which pack caps at
     * 512 levels. This is the only pack failure reachable from real JSON:
     * every other JSON value type packs. */
    const deep = '['.repeat(600) + '1' + ']'.repeat(600);
    const r = run('json2msgpack', deep);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /json2msgpack: Cowardly refusing to pack object nested/);
    assert.equal(r.stdout.length, 0);
  });

  it('accepts JSON split across several stdin chunks', () => {
    const big = JSON.stringify({ s: 'x'.repeat(200000) });
    const r = run('json2msgpack', big);
    assert.equal(r.status, 0);
    assert.deepEqual(msgpack.unpack(r.stdout), JSON.parse(big));
  });

  it('packs a bare JSON scalar', () => {
    for (const [text, want] of [['null', null], ['true', true], ['42', 42], ['"s"', 's']]) {
      const r = run('json2msgpack', text);
      assert.equal(r.status, 0, text);
      assert.equal(msgpack.unpack(r.stdout), want, text);
    }
  });
});

describe('msgpack2json error paths', () => {
  it('exits 1 with a message on an unparseable byte', () => {
    const r = run('msgpack2json', Buffer.from([0xc1]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /msgpack2json: Encountered error unpacking buffer/);
    assert.equal(r.stdout.length, 0);
  });

  it('exits 1 when unpack rejects an oversized header', () => {
    const r = run('msgpack2json', Buffer.from([0xdd, 0xff, 0x00, 0x00, 0x00]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /msgpack2json: msgpack unpack limit exceeded/);
  });

  it('exits 1 on incomplete MessagePack data', () => {
    /* bin8 tag with no length byte: nothing can be consumed. */
    const r = run('msgpack2json', Buffer.from([0xc4]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /msgpack2json: incomplete MessagePack data on stdin/);
    assert.equal(r.stdout.length, 0);
  });

  it('exits 1 when a trailing message is incomplete', () => {
    /* One good frame is printed, then the truncated tail is reported. */
    const input = Buffer.concat([msgpack.pack('one'), Buffer.from([0xa5, 0x61])]);
    const r = run('msgpack2json', input);
    assert.equal(r.status, 1);
    assert.equal(r.stdout.toString('utf8'), '"one"\n');
    assert.match(r.stderr, /incomplete MessagePack data on stdin/);
  });

  it('exits 0 with no output on empty stdin', () => {
    const r = run('msgpack2json', Buffer.alloc(0));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.length, 0);
    assert.equal(r.stderr, '');
  });

  it('prints a decoded nil frame rather than treating it as incomplete', () => {
    const input = Buffer.concat([msgpack.pack(null), msgpack.pack(0)]);
    const r = run('msgpack2json', input);
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.toString('utf8').trim().split('\n'), ['null', '0']);
  });

  it('reads MessagePack split across several stdin chunks', () => {
    const value = { s: 'y'.repeat(200000) };
    const r = run('msgpack2json', msgpack.pack(value));
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout.toString('utf8')), value);
  });
});
