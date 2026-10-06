import { EventEmitter } from "node:events";

const MAX_ENTRIES = 500;
const COLORS = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };

// Keeps recent log lines in memory for the dashboard and mirrors them to the console.
// Never pass secrets (tokens) into log messages.
export class Logger extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.seq = 0;
  }

  info(message, tunnel) {
    this.write("info", message, tunnel);
  }

  warn(message, tunnel) {
    this.write("warn", message, tunnel);
  }

  error(message, tunnel) {
    this.write("error", message, tunnel);
  }

  write(level, message, tunnel = null) {
    const entry = { seq: ++this.seq, time: Date.now(), level, message: String(message), tunnel };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();

    const time = new Date(entry.time).toLocaleTimeString("vi-VN", { hour12: false });
    const tag = tunnel ? ` [${tunnel}]` : "";
    const color = process.stdout.isTTY ? COLORS[level] : "";
    const reset = color ? "\x1b[0m" : "";
    console.log(`${time} ${color}${level.toUpperCase().padEnd(5)}${reset}${tag} ${entry.message}`);

    this.emit("log", entry);
  }

  recent(limit = 200) {
    return this.entries.slice(-limit);
  }
}
