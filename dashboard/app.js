// Mini Tunnel dashboard — plain JS, no build step. Talks to the local client's JSON API
// and receives live updates through Server-Sent Events (/api/events).

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const TUNNEL_STATUS = {
  online: { label: "Đang chạy", cls: "ok" },
  local_down: { label: "Ứng dụng local chưa chạy", cls: "warn" },
  offline: { label: "Chờ kết nối Worker", cls: "bad" },
  stopped: { label: "Đã dừng", cls: "off" },
};
const CONN_STATUS = {
  online: { label: "Đã kết nối", cls: "ok" },
  connecting: { label: "Đang kết nối…", cls: "busy" },
  offline: { label: "Mất kết nối", cls: "bad" },
  stopped: { label: "Đã ngắt kết nối", cls: "bad" },
  unconfigured: { label: "Chưa cấu hình Worker", cls: "off" },
  idle: { label: "Đang khởi động…", cls: "busy" },
};
const ROUTE_LABEL = { root: "Địa chỉ chính", path: "Đường dẫn riêng", host: "Tên miền riêng" };
const MAX_ROWS = 200;

const state = {
  snap: null,
  recent: [],
  logs: [],
  tab: "requests",
  filter: "",
  editing: null, // tunnel id being edited, null when creating
  idTouched: false,
};

// ------------------------------------------------------------------ formatting

const nf = new Intl.NumberFormat("vi-VN");

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace(".", ",")} ${units[i]}`;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ ${m % 60} phút`;
  return `${Math.floor(h / 24)} ngày ${h % 24} giờ`;
}

function fmtAgo(ts) {
  const ms = Date.now() - ts;
  return ms < 5000 ? "vừa xong" : `${fmtDuration(ms)} trước`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString("vi-VN", { hour12: false });
}

function fmtMs(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

function slugify(s) {
  return (
    String(s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 36)
      .replace(/-+$/, "")
  );
}

function icon(name, cls = "i sm") {
  return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ------------------------------------------------------------------ API

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("init", (e) => {
    const data = JSON.parse(e.data);
    state.recent = data.recent;
    state.logs = data.logs;
    $("#clientDown").hidden = true;
    applySnapshot(data);
    renderActivity();
  });
  es.addEventListener("snapshot", (e) => applySnapshot(JSON.parse(e.data)));
  es.addEventListener("request", (e) => {
    state.recent.push(JSON.parse(e.data));
    if (state.recent.length > MAX_ROWS) state.recent.shift();
    scheduleActivity();
  });
  es.addEventListener("log", (e) => {
    state.logs.push(JSON.parse(e.data));
    if (state.logs.length > MAX_ROWS) state.logs.shift();
    scheduleActivity();
  });
  es.onerror = () => {
    $("#clientDown").hidden = false;
  };
}

// ------------------------------------------------------------------ rendering

function applySnapshot(snap) {
  state.snap = snap;
  renderConnection();
  renderTunnels();
  renderSummary();
  renderFilterOptions();
  $("#footerVersion").textContent = `Mini Tunnel ${snap.version}`;
}

function renderConnection() {
  const c = state.snap.connection;
  const st = CONN_STATUS[c.state] || CONN_STATUS.idle;
  const pill = $("#connPill");
  pill.className = `conn-pill ${st.cls}`;
  $("#connLabel").textContent = st.label;
  updateConnExtra();

  const configured = c.state !== "unconfigured";
  $("#onboarding").hidden = configured;

  const showBanner = ["offline", "stopped"].includes(c.state) || (c.state === "connecting" && c.attempt > 0);
  $("#banner").hidden = !showBanner;
  if (showBanner) {
    $("#banner").className = `banner ${c.state === "connecting" ? "busy" : ""}`;
    $("#bannerTitle").textContent = c.state === "stopped" ? "Client đã bị ngắt khỏi Worker" : "Không kết nối được tới Cloudflare Worker";
    $("#bannerText").textContent = c.message || "Đang thử kết nối lại…";
  }
}

function updateConnExtra() {
  const c = state.snap?.connection;
  if (!c) return;
  let extra = "";
  if (c.state === "online" && c.latencyMs != null) extra = `${c.latencyMs} ms`;
  else if (c.state === "offline" && c.retryAt) {
    const s = Math.max(0, Math.ceil((c.retryAt - Date.now()) / 1000));
    extra = s ? `thử lại sau ${s}s` : "đang thử lại…";
  }
  $("#connExtra").textContent = extra;
}

function renderSummary() {
  const tunnels = state.snap.tunnels;
  $("#summary").hidden = tunnels.length === 0;
  const sum = (k) => tunnels.reduce((a, t) => a + t.stats[k], 0);
  $("#sumOnline").textContent = `${tunnels.filter((t) => t.status === "online").length} / ${tunnels.length}`;
  $("#sumRequests").textContent = nf.format(sum("requests"));
  $("#sumActive").textContent = nf.format(sum("active"));
  $("#sumBytes").textContent = `↓ ${fmtBytes(sum("rxBytes"))} · ↑ ${fmtBytes(sum("txBytes"))}`;
}

function renderTunnels() {
  const list = $("#tunnelList");
  const tunnels = state.snap.tunnels;
  const keep = new Set();
  tunnels.forEach((t, i) => {
    keep.add(t.id);
    let card = list.querySelector(`[data-id="${CSS.escape(t.id)}"]`);
    if (!card) {
      card = $("#tplTunnel").content.firstElementChild.cloneNode(true);
      card.dataset.id = t.id;
    }
    if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null);
    updateCard(card, t);
  });
  for (const card of [...list.children]) if (!keep.has(card.dataset.id)) card.remove();
  $("#emptyState").hidden = tunnels.length > 0;
}

