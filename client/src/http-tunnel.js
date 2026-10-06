import http from "node:http";
import https from "node:https";
import { CHUNK, F_BODY, F_WS_BIN, F_WS_TEXT, HOP_BY_HOP, WINDOW, encodeFrame } from "./protocol.js";

const WS_SKIP_HEADERS = new Set([...HOP_BY_HOP, "host", "content-length", "accept-encoding"]);

// Forwards HTTP requests and WebSocket sessions arriving from the Worker to local services.
export class HttpProxy {
  constructor({ conn, manager, logger }) {
    this.conn = conn;
    this.manager = manager;
    this.logger = logger;
    this.streams = new Map(); // id -> HTTP exchange
    this.sockets = new Map(); // id -> proxied WebSocket
    this.agents = new Map(); // "scheme://host:port" -> keep-alive agent
  }

  handle(msg) {
    switch (msg.t) {
      case "req":
        return this.onRequest(msg);
      case "req_end":
        return this.streams.get(msg.id)?.req?.end();
      case "cancel":
        return this.cancel(msg.id);
      case "ack":
        return this.onAck(msg.id, msg.n);
      case "ws_open":
        return this.onWsOpen(msg);
      case "ws_close":
        return this.onWsClose(msg);
    }
  }

  handleFrame({ type, id, payload }) {
    if (type === F_BODY) return this.onBody(id, payload);
    const sock = this.sockets.get(id);
    if (!sock?.open) return;
    sock.bytesIn += payload.length;
    this.manager.addBytes(sock.tunnel, payload.length, 0);
    try {
      sock.ws.send(type === F_WS_TEXT ? payload.toString("utf8") : payload);
    } catch {}
  }

  // ------------------------------------------------------------------ HTTP

  onRequest(msg) {
    const tunnel = this.manager.get(msg.tunnel);
    if (!tunnel || !tunnel.enabled) {
      this.conn.send({ t: "err", id: msg.id, status: 503, message: "Tunnel đang tắt trên máy local." });
      return;
    }
    const s = {
      id: msg.id,
      tunnel: tunnel.id,
      method: msg.method,
      path: msg.path,
      started: Date.now(),
      status: 0,
      bytesIn: 0,
      bytesOut: 0,
      inflight: 0, // response bytes sent to the Worker but not yet acknowledged
      req: null,
      res: null,
      done: false,
      error: null,
    };
    this.streams.set(s.id, s);
    this.manager.streamOpened(tunnel.id);

    const lib = tunnel.localScheme === "https" ? https : http;
    const req = lib.request({
      host: stripBrackets(tunnel.localHost),
      port: tunnel.localPort,
      method: msg.method,
      path: msg.path,
      headers: localHeaders(msg.headers, tunnel),
      setHost: false,
      agent: this.agentFor(tunnel),
    });
    s.req = req;
    req.on("response", (res) => this.onResponse(s, tunnel, res));
    req.on("error", (err) => this.onLocalError(s, tunnel, err));
    if (!msg.body) req.end();
  }

  onBody(id, payload) {
    const s = this.streams.get(id);
    if (!s?.req || s.done) return;
    const n = payload.length;
    s.bytesIn += n;
    this.manager.addBytes(s.tunnel, n, 0);
    s.req.write(payload, () => this.conn.send({ t: "ack", id, n }));
  }

  onResponse(s, tunnel, res) {
    if (s.done) {
      res.destroy();
      return;
    }
    s.res = res;
    s.status = res.statusCode;
    const headers = [];
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      const name = res.rawHeaders[i];
      const key = name.toLowerCase();
      if (HOP_BY_HOP.has(key)) continue;
      const value = key === "location" ? relativeLocation(res.rawHeaders[i + 1], tunnel) : res.rawHeaders[i + 1];
      headers.push([name, value]);
    }
    this.conn.send({ t: "res", id: s.id, status: res.statusCode, statusText: res.statusMessage, headers });

