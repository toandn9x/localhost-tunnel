// Mini Tunnel — Cloudflare Worker (HTTP/HTTPS + WebSocket).
//
// Every request goes to a single Durable Object (TunnelHub). The local client keeps one
// WebSocket open to it at /__tunnel/connect; public requests are multiplexed over that
// socket and answered with whatever the local service returns.
//
// Wire format between hub and client:
//   - text frames: JSON control messages, `t` is the message type
//   - binary frames: [type u8][stream id u32 BE][payload] for bodies and WebSocket data

import { DurableObject } from "cloudflare:workers";

const VERSION = 1;
const PREFIX = "/__tunnel/";
const CHUNK = 64 * 1024; // max payload per binary frame
const WINDOW = 512 * 1024; // unacknowledged bytes allowed per stream, each direction
const RESPONSE_TIMEOUT_MS = 100_000;
const WS_OPEN_TIMEOUT_MS = 15_000;
const MAX_TUNNELS = 50;

const F_BODY = 1;
const F_WS_TEXT = 2;
const F_WS_BIN = 3;

const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(PREFIX)) {
      const denied = await checkToken(request, env);
      if (denied) return denied;
      if (url.pathname === PREFIX + "ping") return Response.json({ ok: true, version: VERSION });
      if (url.pathname !== PREFIX + "connect") return text(404, "Not found");
    }
    if (!env.TUNNEL_HUB) {
      return text(500, 'Worker misconfigured: missing Durable Object binding "TUNNEL_HUB" in wrangler.toml');
    }
    const hub = env.TUNNEL_HUB.get(env.TUNNEL_HUB.idFromName("default"));
    return hub.fetch(request);
  },
};