function updateCard(card, t) {
  const st = TUNNEL_STATUS[t.status];
  const f = (name) => card.querySelector(`[data-f="${name}"]`);
  card.className = `card tunnel s-${st.cls}`;

  f("name").textContent = t.name;
  f("status").className = `badge ${st.cls}`;
  f("status").textContent = st.label;
  const since = t.status === "online" ? t.startedAt : null;
  f("uptime").dataset.since = since || "";
  f("uptime").textContent = since ? `· chạy ${fmtDuration(Date.now() - since)}` : "";
  card.querySelector('[data-action="toggle"]').checked = t.enabled;

  f("local").textContent = t.localUrl;
  const ls = f("localState");
  if (t.localUp === true) {
    ls.className = "ep-state ok";
    ls.innerHTML = `${icon("check")} Ứng dụng đang chạy`;
  } else if (t.localUp === false) {
    ls.className = "ep-state bad";
    ls.innerHTML = `${icon("x")} Không có ứng dụng ở cổng ${t.localPort}`;
  } else {
    ls.className = "ep-state";
    ls.textContent = "Đang kiểm tra…";
  }

  f("routeLabel").textContent = `Địa chỉ public · ${ROUTE_LABEL[t.route]}`;
  const pub = f("public");
  const open = f("open");
  if (t.publicUrl) {
    pub.textContent = t.publicUrl;
    pub.href = t.publicUrl;
    open.href = t.publicUrl;
    open.hidden = false;
    card.querySelector('[data-action="copy"]').hidden = false;
  } else {
    pub.textContent = "Chưa có — cần cấu hình Worker";
    pub.removeAttribute("href");
    open.hidden = true;
    card.querySelector('[data-action="copy"]').hidden = true;
  }

  f("hint").textContent = tunnelHint(t);
  f("requests").textContent = nf.format(t.stats.requests);
  f("active").textContent = nf.format(t.stats.active);
  f("rx").textContent = fmtBytes(t.stats.rxBytes);
  f("tx").textContent = fmtBytes(t.stats.txBytes);

  const le = f("lastError");
  le.hidden = !t.stats.lastError;
  le.dataset.at = t.stats.lastErrorAt || "";
  le.dataset.msg = t.stats.lastError || "";
  if (t.stats.lastError) le.textContent = `Lỗi gần nhất (${fmtAgo(t.stats.lastErrorAt)}): ${t.stats.lastError}`;
}