    res.on("data", (chunk) => {
      for (let off = 0; off < chunk.length; off += CHUNK) {
        this.conn.sendRaw(encodeFrame(F_BODY, s.id, chunk.subarray(off, off + CHUNK)));
      }
      s.inflight += chunk.length;
      s.bytesOut += chunk.length;
      this.manager.addBytes(s.tunnel, 0, chunk.length);
      if (s.inflight >= WINDOW) res.pause();
    });
    res.on("end", () => {
      if (s.done) return;
      this.conn.send({ t: "end", id: s.id });
      this.finish(s);
    });
    res.on("error", (err) => this.onLocalError(s, tunnel, err));
    res.on("close", () => {
      if (!s.done) this.onLocalError(s, tunnel, new Error("Dịch vụ local đóng kết nối giữa chừng."));
    });
  }

  onAck(id, n) {
    const s = this.streams.get(id);
    if (!s) return;
    s.inflight -= Number(n) || 0;
    if (s.res?.isPaused() && s.inflight < WINDOW) s.res.resume();
  }

  onLocalError(s, tunnel, err) {
    if (s.done) return;
    const message = describeError(err, tunnel);
    this.conn.send({ t: "err", id: s.id, status: err.code === "ETIMEDOUT" ? 504 : 502, message });
    this.manager.recordError(tunnel.id, message, err.code);
    s.error = message;
    s.req?.destroy();
    this.finish(s);
  }

  cancel(id) {
    const s = this.streams.get(id);
    if (!s) return;
    s.error = "Người truy cập đã hủy request";
    s.req?.destroy();
    this.finish(s);
  }

  finish(s) {
    if (s.done) return;
    s.done = true;
    this.streams.delete(s.id);
    this.manager.streamClosed(s.tunnel, {
      method: s.method,
      path: s.path,
      status: s.status,
      ms: Date.now() - s.started,
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
      error: s.error,
    });
  }

  agentFor(tunnel) {
    const key = `${tunnel.localScheme}://${tunnel.localHost}:${tunnel.localPort}`;
    let agent = this.agents.get(key);
    if (!agent) {
      agent =
        tunnel.localScheme === "https"
          ? new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false }) // local certs are usually self-signed
          : new http.Agent({ keepAlive: true, maxSockets: 64 });
      this.agents.set(key, agent);
    }
    return agent;
  }

  // ------------------------------------------------------------------ WebSocket

  onWsOpen(msg) {
    const tunnel = this.manager.get(msg.tunnel);
    if (!tunnel || !tunnel.enabled) {
      this.conn.send({ t: "ws_err", id: msg.id, status: 503, message: "Tunnel đang tắt trên máy local." });
      return;
    }
    const headers = {};
    for (const [k, v] of msg.headers) {
      if (!WS_SKIP_HEADERS.has(k) && !k.startsWith("sec-websocket-")) headers[k] = v;
    }
    const protocols = String(msg.protocols || "").split(",").map((p) => p.trim()).filter(Boolean);
    const url = `${tunnel.localScheme === "https" ? "wss" : "ws"}://${hostPort(tunnel)}${msg.path}`;

    let ws;
    try {
      ws = new WebSocket(url, { protocols, headers });
    } catch (err) {
      this.conn.send({ t: "ws_err", id: msg.id, status: 502, message: `Không mở được WebSocket local: ${err.message}` });
      return;
    }
    ws.binaryType = "arraybuffer";
    const sock = { id: msg.id, tunnel: tunnel.id, path: msg.path, ws, open: false, started: Date.now(), bytesIn: 0, bytesOut: 0 };
    this.sockets.set(sock.id, sock);
    this.manager.streamOpened(tunnel.id);

    ws.onopen = () => {
      sock.open = true;
      this.conn.send({ t: "ws_ok", id: sock.id, protocol: ws.protocol });
    };
    ws.onmessage = (ev) => {
      const text = typeof ev.data === "string";
      const payload = Buffer.from(text ? ev.data : new Uint8Array(ev.data));
      sock.bytesOut += payload.length;
      this.manager.addBytes(sock.tunnel, 0, payload.length);
      this.conn.sendRaw(encodeFrame(text ? F_WS_TEXT : F_WS_BIN, sock.id, payload));
    };
    const closed = (code, reason) => {
      if (!this.sockets.has(sock.id)) return;
      if (sock.open) {
        this.conn.send({ t: "ws_close", id: sock.id, code, reason });
      } else {
        const message = `Dịch vụ local không chấp nhận WebSocket tại ${url}.`;
        this.conn.send({ t: "ws_err", id: sock.id, status: 502, message });
        sock.error = message;
      }
      this.finishSocket(sock);
    };
    ws.onclose = (ev) => closed(ev.code, ev.reason);
    // Node's WebSocket fires only "error" (no "close") when the handshake fails.
    ws.onerror = () => {
      if (!sock.open) closed(1006, "");
    };
  }

  onWsClose(msg) {
    const sock = this.sockets.get(msg.id);
    if (!sock) return;
    const code = msg.code === 1000 || (msg.code >= 3000 && msg.code <= 4999) ? msg.code : 1000;
    try {
      sock.ws.close(code, String(msg.reason || "").slice(0, 120));
    } catch {}
    this.finishSocket(sock);
  }

  finishSocket(sock) {
    if (!this.sockets.delete(sock.id)) return;
    this.manager.streamClosed(sock.tunnel, {
      method: "WS",
      path: sock.path,
      status: sock.open ? 101 : 0,
      ms: Date.now() - sock.started,
      bytesIn: sock.bytesIn,
      bytesOut: sock.bytesOut,
      error: sock.error || null,
    });
  }

  // ------------------------------------------------------------------ lifecycle

  closeTunnel(tunnelId, reason = "Tunnel đã dừng") {
    for (const s of [...this.streams.values()]) {
      if (tunnelId && s.tunnel !== tunnelId) continue;
      s.error = reason;
      s.req?.destroy();
      this.finish(s);
    }
    for (const sock of [...this.sockets.values()]) {
      if (tunnelId && sock.tunnel !== tunnelId) continue;
      try {
        sock.ws.close(1000, reason);
      } catch {}
      this.finishSocket(sock);
    }
  }

  closeAll(reason) {
    this.closeTunnel(null, reason);
  }
}