async function checkToken(request, env) {
  if (!env.TUNNEL_TOKEN) {
    return text(503, "TUNNEL_TOKEN is not configured on this Worker (run: wrangler secret put TUNNEL_TOKEN)");
  }
  const header = request.headers.get("Authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Hash both sides so the comparison is constant-time regardless of length.
  const [a, b] = await Promise.all(
    [given, env.TUNNEL_TOKEN].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
  return crypto.subtle.timingSafeEqual(a, b) ? null : text(401, "Invalid token");
}

export class TunnelHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.streams = new Map(); // id -> in-flight HTTP stream
    this.pendingWs = new Map(); // id -> public WebSocket waiting for the local side to open
    this.tunnels = null; // registry pushed by the client, cached from storage
    // Heartbeats are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === PREFIX + "connect") return this.acceptAgent(request, url);
    return this.handlePublic(request, url);
  }

  // ---------------------------------------------------------------- agent socket

  agent() {
    const open = this.ctx.getWebSockets("agent").filter((ws) => ws.readyState === WebSocket.OPEN);
    return open[open.length - 1] ?? null;
  }

  acceptAgent(request, url) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return text(426, "Expected WebSocket");
    const previous = this.ctx.getWebSockets("agent");
    if (previous.length) {
      this.failAll("Tunnel client reconnected");
      for (const old of previous) safeClose(old, 4000, "Replaced by a newer connection");
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ["agent"]);
    server.send(JSON.stringify({ t: "welcome", version: VERSION, origin: url.origin }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async getTunnels() {
    this.tunnels ??= (await this.ctx.storage.get("tunnels")) ?? [];
    return this.tunnels;
  }

  async register(ws, msg) {
    const tunnels = (Array.isArray(msg.tunnels) ? msg.tunnels : [])
      .slice(0, MAX_TUNNELS)
      .filter((t) => t && ID_RE.test(t.id))
      .map((t) => ({
        id: t.id,
        name: String(t.name || t.id).slice(0, 60),
        route: ["root", "path", "host"].includes(t.route) ? t.route : "path",
        hostname: typeof t.hostname === "string" && HOST_RE.test(t.hostname.toLowerCase()) ? t.hostname.toLowerCase() : "",
        enabled: t.enabled !== false,
      }));
    this.tunnels = tunnels;
    await this.ctx.storage.put("tunnels", tunnels);
    send(ws, { t: "registered", count: tunnels.length });
  }

  async webSocketMessage(ws, message) {
    const tags = this.ctx.getTags(ws);
    if (tags.includes("agent")) return this.onAgentMessage(ws, message);

    // Message from a public visitor's WebSocket: forward to the client.
    const id = pubId(tags);
    const agent = this.agent();
    if (id === null || !agent) return safeClose(ws, 1011, "Tunnel offline");
    if (typeof message === "string") sendFrame(agent, F_WS_TEXT, id, encoder.encode(message));
    else sendFrame(agent, F_WS_BIN, id, new Uint8Array(message));
  }

  async webSocketClose(ws, code, reason) {
    this.onSocketGone(ws, code, reason);
  }

  async webSocketError(ws) {
    this.onSocketGone(ws, 1011, "WebSocket error");
  }

  onSocketGone(ws, code, reason) {
    const tags = this.ctx.getTags(ws);
    safeClose(ws, code, reason);
    if (tags.includes("agent")) {
      const current = this.agent();
      if (!current || current === ws) this.failAll("Tunnel client disconnected");
      return;
    }
    const id = pubId(tags);
    const agent = this.agent();
    if (id !== null && agent) send(agent, { t: "ws_close", id, code, reason });
  }

  async onAgentMessage(ws, message) {
    if (typeof message !== "string") {
      if (message.byteLength < 5) return;
      const type = new Uint8Array(message, 0, 1)[0];
      const id = new DataView(message).getUint32(1);
      const payload = message.slice(5);
      if (type === F_BODY) {
        const s = this.streams.get(id);
        if (s) this.onBodyChunk(s, payload);
      } else {
        const pub = this.ctx.getWebSockets(`pub:${id}`)[0];
        if (pub) {
          try {
            pub.send(type === F_WS_TEXT ? decoder.decode(payload) : payload);
          } catch {}
        }
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const s = typeof msg.id === "number" ? this.streams.get(msg.id) : undefined;
    switch (msg.t) {
      case "register":
        return this.register(ws, msg);
      case "res":
        if (s) this.onResponseHead(s, msg);
        return;
      case "end":
        if (s) this.finishStream(s);
        return;
      case "err":
        if (s) this.failStream(s, msg.status || 502, msg.message || "Local service error", false);
        return;
      case "ack":
        if (s) this.onUploadAck(s, msg.n);
        return;
      case "ws_ok":
      case "ws_err": {
        const pending = this.pendingWs.get(msg.id);
        if (pending) pending.settle(msg);
        return;
      }
      case "ws_close": {
        const pub = this.ctx.getWebSockets(`pub:${msg.id}`)[0];
        if (pub) safeClose(pub, msg.code, msg.reason);
        return;
      }
    }
  }

  failAll(reason) {
    for (const s of [...this.streams.values()]) this.failStream(s, 502, reason, false);
    for (const p of [...this.pendingWs.values()]) p.settle({ t: "ws_err", status: 502, message: reason });
    for (const pub of this.ctx.getWebSockets("pub")) safeClose(pub, 1012, reason);
  }

  // ---------------------------------------------------------------- public side

  async handlePublic(request, url) {
    const tunnels = await this.getTunnels();
    const route = resolveRoute(url, tunnels);
    if (!route) {
      return tunnels.length
        ? page(request, 404, "Không tìm thấy tunnel", "Địa chỉ này không trỏ tới tunnel nào đang được cấu hình.")
        : page(request, 404, "Mini Tunnel đang chạy", "Chưa có tunnel HTTP nào được tạo. Mở dashboard trên máy local để thêm tunnel.");
    }
    if (route.redirect) {
      return Response.redirect(url.origin + route.redirect + url.search, 308);
    }
    const { tunnel } = route;
    if (!tunnel.enabled) {
      return page(request, 503, "Tunnel đang tạm dừng", `Tunnel "${tunnel.name}" đã bị tắt trên máy local.`);
    }
    const agent = this.agent();
    if (!agent) {
      return page(request, 502, "Tunnel offline", `Máy chủ local của "${tunnel.name}" hiện không kết nối tới Worker.`);
    }

    const id = this.newId();
    const headers = forwardHeaders(request, url, route.prefix);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.proxyWebSocket(request, agent, id, route, headers);
    }
    return this.proxyHttp(request, agent, id, route, headers);
  }

  newId() {
    for (;;) {
      const id = crypto.getRandomValues(new Uint32Array(1))[0];
      if (id && !this.streams.has(id) && !this.pendingWs.has(id) && !this.ctx.getWebSockets(`pub:${id}`).length) {
        return id;
      }
    }
  }

  proxyHttp(request, agent, id, route, headers) {
    const method = request.method;
    const hasBody = request.body !== null && method !== "GET" && method !== "HEAD";
    return new Promise((resolve) => {
      const s = {
        id,
        agent,
        method,
        prefix: route.prefix,
        wantsHtml: wantsHtml(request),
        resolve,
        headSent: false,
        writer: null,
        inflight: 0, // upload bytes sent but not yet acknowledged
        onAck: null,
        done: false,
        timer: null,
      };
      this.streams.set(id, s);
      s.timer = setTimeout(
        () => this.failStream(s, 504, "Dịch vụ local không phản hồi kịp (timeout).", true),
        RESPONSE_TIMEOUT_MS,
      );
      send(agent, {
        t: "req",
        id,
        tunnel: route.tunnel.id,
        method,
        path: route.path,
        headers,
        body: hasBody,
      });
      if (hasBody) this.pumpUpload(s, request.body);
    });
  }

  async pumpUpload(s, body) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (let off = 0; off < value.byteLength; off += CHUNK) {
          while (s.inflight >= WINDOW && !s.done) await new Promise((r) => (s.onAck = r));
          if (s.done) {
            reader.cancel().catch(() => {});
            return;
          }
          const part = value.subarray(off, off + CHUNK);
          s.inflight += part.byteLength;
          sendFrame(s.agent, F_BODY, s.id, part);
        }
      }
      if (!s.done) send(s.agent, { t: "req_end", id: s.id });
    } catch {
      this.failStream(s, 400, "Upload bị gián đoạn.", true);
    }
  }

  onUploadAck(s, n) {
    s.inflight -= Number(n) || 0;
    if (s.inflight < WINDOW && s.onAck) {
      const wake = s.onAck;
      s.onAck = null;
      wake();
    }
  }

  onResponseHead(s, msg) {
    if (s.headSent || s.done) return;
    clearTimeout(s.timer);
    const status = Number(msg.status);
    if (!(status >= 200 && status <= 599)) {
      this.failStream(s, 502, `Dịch vụ local trả về status không hợp lệ: ${msg.status}`, true);
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Array.isArray(msg.headers) ? msg.headers : []) {
      if (HOP_BY_HOP.has(String(k).toLowerCase())) continue;
      try {
        headers.append(k, v);
      } catch {}
    }
    // Apps served under /t/<id>/ redirect to absolute paths; keep them inside the prefix.
    const location = headers.get("location");
    if (s.prefix && location?.startsWith("/") && !location.startsWith("//")) {
      headers.set("location", s.prefix + location);
    }

    let body = null;
    if (s.method !== "HEAD" && !NULL_BODY_STATUS.has(status)) {
      const length = headers.has("content-length") ? Number(headers.get("content-length")) : NaN;
      const stream = Number.isSafeInteger(length) && length >= 0 ? new FixedLengthStream(length) : new TransformStream();
      s.writer = stream.writable.getWriter();
      body = stream.readable;
    }
    const init = { status, statusText: msg.statusText || "", headers };
    // The local service already compressed the body; pass it through untouched.
    if (headers.has("content-encoding")) init.encodeBody = "manual";
    s.headSent = true;
    s.resolve(new Response(body, init));
  }

  onBodyChunk(s, payload) {
    const n = payload.byteLength;
    if (!s.writer) {
      // HEAD/204/304: drop the bytes but keep the client's send window moving.
      send(s.agent, { t: "ack", id: s.id, n });
      return;
    }
    s.writer.write(payload).then(
      () => send(s.agent, { t: "ack", id: s.id, n }),
      () => this.failStream(s, 499, "Client closed the connection", true),
    );
  }

  finishStream(s) {
    if (s.done) return;
    if (!s.headSent) {
      this.failStream(s, 502, "Dịch vụ local đóng kết nối trước khi trả lời.", false);
      return;
    }
    s.writer?.close().catch(() => {});
    this.cleanup(s);
  }

  failStream(s, status, message, notifyAgent) {
    if (s.done) return;
    if (notifyAgent) send(s.agent, { t: "cancel", id: s.id });
    if (!s.headSent) {
      s.headSent = true;
      s.resolve(page({ wantsHtml: s.wantsHtml }, status, "Không truy cập được dịch vụ local", message));
    } else {
      s.writer?.abort(new Error(message)).catch(() => {});
    }
    this.cleanup(s);
  }

  cleanup(s) {
    s.done = true;
    clearTimeout(s.timer);
    this.streams.delete(s.id);
    if (s.onAck) {
      const wake = s.onAck;
      s.onAck = null;
      wake();
    }
  }

  async proxyWebSocket(request, agent, id, route, headers) {
    const protocols = request.headers.get("Sec-WebSocket-Protocol") || "";
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(
        () => pending.settle({ t: "ws_err", status: 504, message: "Dịch vụ local không mở WebSocket kịp." }),
        WS_OPEN_TIMEOUT_MS,
      );
      const pending = {
        settle: (msg) => {
          if (!this.pendingWs.has(id)) return;
          this.pendingWs.delete(id);
          clearTimeout(timer);
          if (msg.t === "ws_ok") {
            // Accept synchronously so frames that follow ws_ok always find this socket.
            const { 0: client, 1: server } = new WebSocketPair();
            this.ctx.acceptWebSocket(server, ["pub", `pub:${id}`]);
            msg = { ...msg, client };
          }
          resolve(msg);
        },
      };
      this.pendingWs.set(id, pending);
      send(agent, { t: "ws_open", id, tunnel: route.tunnel.id, path: route.path, headers, protocols });
    });

    if (reply.t !== "ws_ok") {
      return page(request, reply.status || 502, "Không mở được WebSocket", reply.message || "");
    }
    const responseHeaders = new Headers();
    if (reply.protocol) responseHeaders.set("Sec-WebSocket-Protocol", reply.protocol);
    return new Response(null, { status: 101, webSocket: reply.client, headers: responseHeaders });
  }
}