function tunnelHint(t) {
  const conn = state.snap.connection.state;
  switch (t.status) {
    case "stopped":
      return "Tunnel đang tắt — người ngoài sẽ thấy trang \"Tunnel đang tạm dừng\". Bật công tắc để public lại.";
    case "offline":
      return conn === "unconfigured" ? "Chưa kết nối Worker. Làm theo hướng dẫn ở đầu trang." : "Đang chờ kết nối tới Cloudflare Worker…";
    case "local_down":
      return `Hãy khởi động ứng dụng của bạn ở ${t.localUrl}. Tunnel sẽ tự hoạt động ngay khi ứng dụng chạy.`;
    default:
      if (t.route === "host") return `Nhớ gắn tên miền ${t.hostname} vào Worker trong Cloudflare để địa chỉ này hoạt động.`;
      return "Gửi địa chỉ public cho người khác để họ truy cập ứng dụng của bạn.";
  }
}

function renderFilterOptions() {
  const select = $("#filterTunnel");
  const wanted = ["", ...state.snap.tunnels.map((t) => t.id)].join("|");
  if (select.dataset.ids === wanted) return;
  select.dataset.ids = wanted;
  const current = select.value;
  select.innerHTML =
    `<option value="">Tất cả tunnel</option>` +
    state.snap.tunnels.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  select.value = state.snap.tunnels.some((t) => t.id === current) ? current : "";
  state.filter = select.value;
}

let activityQueued = false;
function scheduleActivity() {
  if (activityQueued) return;
  activityQueued = true;
  requestAnimationFrame(() => {
    activityQueued = false;
    renderActivity();
  });
}

function tunnelName(id) {
  return state.snap?.tunnels.find((t) => t.id === id)?.name || id || "";
}

function renderActivity() {
  const match = (e) => !state.filter || e.tunnel === state.filter;

  const rows = state.recent.filter(match).slice(-100).reverse();
  $("#requestRows").innerHTML = rows
    .map((r) => {
      const result = r.error
        ? `<span class="code err">${r.status ? r.status : "Lỗi"}</span><span class="err-msg">${esc(r.error)}</span>`
        : `<span class="code c${String(r.status)[0]}">${r.status}</span>`;
      return `<tr>
        <td>${fmtTime(r.time)}</td>
        <td>${esc(tunnelName(r.tunnel))}</td>
        <td class="path" title="${esc(r.path)}"><span class="method">${esc(r.method)}</span>${esc(r.path)}</td>
        <td>${result}</td>
        <td class="num">${fmtMs(r.ms)}</td>
        <td class="num">${fmtBytes(r.bytesOut)}</td>
      </tr>`;
    })
    .join("");
  $("#requestsEmpty").hidden = rows.length > 0;

  const logs = state.logs.filter(match).slice(-200).reverse();
  $("#logRows").innerHTML = logs
    .map(
      (l) => `<li class="${l.level}"><span>${fmtTime(l.time)}</span><span class="lv">${l.level.toUpperCase()}</span>` +
        `<span class="tn">${l.tunnel ? esc(tunnelName(l.tunnel)) : ""}</span><span class="msg">${esc(l.message)}</span></li>`,
    )
    .join("");
  $("#logsEmpty").hidden = logs.length > 0;
}

function setTab(tab) {
  state.tab = tab;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#requestsView").hidden = tab !== "requests";
  $("#logsView").hidden = tab !== "logs";
}

// Live counters that depend on the clock.
setInterval(() => {
  updateConnExtra();
  for (const el of $$('[data-f="uptime"]')) {
    const since = Number(el.dataset.since);
    el.textContent = since ? `· chạy ${fmtDuration(Date.now() - since)}` : "";
  }
  for (const el of $$('[data-f="lastError"]:not([hidden])')) {
    const at = Number(el.dataset.at);
    if (at) el.textContent = `Lỗi gần nhất (${fmtAgo(at)}): ${el.dataset.msg}`;
  }
}, 1000);

// ------------------------------------------------------------------ toasts & confirm

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "bad" ? 6000 : 3000);
}

function confirmDialog({ title, text, ok = "Xóa" }) {
  const dlg = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  $("#confirmOk").textContent = ok;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true }));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Đã sao chép");
}

