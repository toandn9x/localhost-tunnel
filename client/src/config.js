import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_CONFIG_PATH = path.join(ROOT_DIR, "data", "config.json");
export const DEFAULT_DASHBOARD_PORT = 8787;

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOCAL_HOST_RE = /^[a-zA-Z0-9.\-:[\]]{1,253}$/;

const ROUTES = ["root", "path", "host"];
const SCHEMES = ["http", "https"];
const HOST_HEADERS = ["rewrite", "preserve"];

// Persists client settings and tunnels as JSON (data/config.json by default).
// TUNNEL_URL / TUNNEL_TOKEN environment variables (or a .env file) override the file.
export class ConfigStore {
  constructor(file = process.env.MINI_TUNNEL_CONFIG || DEFAULT_CONFIG_PATH) {
    this.file = path.resolve(file);
    this.lastWritten = null;
    this.onExternalChange = null;
    this.data = this.load();
  }

  load() {
    let raw = {};
    try {
      const content = fs.readFileSync(this.file, "utf8");
      this.lastWritten = content;
      raw = JSON.parse(content);
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error(`Không đọc được file cấu hình ${this.file}: ${err.message}`);
    }
    return {
      relayUrl: typeof raw.relayUrl === "string" ? raw.relayUrl : "",
      token: typeof raw.token === "string" ? raw.token : "",
      dashboard: { port: Number(raw.dashboard?.port) || DEFAULT_DASHBOARD_PORT },
      tunnels: Array.isArray(raw.tunnels) ? raw.tunnels.filter((t) => t && ID_RE.test(t.id)).map(withDefaults) : [],
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const content = JSON.stringify(this.data, null, 2) + "\n";
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.lastWritten = content;
  }

  // Picks up Worker URL/token written by another process (scripts/setup.js).
  // Tunnels are owned by the running client, so only the connection fields are reloaded.
  watch() {
    fs.watchFile(this.file, { interval: 2000 }, () => {
      let content;
      try {
        content = fs.readFileSync(this.file, "utf8");
      } catch {
        return;
      }
      if (content === this.lastWritten) return;
      this.lastWritten = content;
      let raw;
      try {
        raw = JSON.parse(content);
      } catch {
        return;
      }
      const changed = raw.relayUrl !== this.data.relayUrl || raw.token !== this.data.token;
      this.data.relayUrl = typeof raw.relayUrl === "string" ? raw.relayUrl : this.data.relayUrl;
      this.data.token = typeof raw.token === "string" ? raw.token : this.data.token;
      if (changed) this.onExternalChange?.();
    }).unref?.();
  }

  connection() {
    return {
      relayUrl: normalizeRelayUrl(process.env.TUNNEL_URL || this.data.relayUrl),
      token: process.env.TUNNEL_TOKEN || this.data.token,
    };
  }

  envOverrides() {
    return { relayUrl: Boolean(process.env.TUNNEL_URL), token: Boolean(process.env.TUNNEL_TOKEN) };
  }

  setConnection({ relayUrl, token }) {
    if (relayUrl !== undefined) this.data.relayUrl = normalizeRelayUrl(relayUrl);
    if (token !== undefined) this.data.token = token;
    this.save();
  }

  dashboardPort() {
    return Number(process.env.DASHBOARD_PORT) || this.data.dashboard.port;
  }

  get tunnels() {
    return this.data.tunnels;
  }
}

export function normalizeRelayUrl(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return url.origin;
  } catch {
    return s;
  }
}

export function isValidRelayUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  } catch {
    return false;
  }
}

function isLoopback(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function withDefaults(t) {
  return {
    id: t.id,
    name: String(t.name || t.id),
    protocol: t.protocol || "http",
    localScheme: SCHEMES.includes(t.localScheme) ? t.localScheme : "http",
    localHost: t.localHost || "127.0.0.1",
    localPort: Number(t.localPort) || 80,
    route: ROUTES.includes(t.route) ? t.route : "path",
    hostname: t.hostname || "",
    hostHeader: HOST_HEADERS.includes(t.hostHeader) ? t.hostHeader : "rewrite",
    enabled: t.enabled !== false,
  };
}

// Validates dashboard input. With `current`, fields missing from input keep their value
// and the id cannot change (it is part of the public URL).
export function validateTunnel(input, { existing = [], current = null } = {}) {
  const pick = (key, fallback) => (input[key] !== undefined ? input[key] : current ? current[key] : fallback);
  const errors = {};

  const name = String(pick("name", "")).trim();
  if (!name) errors.name = "Nhập tên tunnel";
  else if (name.length > 60) errors.name = "Tên tối đa 60 ký tự";

  let id = current?.id;
  if (!current) {
    const wanted = String(input.id || "").trim().toLowerCase();
    id = wanted || uniqueId(slugify(name), existing);
    if (!ID_RE.test(id)) errors.id = "Mã chỉ gồm chữ thường, số và dấu gạch ngang (tối đa 40 ký tự)";
    else if (existing.some((t) => t.id === id)) errors.id = `Mã "${id}" đã được dùng`;
  }

  const protocol = String(pick("protocol", "http"));
  if (protocol !== "http") errors.protocol = "Hiện mới hỗ trợ HTTP. TCP/UDP cần VPS relay (phase sau).";

  const localScheme = String(pick("localScheme", "http"));
  if (!SCHEMES.includes(localScheme)) errors.localScheme = "Chọn http hoặc https";

  const localHost = String(pick("localHost", "127.0.0.1")).trim() || "127.0.0.1";
  if (!LOCAL_HOST_RE.test(localHost)) errors.localHost = "Địa chỉ không hợp lệ";

  const localPort = Number(pick("localPort", NaN));
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) errors.localPort = "Cổng phải từ 1 đến 65535";

  const route = String(pick("route", "path"));
  if (!ROUTES.includes(route)) errors.route = "Chọn kiểu địa chỉ public";

  const hostname = route === "host" ? String(pick("hostname", "")).trim().toLowerCase() : "";
  if (route === "host" && !HOST_RE.test(hostname)) errors.hostname = "Tên miền không hợp lệ, ví dụ: crm.example.com";
  if (route === "host" && existing.some((t) => t.id !== id && t.route === "host" && t.hostname === hostname)) {
    errors.hostname = "Tên miền này đã gán cho tunnel khác";
  }

  const hostHeader = String(pick("hostHeader", "rewrite"));
  if (!HOST_HEADERS.includes(hostHeader)) errors.hostHeader = "Giá trị không hợp lệ";

  const enabled = Boolean(pick("enabled", true));

  return {
    errors,
    tunnel: { id, name, protocol, localScheme, localHost, localPort, route, hostname, hostHeader, enabled },
  };
}

export function slugify(s) {
  return (
    String(s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 36)
      .replace(/-+$/, "") || "tunnel"
  );
}

function uniqueId(base, existing) {
  let id = base;
  for (let n = 2; existing.some((t) => t.id === id); n++) id = `${base}-${n}`;
  return id;
}
