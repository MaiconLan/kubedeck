import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptKey, encodeFrame, FrameParser, OP_CONT, OP_TEXT } from './ws.js';

/** A client frame: always masked. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0, 0x80 | len]) : Buffer.from([0, 0x80 | 126, len >> 8, len & 0xff]);
  head[0] = (fin ? 0x80 : 0) | opcode;
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  return Buffer.concat([head, mask, body]);
}

test('accept key from RFC 6455', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('server frames use the shortest length form', () => {
  assert.deepEqual([...encodeFrame(OP_TEXT, Buffer.from('hi')).subarray(0, 2)], [0x81, 2]);
  const mid = encodeFrame(OP_TEXT, Buffer.alloc(300));
  assert.equal(mid[1], 126);
  assert.equal(mid.readUInt16BE(2), 300);
  const big = encodeFrame(OP_TEXT, Buffer.alloc(70_000));
  assert.equal(big[1], 127);
  assert.equal(Number(big.readBigUInt64BE(2)), 70_000);
});

test('parser unmasks and waits for the whole frame', () => {
  const parser = new FrameParser();
  const frame = clientFrame(OP_TEXT, Buffer.from('hello'));
  assert.deepEqual(parser.push(frame.subarray(0, 4)), []);
  const [f] = parser.push(frame.subarray(4));
  assert.equal(f.opcode, OP_TEXT);
  assert.equal(f.payload.toString(), 'hello');
});

test('parser reads several frames in one chunk, including 16-bit lengths', () => {
  const long = 'x'.repeat(1000);
  const frames = new FrameParser().push(Buffer.concat([
    clientFrame(OP_TEXT, Buffer.from('a'), false),
    clientFrame(OP_CONT, Buffer.from('b')),
    clientFrame(OP_TEXT, Buffer.from(long)),
  ]));
  assert.deepEqual(frames.map((f) => [f.opcode, f.fin, f.payload.toString()]), [[OP_TEXT, false, 'a'], [OP_CONT, true, 'b'], [OP_TEXT, true, long]]);
});

test('parser rejects unmasked client frames', () => {
  assert.throws(() => new FrameParser().push(Buffer.from([0x81, 0x01, 0x41])));
});
