import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR, isValidRelayUrl, normalizeRelayUrl } from "./config.js";
import { checkRelay } from "./connection.js";
import { probe } from "./tunnel-manager.js";

const DASHBOARD_DIR = path.join(ROOT_DIR, "dashboard");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
const MAX_BODY = 64 * 1024;

// Local-only dashboard: static UI + JSON API + Server-Sent Events for live updates.
// Bound to 127.0.0.1, and every request must carry a loopback Host header (blocks DNS
// rebinding). Mutations require a JSON body and a same-origin Origin (blocks CSRF from
// other websites — otherwise any page could open a tunnel to a port on this machine).
export function startDashboard({ store, manager, conn, logger, version }) {
  const port = store.dashboardPort();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const clients = new Set();

  const settings = () => ({
    relayUrl: store.connection().relayUrl,
    tokenSet: Boolean(store.connection().token),
    env: store.envOverrides(),
    configPath: store.file,
  });
  const snapshot = () => ({
    version,
    connection: conn.snapshot(),
    settings: settings(),
    tunnels: manager.snapshot(conn.publicOrigin()),
  });

  const broadcast = (event, data) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  };
  let pushTimer = null;
  const pushSnapshot = () => {
    if (pushTimer || !clients.size) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      broadcast("snapshot", snapshot());
    }, 250);
  };
  conn.on("change", pushSnapshot);
  manager.on("change", pushSnapshot);
  manager.on("request", (entry) => broadcast("request", entry));
  logger.on("log", (entry) => broadcast("log", entry));

  const routes = [
    ["GET", /^\/api\/state$/, () => [200, { ...snapshot(), recent: manager.recent, logs: logger.recent() }]],
    ["POST", /^\/api\/tunnels$/, (_, body) => {
      const r = manager.create(body);
      return r.errors ? [400, { error: "Thông tin chưa hợp lệ", errors: r.errors }] : [201, r];
    }],
    ["PUT", /^\/api\/tunnels\/([a-z0-9-]+)$/, ([id], body) => {
      const r = manager.update(id, body);
      if (r.notFound) return [404, { error: "Không tìm thấy tunnel" }];
      return r.errors ? [400, { error: "Thông tin chưa hợp lệ", errors: r.errors }] : [200, r];
    }],
    ["DELETE", /^\/api\/tunnels\/([a-z0-9-]+)$/, ([id]) =>
      manager.remove(id) ? [200, { ok: true }] : [404, { error: "Không tìm thấy tunnel" }]],
    ["POST", /^\/api\/tunnels\/([a-z0-9-]+)\/(start|stop|restart)$/, ([id, action]) => {
      if (action === "restart") return manager.restart(id) ? [200, { ok: true }] : [404, { error: "Không tìm thấy tunnel" }];
      const r = manager.update(id, { enabled: action === "start" });
      return r.notFound ? [404, { error: "Không tìm thấy tunnel" }] : [200, r];
    }],
    ["POST", /^\/api\/check-local$/, async (_, body) => {
      const port = Number(body.port);
      const host = String(body.host || "127.0.0.1").trim();
      if (!Number.isInteger(port) || port < 1 || port > 65535) return [400, { error: "Cổng không hợp lệ" }];
      return [200, await probe(host, port)];
    }],
    ["PUT", /^\/api\/settings$/, (_, body) => {
      const relayUrl = normalizeRelayUrl(body.relayUrl);
      if (!isValidRelayUrl(relayUrl)) return [400, { error: "Worker URL không hợp lệ", errors: { relayUrl: "Cần dạng https://ten-worker.ten-ban.workers.dev" } }];
      const token = typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined;
      if (!token && !store.connection().token) return [400, { error: "Chưa có token", errors: { token: "Nhập token" } }];
      store.setConnection({ relayUrl, token });
      logger.info(`Đã lưu cài đặt kết nối (${relayUrl})`);
      conn.reconnectNow();
      return [200, { ok: true }];
    }],
    ["POST", /^\/api\/settings\/test$/, async (_, body) => {
      const relayUrl = normalizeRelayUrl(body.relayUrl || store.connection().relayUrl);
      const token = typeof body.token === "string" && body.token.trim() ? body.token.trim() : store.connection().token;
      return [200, await checkRelay(relayUrl, token)];
    }],
    ["POST", /^\/api\/reconnect$/, () => {
      conn.reconnectNow();
      return [200, { ok: true }];
    }],
    ["DELETE", /^\/api\/activity$/, (_, __, url) => {
      if (url.searchParams.get("kind") === "logs") logger.entries = [];
      else manager.clearRecent();
      return [200, { ok: true }];
    }],
  ];

  async function handle(req, res) {
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, "text/plain", "Forbidden host");
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const content = await fs.readFile(path.join(DASHBOARD_DIR, file));
      return send(res, 200, type, content);
    }
    if (req.method === "GET" && url.pathname === "/api/events") return openEvents(req, res);
    if (!url.pathname.startsWith("/api/")) return send(res, 404, "text/plain", "Not found");

    let body = {};
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, ""))) return json(res, 403, { error: "Forbidden origin" });
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
        return json(res, 415, { error: "Cần Content-Type: application/json" });
      }
      try {
        body = await readJson(req);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    for (const [method, pattern, fn] of routes) {
      const m = url.pathname.match(pattern);
      if (!m || method !== req.method) continue;
      const [status, data] = await fn(m.slice(1), body, url);
      return json(res, status, data);
    }
    return json(res, 404, { error: "Not found" });
  }

  function openEvents(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: init\ndata: ${JSON.stringify({ ...snapshot(), recent: manager.recent, logs: logger.recent() })}\n\n`);
    clients.add(res);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error(`Dashboard: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: "Lỗi nội bộ" });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Cổng ${port} đang được dùng — có thể Mini Tunnel đã chạy ở cửa sổ khác. Đặt DASHBOARD_PORT để dùng cổng khác.`));
      } else reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${port}`, server }));
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Body quá lớn"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(value && typeof value === "object" ? value : {});
      } catch {
        reject(new Error("JSON không hợp lệ"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(data));
}

function send(res, status, type, body) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(body);
}