function localHeaders(pairs, tunnel) {
  const out = {};
  let publicHost = "";
  for (const [k, v] of pairs) {
    if (k === "host") {
      publicHost = v;
      continue;
    }
    if (HOP_BY_HOP.has(k)) continue;
    out[k] = k in out ? `${out[k]}${k === "cookie" ? "; " : ", "}${v}` : v;
  }
  // Most dev servers (Vite, webpack, Django...) reject unknown Host values, so default to the local address.
  out.host = tunnel.hostHeader === "preserve" && publicHost ? publicHost : hostPort(tunnel);
  return out;
}

// Turn redirects to http://127.0.0.1:8001/x into /x so visitors stay on the public URL.
function relativeLocation(value, tunnel) {
  try {
    const url = new URL(value);
    const local = new Set([stripBrackets(tunnel.localHost), "localhost", "127.0.0.1", "::1"]);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (local.has(stripBrackets(url.hostname)) && port === tunnel.localPort) return url.pathname + url.search + url.hash;
  } catch {}
  return value;
}

function describeError(err, tunnel) {
  const where = `${tunnel.localScheme}://${hostPort(tunnel)}`;
  switch (err.code) {
    case "ECONNREFUSED":
      return `Không kết nối được tới ${where} — ứng dụng local chưa chạy?`;
    case "ECONNRESET":
      return `Ứng dụng tại ${where} đã ngắt kết nối đột ngột.`;
    case "ETIMEDOUT":
      return `Ứng dụng tại ${where} không phản hồi (timeout).`;
    case "ENOTFOUND":
      return `Không tìm thấy máy "${tunnel.localHost}".`;
    case "EPROTO":
    case "ERR_SSL_WRONG_VERSION_NUMBER":
      return `Lỗi TLS khi nói chuyện với ${where} — thử đổi giao thức local giữa http/https.`;
    default:
      return `Lỗi khi gọi ${where}: ${err.code || err.message}`;
  }
}

export function hostPort(tunnel) {
  const host = tunnel.localHost.includes(":") && !tunnel.localHost.startsWith("[") ? `[${tunnel.localHost}]` : tunnel.localHost;
  return `${host}:${tunnel.localPort}`;
}

function stripBrackets(host) {
  return host.replace(/^\[|\]$/g, "");
}
