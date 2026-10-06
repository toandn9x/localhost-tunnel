// Wire format shared with worker/src/worker.js — keep both in sync.
//   text frames:   JSON control messages, `t` is the message type
//   binary frames: [type u8][stream id u32 BE][payload]

export const PROTOCOL_VERSION = 1;

export const F_BODY = 1;
export const F_WS_TEXT = 2;
export const F_WS_BIN = 3;

export const CHUNK = 64 * 1024;
export const WINDOW = 512 * 1024;

export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';

export const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

export function encodeFrame(type, id, payload) {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = type;
  frame.writeUInt32BE(id, 1);
  payload.copy(frame, 5);
  return frame;
}

export function decodeFrame(data) {
  const buf = Buffer.from(data);
  if (buf.length < 5) return null;
  return { type: buf[0], id: buf.readUInt32BE(1), payload: buf.subarray(5) };
}
