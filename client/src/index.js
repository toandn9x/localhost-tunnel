#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { ConfigStore, ROOT_DIR } from "./config.js";
import { CLIENT_VERSION, RelayConnection } from "./connection.js";
import { startDashboard } from "./dashboard-server.js";
import { HttpProxy } from "./http-tunnel.js";
import { Logger } from "./logger.js";
import { TunnelManager } from "./tunnel-manager.js";

if (typeof WebSocket === "undefined") {
  console.error(`Mini Tunnel cần Node.js 22 trở lên (đang dùng ${process.version}).`);
  process.exit(1);
}

try {
  process.loadEnvFile(path.join(ROOT_DIR, ".env"));
} catch {}

const logger = new Logger();
let store;
try {
  store = new ConfigStore();
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}

const manager = new TunnelManager({ store, logger });
const conn = new RelayConnection({ store, logger });
const proxy = new HttpProxy({ conn, manager, logger });

manager.proxy = proxy;
conn.registration = () => manager.registration();
conn.handler = {
  onMessage: (msg) => proxy.handle(msg),
  onFrame: (frame) => proxy.handleFrame(frame),
  onOnline: () => manager.setOnline(true),
  onDisconnected: () => {
    proxy.closeAll("Mất kết nối tới Worker");
    manager.setOnline(false);
  },
};
manager.on("config", () => conn.sendRegister());

// `npm run setup` may write a new Worker URL/token while the client is running.
store.onExternalChange = () => {
  logger.info("Phát hiện cấu hình kết nối mới trong file, đang kết nối lại…");
  conn.reconnectNow();
};

let dashboard;
try {
  dashboard = await startDashboard({ store, manager, conn, logger, version: CLIENT_VERSION });
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}

logger.info(`Mini Tunnel ${CLIENT_VERSION} — dashboard: ${dashboard.url}`);
logger.info(`File cấu hình: ${store.file}`);
manager.startHealthChecks();
store.watch();
conn.start();

if (process.argv.includes("--open")) openBrowser(dashboard.url);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    logger.info("Đang tắt Mini Tunnel…");
    conn.stop();
    process.exit(0);
  });
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