// ------------------------------------------------------------------ tunnel form

const form = $("#tunnelForm");
const fields = form.elements;

function origin() {
  return state.snap?.settings.relayUrl || "https://ten-worker.workers.dev";
}

function openTunnelForm(t = null) {
  state.editing = t?.id ?? null;
  state.idTouched = Boolean(t);
  form.reset();
  clearErrors(form);
  $("#localCheck").textContent = "";

  const hasRoot = state.snap.tunnels.some((x) => x.route === "root" && x.id !== t?.id);
  $("#tunnelDialogTitle").textContent = t ? `Sửa tunnel "${t.name}"` : "Thêm tunnel";
  $("#tunnelSubmit").textContent = t ? "Lưu thay đổi" : "Tạo tunnel";
  fields.name.value = t?.name ?? "";
  fields.id.value = t?.id ?? "";
  fields.id.disabled = Boolean(t);
  fields.localScheme.value = t?.localScheme ?? "http";
  fields.localHost.value = t?.localHost ?? "127.0.0.1";
  fields.localPort.value = t?.localPort ?? "";
  fields.route.value = t?.route ?? (hasRoot ? "path" : "root");
  fields.hostname.value = t?.hostname ?? "";
  fields.hostHeader.value = t?.hostHeader ?? "rewrite";
  fields.enabled.checked = t?.enabled ?? true;
  $(".advanced").open = t?.hostHeader === "preserve";

  updateFormPreview();
  if (fields.localPort.value) checkLocalSoon(0);
  $("#tunnelDialog").showModal();
  (t ? fields.name : fields.localPort).focus();
}

function formValues() {
  const port = fields.localPort.value.trim();
  return {
    // An empty name falls back to the suggestion shown as placeholder ("Ứng dụng 8001").
    name: fields.name.value.trim() || (port ? `Ứng dụng ${port}` : ""),
    id: fields.id.value.trim(),
    protocol: "http",
    localScheme: fields.localScheme.value,
    localHost: fields.localHost.value.trim() || "127.0.0.1",
    localPort: port === "" ? null : Number(port),
    route: fields.route.value,
    hostname: fields.hostname.value.trim(),
    hostHeader: fields.hostHeader.value,
    enabled: fields.enabled.checked,
  };
}

function updateFormPreview() {
  const v = formValues();
  const port = v.localPort || "…";
  fields.name.placeholder = v.localPort ? `Ứng dụng ${v.localPort}` : "VD: CRM";
  if (!state.idTouched && !state.editing) fields.id.value = slugify(v.name);
  const id = fields.id.value || "ten-tunnel";

  // https://<worker-name>.<subdomain>.workers.dev → <worker-name>
  const host = new URL(origin()).hostname;
  $("#workerName").textContent = host.endsWith(".workers.dev") ? host.split(".")[0] : "tên Worker";
  $('[data-preview="root"]').textContent = `${origin()}/`;
  $('[data-preview="path"]').textContent = `${origin()}/t/${id}/`;
  fields.hostname.disabled = v.route !== "host";

  const rootOwner = state.snap.tunnels.find((x) => x.route === "root" && x.id !== state.editing);
  $("#rootNote").hidden = !(rootOwner && v.route === "root");
  if (rootOwner) $("#rootNote").textContent = `Đang được "${rootOwner.name}" dùng — tunnel đó sẽ chuyển sang đường dẫn riêng.`;

  $$(".chip").forEach((c) => c.classList.toggle("active", c.dataset.port === String(v.localPort)));

  const publicUrl = v.route === "root" ? `${origin()}/` : v.route === "path" ? `${origin()}/t/${id}/` : v.hostname ? `https://${v.hostname}/` : "https://tên-miền-của-bạn/";
  $("#formPreview").innerHTML = `Ai mở <b>${esc(publicUrl)}</b> sẽ thấy ứng dụng đang chạy tại <b>${esc(`${v.localScheme}://${v.localHost}:${port}`)}</b> trên máy này.`;
}

