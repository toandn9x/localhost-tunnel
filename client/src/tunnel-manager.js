import net from "node:net";
import { EventEmitter } from "node:events";
import { validateTunnel } from "./config.js";
import { hostPort } from "./http-tunnel.js";

const RECENT_MAX = 200;
const HEALTH_INTERVAL_MS = 10_000;

// Owns tunnel configuration (CRUD, start/stop) plus runtime state: statistics, recent
// requests and whether each local service is currently reachable.
//
// Events: "config" (the Worker must be told about a change), "change" (dashboard refresh),
//         "request" (a request finished).
export class TunnelManager extends EventEmitter {
  constructor({ store, logger }) {
    super();
    this.store = store;
    this.logger = logger;
    this.runtime = new Map();
    this.recent = [];
    this.seq = 0;
    this.online = false;
    this.proxy = null;
  }

  list() {
    return this.store.tunnels.filter((t) => t.protocol === "http");
  }

  get(id) {
    return this.list().find((t) => t.id === id) ?? null;
  }

  rt(id) {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = {
        startedAt: null,
        localUp: null,
        stats: { requests: 0, active: 0, rxBytes: 0, txBytes: 0, errors: 0, lastError: null, lastErrorAt: null },
      };
      this.runtime.set(id, rt);
    }
    return rt;
  }

  // ------------------------------------------------------------------ CRUD

  create(input) {
    const { errors, tunnel } = validateTunnel(input, { existing: this.store.tunnels });
    if (Object.keys(errors).length) return { errors };
    const moved = this.claimRoot(tunnel);
    this.store.tunnels.push(tunnel);
    this.store.save();
    this.syncStarted(tunnel);
    this.logger.info(`Đã thêm tunnel "${tunnel.name}" → ${tunnel.localScheme}://${hostPort(tunnel)}`, tunnel.id);
    this.checkLocal(tunnel);
    this.changed(true);
    return { tunnel, moved };
  }

  update(id, input) {
    const current = this.get(id);
    if (!current) return { notFound: true };
    const { errors, tunnel } = validateTunnel(input, { existing: this.store.tunnels, current });
    if (Object.keys(errors).length) return { errors };

    const targetChanged = ["localScheme", "localHost", "localPort", "hostHeader"].some((k) => current[k] !== tunnel[k]);
    const toggled = current.enabled !== tunnel.enabled;
    Object.assign(current, tunnel);
    const moved = this.claimRoot(current);
    this.store.save();

    if (!current.enabled || targetChanged) this.proxy?.closeTunnel(id, current.enabled ? "Tunnel vừa đổi cấu hình" : "Tunnel đã dừng");
    if (targetChanged) this.rt(id).localUp = null;
    this.syncStarted(current);
    if (toggled) this.logger.info(current.enabled ? "Đã bật tunnel" : "Đã dừng tunnel", id);
    else this.logger.info("Đã cập nhật cấu hình tunnel", id);
    this.checkLocal(current);
    this.changed(true);
    return { tunnel: current, moved };
  }

  remove(id) {
    const index = this.store.tunnels.findIndex((t) => t.id === id);
    if (index < 0) return false;
    const [tunnel] = this.store.tunnels.splice(index, 1);
    this.store.save();
    this.proxy?.closeTunnel(id, "Tunnel đã bị xóa");
    this.runtime.delete(id);
    this.logger.info(`Đã xóa tunnel "${tunnel.name}"`, id);
    this.changed(true);
    return true;
  }

  restart(id) {
    const tunnel = this.get(id);
    if (!tunnel) return false;
    this.proxy?.closeTunnel(id, "Tunnel khởi động lại");
    this.rt(id).startedAt = null;
    this.syncStarted(tunnel);
    this.logger.info("Đã khởi động lại tunnel", id);
    this.checkLocal(tunnel);
    this.changed(true);
    return true;
  }

  // Only one tunnel can own the Worker's root URL; the previous owner falls back to /t/<id>/.
  claimRoot(tunnel) {
    if (tunnel.route !== "root") return null;
    const other = this.store.tunnels.find((t) => t.id !== tunnel.id && t.route === "root");
    if (!other) return null;
    other.route = "path";
    return other.name;
  }

  registration() {
    return this.list().map(({ id, name, route, hostname, enabled }) => ({ id, name, route, hostname, enabled }));
  }

  // ------------------------------------------------------------------ runtime state

  setOnline(online) {
    if (this.online === online) return;
    this.online = online;
    for (const t of this.list()) this.syncStarted(t);
    this.changed(false);
  }

  syncStarted(tunnel) {
    const rt = this.rt(tunnel.id);
    if (tunnel.enabled && this.online) rt.startedAt ??= Date.now();
    else rt.startedAt = null;
  }

  streamOpened(id) {
    const { stats } = this.rt(id);
    stats.requests++;
    stats.active++;
    this.changed(false);
  }

  streamClosed(id, info) {
    const { stats } = this.rt(id);
    stats.active = Math.max(0, stats.active - 1);
    const entry = { seq: ++this.seq, time: Date.now(), tunnel: id, ...info };
    this.recent.push(entry);
    if (this.recent.length > RECENT_MAX) this.recent.shift();
    this.emit("request", entry);
    this.changed(false);
  }

  addBytes(id, rx, tx) {
    const { stats } = this.rt(id);
    stats.rxBytes += rx;
    stats.txBytes += tx;
    this.changed(false);
  }

  recordError(id, message, code) {
    const rt = this.rt(id);
    rt.stats.errors++;
    rt.stats.lastError = message;
    rt.stats.lastErrorAt = Date.now();
    if (code === "ECONNREFUSED") rt.localUp = false;
    this.logger.warn(message, id);
    this.changed(false);
  }

  clearRecent() {
    this.recent = [];
  }

  // ------------------------------------------------------------------ local health checks

  startHealthChecks() {
    const tick = () => {
      for (const t of this.list()) if (t.enabled) this.checkLocal(t);
    };
    tick();
    setInterval(tick, HEALTH_INTERVAL_MS).unref();
  }

  async checkLocal(tunnel) {
    const result = await probe(tunnel.localHost, tunnel.localPort);
    if (!this.get(tunnel.id)) return;
    const rt = this.rt(tunnel.id);
    if (rt.localUp === result.ok) return;
    const where = `${tunnel.localScheme}://${hostPort(tunnel)}`;
    if (result.ok && rt.localUp === false) this.logger.info(`Ứng dụng local đã chạy lại tại ${where}`, tunnel.id);
    if (!result.ok && tunnel.enabled) this.logger.warn(`Không thấy ứng dụng nào tại ${where} (${result.error})`, tunnel.id);
    rt.localUp = result.ok;
    this.changed(false);
  }

  // ------------------------------------------------------------------ dashboard view

  snapshot(origin) {
    return this.list().map((t) => {
      const rt = this.rt(t.id);
      return {
        ...t,
        localUrl: `${t.localScheme}://${hostPort(t)}`,
        publicUrl: publicUrl(t, origin),
        status: !t.enabled ? "stopped" : !this.online ? "offline" : rt.localUp === false ? "local_down" : "online",
        localUp: rt.localUp,
        startedAt: rt.startedAt,
        stats: { ...rt.stats },
      };
    });
  }

  changed(configChanged) {
    if (configChanged) this.emit("config");
    this.emit("change");
  }
}

export function publicUrl(tunnel, origin) {
  if (tunnel.route === "host" && tunnel.hostname) return `https://${tunnel.hostname}/`;
  if (!origin) return null;
  return tunnel.route === "root" ? `${origin}/` : `${origin}/t/${tunnel.id}/`;
}

export function probe(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host: host.replace(/^\[|\]$/g, ""), port });
    const done = (ok, error) => {
      sock.destroy();
      resolve({ ok, ms: Date.now() - started, error });
    };
    sock.setTimeout(timeout, () => done(false, "timeout"));
    sock.once("connect", () => done(true));
    sock.once("error", (err) => done(false, err.code || err.message));
  });
}