// ------------------------------------------------------------------ helpers

function resolveRoute(url, tunnels) {
  const host = url.hostname.toLowerCase();
  const byHost = tunnels.find((t) => t.route === "host" && t.hostname === host);
  if (byHost) return { tunnel: byHost, path: url.pathname + url.search, prefix: "" };

  const m = url.pathname.match(/^\/t\/([a-z0-9][a-z0-9-]{0,39})(\/.*)?$/);
  if (m) {
    const tunnel = tunnels.find((t) => t.id === m[1]);
    if (tunnel) {
      if (!m[2]) return { tunnel, redirect: `/t/${tunnel.id}/` };
      return { tunnel, path: m[2] + url.search, prefix: `/t/${tunnel.id}` };
    }
  }

  const root = tunnels.find((t) => t.route === "root");
  if (root) return { tunnel: root, path: url.pathname + url.search, prefix: "" };
  return null;
}

function forwardHeaders(request, url, prefix) {
  const out = [];
  for (const [k, v] of request.headers) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key.startsWith("cf-") || key.startsWith("sec-websocket-")) continue;
    if (key === "cdn-loop" || key === "x-real-ip" || key.startsWith("x-forwarded-")) continue;
    out.push([key, v]);
  }
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) out.push(["x-forwarded-for", ip], ["x-real-ip", ip]);
  out.push(["x-forwarded-proto", url.protocol.replace(":", "")], ["x-forwarded-host", url.host]);
  if (prefix) out.push(["x-forwarded-prefix", prefix]);
  return out;
}