let checkTimer = null;
let checkSeq = 0;
function checkLocalSoon(delay = 400) {
  clearTimeout(checkTimer);
  const { localHost, localPort } = formValues();
  const out = $("#localCheck");
  if (!localPort || localPort < 1 || localPort > 65535) {
    out.textContent = "";
    return;
  }
  checkTimer = setTimeout(async () => {
    const seq = ++checkSeq;
    out.className = "check";
    out.textContent = "Đang kiểm tra…";
    try {
      const r = await api("POST", "/api/check-local", { host: localHost, port: localPort });
      if (seq !== checkSeq) return;
      if (r.ok) {
        out.className = "check ok";
        out.innerHTML = `${icon("check")}<span>Có ứng dụng đang chạy ở ${esc(localHost)}:${localPort}.</span>`;
      } else {
        out.className = "check bad";
        out.innerHTML = `${icon("alert")}<span>Chưa có ứng dụng nào ở ${esc(localHost)}:${localPort}. Bạn vẫn có thể lưu — tunnel sẽ hoạt động khi ứng dụng chạy.</span>`;
      }
    } catch {
      out.textContent = "";
    }
  }, delay);
}

form.addEventListener("input", (e) => {
  if (e.target === fields.id) state.idTouched = true;
  if (["localHost", "localPort", "localScheme"].includes(e.target.name)) checkLocalSoon();
  if (e.target.name === "localPort") e.target.value = e.target.value.replace(/\D/g, "").slice(0, 5);
  e.target.classList?.remove("invalid");
  updateFormPreview();
});
form.addEventListener("change", updateFormPreview);

$("#portChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  fields.localPort.value = chip.dataset.port;
  updateFormPreview();
  checkLocalSoon(0);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors(form);
  const values = formValues();
  if (state.editing) delete values.id;
  else if (!values.id) delete values.id;
  const btn = $("#tunnelSubmit");
  btn.disabled = true;
  try {
    const r = state.editing
      ? await api("PUT", `/api/tunnels/${encodeURIComponent(state.editing)}`, values)
      : await api("POST", "/api/tunnels", values);
    $("#tunnelDialog").close();
    toast(state.editing ? "Đã lưu thay đổi" : `Đã tạo tunnel "${r.tunnel.name}"`);
    if (r.moved) toast(`"${r.moved}" đã chuyển sang đường dẫn riêng`);
  } catch (err) {
    showErrors(form, err.data?.errors, err.message);
  } finally {
    btn.disabled = false;
  }
});

function clearErrors(scope) {
  $$("[data-error]", scope).forEach((el) => (el.textContent = ""));
  $$(".invalid", scope).forEach((el) => el.classList.remove("invalid"));
}

function showErrors(scope, errors, fallback) {
  if (!errors) {
    $('[data-error="_"]', scope) ? ($('[data-error="_"]', scope).textContent = fallback) : toast(fallback, "bad");
    return;
  }
  for (const [key, message] of Object.entries(errors)) {
    const slot = $(`[data-error="${key}"]`, scope) || $('[data-error="_"]', scope);
    if (slot) slot.textContent = message;
    scope.elements[key]?.classList?.add("invalid");
  }
  scope.querySelector(".invalid")?.focus();
}

// ------------------------------------------------------------------ settings

const settingsForm = $("#settingsForm");

function openSettings() {
  const s = state.snap.settings;
  clearErrors(settingsForm);
  settingsForm.elements.relayUrl.value = s.relayUrl || "";
  settingsForm.elements.token.value = "";
  settingsForm.elements.token.type = "password";
  settingsForm.elements.token.placeholder = s.tokenSet ? "Đã lưu — để trống nếu không đổi" : "Dán token vào đây";
  $("#sUrlEnv").hidden = !s.env.relayUrl;
  $("#sTokenEnv").hidden = !s.env.token;
  $("#configPath").textContent = s.configPath;
  $("#testResult").hidden = true;
  $("#settingsDialog").showModal();
  (s.relayUrl ? settingsForm.elements.token : settingsForm.elements.relayUrl).focus();
}

