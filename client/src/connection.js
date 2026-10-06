import { EventEmitter } from "node:events";
import { isValidRelayUrl } from "./config.js";
import { PING, PONG, decodeFrame } from "./protocol.js";

export const CLIENT_VERSION = "0.1.0";

const BACKOFF_S = [1, 2, 5, 10, 30];
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;
const CLOSE_REPLACED = 4000;

// Keeps one WebSocket open to the Worker, re-registers tunnels after every reconnect
// and retries with backoff (1s, 2s, 5s, 10s, 30s, 30s, ...).
//
// States: unconfigured | connecting | online | offline (waiting to retry) | stopped (no auto retry)
export class RelayConnection extends EventEmitter {
  constructor({ store, logger }) {
    super();
    this.store = store;
    this.logger = logger;
    this.state = "idle";
    this.message = "";
    this.since = Date.now();
    this.ws = null;
    this.gen = 0; // bumped on every (re)connect so events from stale sockets are ignored
    this.attempt = 0;
    this.retryTimer = null;
    this.retryAt = null;
    this.heartbeat = null;
    this.lastPong = 0;
    this.pingSentAt = 0;
    this.latencyMs = null;
    this.lastLogged = "";
    this.handler = {}; // { onMessage(msg), onFrame(frame), onOnline(), onDisconnected() }
    this.registration = () => [];
  }

  snapshot() {
    return {
      state: this.state,
      message: this.message,
      since: this.since,
      latencyMs: this.state === "online" ? this.latencyMs : null,
      retryAt: this.retryAt,
      attempt: this.attempt,
      relayUrl: this.store.connection().relayUrl,
    };
  }

  publicOrigin() {
    return this.store.connection().relayUrl || null;
  }

  start() {
    this.connect();
  }

  reconnectNow() {
    this.teardown();
    this.attempt = 0;
    this.connect();
  }

  stop() {
    this.teardown();
    clearTimeout(this.retryTimer);
  }

  async connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;

    const { relayUrl, token } = this.store.connection();
    if (!relayUrl || !token) {
      this.setState("unconfigured", "Chưa nhập Worker URL hoặc token.");
      return;
    }

    const gen = ++this.gen;
    this.setState("connecting", this.attempt ? `Thử lại lần ${this.attempt}…` : "");

    const check = await checkRelay(relayUrl, token);
    if (gen !== this.gen) return;
    if (!check.ok) return this.fail(check.message);