function pubId(tags) {
  const tag = tags.find((t) => t.startsWith("pub:"));
  return tag ? Number(tag.slice(4)) : null;
}

function send(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

function sendFrame(ws, type, id, payload) {
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, id);
  frame.set(payload, 5);
  try {
    ws.send(frame);
  } catch {}
}

function safeClose(ws, code, reason) {
  // 1005/1006/1015 are reserved and may not be sent in a close frame.
  const valid = code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
  try {
    ws.close(valid ? code : 1000, String(reason || "").slice(0, 120));
  } catch {}
}

function wantsHtml(request) {
  return (request.headers.get("Accept") || "").includes("text/html");
}

function text(status, body) {
  return new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function page(request, status, title, detail) {
  const html = request.wantsHtml ?? wantsHtml(request);
  if (!html) return text(status, `${title}: ${detail}`);
  const body = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#5f6b7a;--line:#e3e7ec}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--fg:#e7eaf0;--muted:#9aa4b2;--line:#262c37}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:16px;padding:28px;background:var(--card);border:1px solid var(--line);border-radius:14px}
.code{font:600 13px ui-monospace,Consolas,monospace;color:var(--muted)}h1{font-size:20px;margin:6px 0 8px}p{margin:0;color:var(--muted)}
</style></head><body><main><div class="code">HTTP ${status} · Mini Tunnel</div><h1>${esc(title)}</h1><p>${esc(detail)}</p></main></body></html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