async function testSettings() {
  const box = $("#testResult");
  box.hidden = false;
  box.className = "test-result busy";
  box.textContent = "Đang kiểm tra kết nối tới Worker…";
  try {
    const r = await api("POST", "/api/settings/test", {
      relayUrl: settingsForm.elements.relayUrl.value,
      token: settingsForm.elements.token.value,
    });
    box.className = `test-result ${r.ok ? "ok" : "bad"}`;
    box.innerHTML = r.ok
      ? `${icon("check")}<span>Kết nối được Worker và token hợp lệ.</span>`
      : `${icon("x")}<span>${esc(r.message)}</span>`;
  } catch (err) {
    box.className = "test-result bad";
    box.textContent = err.message;
  }
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors(settingsForm);
  try {
    await api("PUT", "/api/settings", {
      relayUrl: settingsForm.elements.relayUrl.value,
      token: settingsForm.elements.token.value,
    });
    $("#settingsDialog").close();
    toast("Đã lưu — đang kết nối tới Worker…");
  } catch (err) {
    showErrors(settingsForm, err.data?.errors, err.message);
  }
});

// ------------------------------------------------------------------ actions

async function tunnelAction(id, action, el) {
  const t = state.snap.tunnels.find((x) => x.id === id);
  if (!t) return;
  try {
    switch (action) {
      case "toggle":
        await api("POST", `/api/tunnels/${encodeURIComponent(id)}/${el.checked ? "start" : "stop"}`);
        toast(el.checked ? `Đã bật "${t.name}"` : `Đã dừng "${t.name}"`);
        break;
      case "restart":
        await api("POST", `/api/tunnels/${encodeURIComponent(id)}/restart`);
        toast(`Đã khởi động lại "${t.name}"`);
        break;
      case "edit":
        openTunnelForm(t);
        break;
      case "delete":
        if (await confirmDialog({ title: `Xóa tunnel "${t.name}"?`, text: `Địa chỉ ${t.publicUrl || ""} sẽ ngừng hoạt động. Ứng dụng local của bạn không bị ảnh hưởng.` })) {
          await api("DELETE", `/api/tunnels/${encodeURIComponent(id)}`);
          toast(`Đã xóa "${t.name}"`);
        }
        break;
      case "copy":
        if (t.publicUrl) await copy(t.publicUrl);
        break;
      case "logs":
        $("#filterTunnel").value = id;
        state.filter = id;
        setTab("logs");
        renderActivity();
        $("#logsView").scrollIntoView({ behavior: "smooth", block: "nearest" });
        break;
    }
  } catch (err) {
    if (action === "toggle") el.checked = !el.checked;
    toast(err.message, "bad");
  }
}

document.addEventListener("click", async (e) => {
  const closer = e.target.closest("[data-close]");
  if (closer) {
    closer.closest("dialog").close();
    return;
  }
  const el = e.target.closest("[data-action]");
  if (!el || el.dataset.action === "toggle") return;
  const action = el.dataset.action;
  const card = el.closest(".tunnel");
  if (card) {
    e.preventDefault();
    return tunnelAction(card.dataset.id, action, el);
  }
  switch (action) {
    case "add":
      return openTunnelForm();
    case "settings":
      e.preventDefault();
      return openSettings();
    case "reconnect":
      await api("POST", "/api/reconnect").catch((err) => toast(err.message, "bad"));
      return;
    case "copy-text":
      return copy(el.dataset.text);
    case "test-settings":
      return testSettings();
    case "toggle-token": {
      const input = settingsForm.elements.token;
      input.type = input.type === "password" ? "text" : "password";
      return;
    }
    case "clear-activity": {
      const kind = state.tab === "logs" ? "logs" : "requests";
      await api("DELETE", `/api/activity?kind=${kind}`).catch(() => {});
      if (kind === "logs") state.logs = [];
      else state.recent = [];
      renderActivity();
      return;
    }
  }
});

document.addEventListener("change", (e) => {
  if (e.target.matches('.tunnel [data-action="toggle"]')) {
    tunnelAction(e.target.closest(".tunnel").dataset.id, "toggle", e.target);
  }
});

$$(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
$("#filterTunnel").addEventListener("change", (e) => {
  state.filter = e.target.value;
  renderActivity();
});

// Close dialogs when clicking on the backdrop.
$$("dialog").forEach((dlg) =>
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  }),
);

connectEvents();