    let ws;
    try {
      ws = new WebSocket(`${relayUrl.replace(/^http/, "ws")}/__tunnel/connect`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": `mini-tunnel-client/${CLIENT_VERSION}` },
      });
    } catch (err) {
      return this.fail(`Không mở được WebSocket: ${err.message}`);
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.lastPong = Date.now();
      this.startHeartbeat(gen);
    };
    ws.onmessage = (ev) => {
      if (gen === this.gen) this.onMessage(ev.data);
    };
    ws.onclose = (ev) => {
      if (gen !== this.gen) return;
      if (ev.code === CLOSE_REPLACED) {
        this.fail("Một client khác vừa kết nối bằng cùng token nên client này bị ngắt. Bấm \"Kết nối lại\" để giành lại.", { retry: false });
      } else {
        this.fail(`Kết nối tới Worker bị đóng (mã ${ev.code}${ev.reason ? `: ${ev.reason}` : ""}).`);
      }
    };
    // Node's WebSocket may fire only "error" (no "close") when the handshake fails.
    ws.onerror = () => {
      if (gen === this.gen) this.fail("Không mở được kết nối WebSocket tới Worker.");
    };
  }

  onMessage(data) {
    if (typeof data !== "string") {
      const frame = decodeFrame(data);
      if (frame) this.handler.onFrame?.(frame);
      return;
    }
    if (data === PONG) {
      this.lastPong = Date.now();
      if (this.pingSentAt) {
        this.latencyMs = this.lastPong - this.pingSentAt;
        this.pingSentAt = 0;
        this.emit("change");
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        this.sendRegister();
        break;
      case "registered":
        if (this.state !== "online") {
          this.attempt = 0;
          this.setState("online", "");
          this.log("info", `Đã kết nối tới ${this.store.connection().relayUrl}`);
          this.ping();
          this.handler.onOnline?.();
        }
        break;
      default:
        this.handler.onMessage?.(msg);
    }
  }

  sendRegister() {
    this.send({ t: "register", tunnels: this.registration() });
  }

  startHeartbeat(gen) {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (gen !== this.gen) return;
      if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
        this.fail("Không nhận được heartbeat từ Worker (timeout).");
        return;
      }
      this.ping();
    }, PING_INTERVAL_MS);
  }

  ping() {
    this.pingSentAt = Date.now();
    this.sendRaw(PING);
  }

  fail(message, { retry = true } = {}) {
    const wasOnline = this.state === "online";
    this.teardown();
    if (wasOnline) this.log("warn", `Mất kết nối: ${message}`);
    else this.log("warn", message);

    if (!retry) {
      this.setState("stopped", message);
      return;
    }
    const delay = BACKOFF_S[Math.min(this.attempt, BACKOFF_S.length - 1)];
    this.attempt++;
    this.retryAt = Date.now() + delay * 1000;
    this.setState("offline", message);
    this.retryTimer = setTimeout(() => this.connect(), delay * 1000);
  }

  teardown() {
    this.gen++;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {}
      this.handler.onDisconnected?.();
    }
  }

  setState(state, message) {
    if (state !== this.state) this.since = Date.now();
    this.state = state;
    this.message = message;
    this.emit("change");
  }

  // Avoid flooding the log with the same retry error every 30 seconds.
  log(level, message) {
    if (message === this.lastLogged && level !== "info") return;
    this.lastLogged = message;
    this.logger[level](message);
  }

  send(msg) {
    this.sendRaw(JSON.stringify(msg));
  }

  sendRaw(data) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(data);
      return true;
    } catch {
      return false;
    }
  }
}

// Checks Worker URL + token over plain HTTPS before opening the WebSocket, so the dashboard
// can show a precise reason (wrong token, wrong URL, no network...) instead of "closed 1006".
export async function checkRelay(relayUrl, token) {
  if (!isValidRelayUrl(relayUrl)) {
    return { ok: false, message: "Worker URL không hợp lệ. Ví dụ: https://mini-tunnel.ten-ban.workers.dev" };
  }
  if (!token) return { ok: false, message: "Chưa nhập token." };
  let res;
  try {
    res = await fetch(`${relayUrl}/__tunnel/ping`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
  } catch (err) {
    const code = err.name === "TimeoutError" ? "TIMEOUT" : err.cause?.code || err.message;
    const messages = {
      TIMEOUT: "Worker không phản hồi sau 10 giây.",
      ENOTFOUND: "Không tìm thấy tên miền của Worker. Kiểm tra lại URL hoặc kết nối Internet.",
      EAI_AGAIN: "Không phân giải được tên miền (mất mạng?).",
      ECONNREFUSED: "Worker từ chối kết nối (ECONNREFUSED).",
    };
    return { ok: false, message: messages[code] || `Không kết nối được tới Worker: ${code}` };
  }
  if (res.ok) {
    const body = await res.json().catch(() => null);
    if (!body?.ok) return { ok: false, message: "URL này không phải Mini Tunnel Worker." };
    return { ok: true, version: body.version };
  }
  const messages = {
    401: "Token không khớp với TUNNEL_TOKEN trên Worker.",
    404: "Không tìm thấy Mini Tunnel ở URL này (404). Kiểm tra lại Worker URL.",
    503: "Worker chưa có TUNNEL_TOKEN. Chạy: npx wrangler secret put TUNNEL_TOKEN (trong thư mục worker).",
  };
  return { ok: false, message: messages[res.status] || `Worker trả về HTTP ${res.status}.` };
}
