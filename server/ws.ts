import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Minimal WebSocket server side (RFC 6455): text messages, ping/pong and close.
 * Enough for the terminal; the project has no runtime dependencies, so no `ws` package.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** One unmasked server frame (servers must not mask). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) {
    head[1] = len;
  } else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Splits incoming bytes into frames; client frames must be masked. Throws on a protocol error. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      if (b0 & 0x70) throw new Error('reserved bits set');
      if (!(b1 & 0x80)) throw new Error('client frame not masked');
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) throw new Error('frame too large');
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_MESSAGE) throw new Error('frame too large');
      if (this.buf.length < offset + 4 + len) break;
      const mask = this.buf.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buf.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      frames.push({ fin: !!(b0 & 0x80), opcode: b0 & 0x0f, payload });
      this.buf = this.buf.subarray(offset + 4 + len);
    }
    return frames;
  }
}

export interface WsConnection {
  send(text: string): void;
  close(code?: number): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: () => void): void;
  readonly closed: boolean;
}

/** Completes the handshake on an `upgrade` request. Returns undefined (and answers 400) when it is not a WebSocket request. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): WsConnection | undefined {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return undefined;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );

  const parser = new FrameParser();
  const messageFns: Array<(text: string) => void> = [];
  const closeFns: Array<() => void> = [];
  let parts: Buffer[] = [];
  let partsOp = 0;
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    for (const fn of closeFns) fn();
  };
  const close = (code = 1000) => {
    if (!closed && socket.writable) {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code);
      socket.write(encodeFrame(OP_CLOSE, body));
      socket.end();
    }
    finish();
  };

  socket.on('data', (chunk: Buffer) => {
    let frames: Frame[];
    try {
      frames = parser.push(chunk);
    } catch {
      close(1002);
      socket.destroy();
      return;
    }
    for (const f of frames) {
      if (f.opcode === OP_PING) {
        socket.write(encodeFrame(OP_PONG, f.payload));
      } else if (f.opcode === OP_CLOSE) {
        close();
        return;
      } else if (f.opcode === OP_TEXT || f.opcode === OP_BINARY || f.opcode === OP_CONT) {
        if (f.opcode !== OP_CONT) {
          parts = [];
          partsOp = f.opcode;
        }
        parts.push(f.payload);
        if (f.fin) {
          const data = Buffer.concat(parts);
          parts = [];
          if (partsOp === OP_TEXT) for (const fn of messageFns) fn(data.toString('utf8'));
        }
      }
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);

  return {
    send(text) {
      if (!closed && socket.writable) socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
    },
    close,
    onMessage: (fn) => messageFns.push(fn),
    onClose: (fn) => closeFns.push(fn),
    get closed() {
      return closed;
    },
  };
}
