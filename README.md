# Mini Tunnel — HTTP qua Cloudflare Worker

Public ứng dụng đang chạy trên máy bạn (ví dụ `localhost:8001`) ra Internet bằng một địa chỉ `https://…workers.dev`, kể cả khi máy nằm sau CGNAT. Không cần VPS, không cần mở port, không cần IP tĩnh.

Đây là Phase 2 (HTTP) trong [mini-playit-tunnel-spec.md](mini-playit-tunnel-spec.md). Hỗ trợ HTTP/HTTPS (mọi method, header, cookie, body, status, streaming/SSE) và WebSocket. TCP/UDP cho game cần VPS relay, sẽ làm ở phase sau.

```text
Người truy cập ──https──▶ Cloudflare Worker ◀══ WebSocket (máy bạn tự kết nối ra) ══ Client local ──▶ localhost:8001
```

## Yêu cầu

- Node.js 22 trở lên (client không cần cài thêm package nào)
- Tài khoản Cloudflare (gói miễn phí là đủ)

## Bắt đầu nhanh

```bash
# 1. Deploy Worker lên Cloudflare (chỉ làm một lần)
npm run setup

# 2. Chạy client + dashboard
npm start
```

Mở **http://127.0.0.1:8787**, bấm **Thêm tunnel**, nhập cổng của ứng dụng, rồi gửi địa chỉ public cho người khác.

Trên Windows có thể nhấp đúp `start.cmd` để chạy client và tự mở dashboard.

### `npm run setup` làm gì?

1. Cài `wrangler` (Cloudflare CLI) vào `worker/`.
2. Mở trình duyệt để bạn đăng nhập Cloudflare (nếu chưa đăng nhập).
3. Deploy Worker (tên lấy từ dòng `name` trong [worker/wrangler.toml](worker/wrangler.toml), xem [Đổi tên Worker](#đổi-tên-worker--địa-chỉ-public)), gồm cả Durable Object `TunnelHub`.
4. Tạo token ngẫu nhiên và lưu vào Worker dưới dạng secret `TUNNEL_TOKEN`.
5. Ghi Worker URL và token vào `data/config.json`, rồi kiểm tra kết nối.

Chạy lại `npm run setup` sẽ deploy lại và dùng lại token cũ. Muốn đổi token thì chạy `npm run setup -- --new-token`.

Nếu client đang chạy sẵn, nó tự nhận cấu hình mới mà không cần khởi động lại.

> Tài khoản Cloudflare mới cần một subdomain `workers.dev`. Nếu bước deploy báo lỗi này, vào dash.cloudflare.com → Workers & Pages để tạo subdomain (miễn phí), rồi chạy lại.

### Deploy lại Worker sau khi sửa code

```bash
npm run deploy        # chạy ở thư mục gốc project
```

> ⚠️ **Không chạy `npx wrangler deploy` ở thư mục gốc.** Không thấy cấu hình ở đó, wrangler sẽ tự tạo `wrangler.jsonc` và deploy thư mục `dashboard/` thành một trang tĩnh. Sau đó, kể cả khi chạy trong `worker/`, wrangler vẫn ưu tiên file `wrangler.jsonc` này. Nếu lỡ chạy rồi, hãy xóa `wrangler.jsonc`, `package-lock.json` và `node_modules/` ở thư mục gốc. Các lệnh trong project đều chỉ định `--config wrangler.toml` để tránh nhầm.

### Đổi tên Worker / địa chỉ public

Địa chỉ có dạng `https://<tên-worker>.<subdomain>.workers.dev`:

- **`<tên-worker>`**: dòng `name = "..."` trong [worker/wrangler.toml](worker/wrangler.toml). Gồm chữ thường, số và dấu `-`, tối đa 63 ký tự. **Chỉ sửa dòng `name`**: `TUNNEL_HUB` và `TunnelHub` là tên nội bộ mà code dùng, đổi sẽ làm Worker báo lỗi 1101. Sửa xong thì chạy lại `npm run setup`. Script sẽ deploy Worker mới, dùng lại token cũ và ghi URL mới vào cấu hình; client đang chạy tự kết nối sang. Worker cũ vẫn còn trên Cloudflare, xóa bằng `npx wrangler delete --name <tên-cũ>` (chạy trong `worker/`) hoặc trong trang quản trị Cloudflare.
- **`<subdomain>`**: subdomain workers.dev của cả tài khoản, đổi ở dash.cloudflare.com → Workers & Pages → Subdomain. Mọi Worker trong tài khoản sẽ đổi theo, và sau khi đổi phải chạy lại `npm run setup` để cập nhật URL.
- **Muốn bỏ hẳn đuôi workers.dev**: dùng kiểu địa chỉ "Tên miền riêng" (cần domain trên Cloudflare).

### Cài thủ công (không dùng script)

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy --config wrangler.toml                   # ghi lại URL https://<tên-worker>.<subdomain>.workers.dev
npx wrangler secret put TUNNEL_TOKEN --config wrangler.toml  # dán một chuỗi ngẫu nhiên dài
```

Sau đó mở dashboard → nút **Chưa cấu hình Worker** ở góc phải, nhập Worker URL và token, bấm **Kiểm tra**, rồi **Lưu & kết nối**.

## Dashboard

- **Trạng thái kết nối** (góc phải): đã kết nối kèm độ trễ, đang kết nối, hoặc mất kết nối kèm lý do và thời gian đếm ngược tới lần thử lại.
- **Mỗi tunnel** hiển thị:
  - luồng `Máy của bạn → Địa chỉ public`;
  - ứng dụng local có đang chạy không (kiểm tra mỗi 10 giây);
  - công tắc bật/dừng;
  - thống kê: request, kết nối đang mở, dữ liệu nhận/gửi, lỗi gần nhất;
  - các nút Nhật ký, Khởi động lại, Sửa, Xóa.
- **Thêm tunnel**:
  - nhập cổng (có nút chọn nhanh các cổng hay dùng) và thấy ngay cổng đó có ứng dụng chạy chưa;
  - mã tunnel tự sinh từ tên, kể cả tên tiếng Việt;
  - xem trước địa chỉ public.
- **Request gần đây / Nhật ký**: cập nhật trực tiếp và lọc được theo tunnel.

Trạng thái tunnel:

| Trạng thái | Ý nghĩa |
|---|---|
| Đang chạy | Người ngoài truy cập được |
| Ứng dụng local chưa chạy | Tunnel sẵn sàng nhưng không có gì ở cổng local. Bật ứng dụng lên là chạy |
| Chờ kết nối Worker | Client chưa kết nối được tới Cloudflare |
| Đã dừng | Bạn đã tắt tunnel. Người ngoài thấy trang "Tunnel đang tạm dừng" |

### Ba kiểu địa chỉ public

| Kiểu | Ví dụ | Khi nào dùng |
|---|---|---|
| Địa chỉ chính | `https://mini-tunnel.ten.workers.dev/` | Mặc định, hợp với mọi web app. Chỉ một tunnel được dùng |
| Đường dẫn riêng | `https://mini-tunnel.ten.workers.dev/t/api/` | Chạy nhiều tunnel cùng lúc. Hợp với API; web app dùng đường dẫn tuyệt đối (`/static/…`) có thể lỗi |
| Tên miền riêng | `https://crm.example.com/` | Nhiều web app, mỗi app một domain. Domain phải nằm trên Cloudflare và được gắn vào Worker (Workers & Pages → `<tên-worker>` → Settings → Domains & Routes) |

Mọi tunnel đều luôn truy cập được qua `/t/<mã>/`.

## Cấu hình

`data/config.json` được tạo tự động; nên chỉnh tunnel qua dashboard. Xem mẫu ở [config/config.example.json](config/config.example.json).

Biến môi trường (hoặc file `.env`, xem [.env.example](.env.example)):

| Biến | Tác dụng |
|---|---|
| `TUNNEL_URL` | Ghi đè Worker URL |
| `TUNNEL_TOKEN` | Ghi đè token |
| `DASHBOARD_PORT` | Đổi cổng dashboard (mặc định 8787) |
| `MINI_TUNNEL_CONFIG` | Đường dẫn file cấu hình khác |

## Bảo mật

- Client chỉ kết nối tới Worker khi có token đúng. Token được so sánh constant-time, không nằm trong source và không xuất hiện trong log.
- Dashboard chỉ lắng nghe trên `127.0.0.1` và chặn Host lạ (chống DNS rebinding). Mọi thao tác thay đổi phải dùng JSON và cùng Origin (chống CSRF). Nhờ vậy một trang web lạ không thể lén mở tunnel tới cổng trên máy bạn.
- Dashboard không bao giờ trả token về trình duyệt.
- Trang `/__tunnel/*` trên Worker là đường dành riêng cho client, luôn yêu cầu token.

## Giới hạn cần biết

- **Quota gói miễn phí:** mỗi request public tính 1 request Worker và 1 request Durable Object, cả hai đều có quota theo ngày. Khoảng 100.000 request/ngày, đủ cho dùng cá nhân hoặc nhóm nhỏ; xem bảng giá Workers và Durable Objects của Cloudflare để biết con số mới nhất.
- **Một Durable Object** xử lý toàn bộ traffic, phù hợp cho dùng cá nhân hoặc nhóm nhỏ.
- **Upload** bị giới hạn bởi kích thước body tối đa của Cloudflare (100 MB ở gói Free/Pro).
- **WebSocket tới `wss://` local** dùng chứng chỉ tự ký thì chưa hỗ trợ. `https://` local với chứng chỉ tự ký thì vẫn chạy.
- **Ứng dụng local thấy mọi request đến từ client.** IP thật của người truy cập nằm trong header `X-Forwarded-For` / `X-Real-IP`.
- **Chỉ một client cho mỗi token.** Client mới kết nối sẽ đẩy client cũ ra; dashboard của client cũ báo rõ và có nút giành lại.

## Phát triển và test local

```bash
cd worker && npm install
cp .dev.vars.example .dev.vars           # TUNNEL_TOKEN cho môi trường dev
npx wrangler dev --config wrangler.toml --port 8788   # Worker + Durable Object chạy local
```

Ở terminal khác, trỏ client tới Worker local:

```bash
# bash / Git Bash
TUNNEL_URL=http://127.0.0.1:8788 TUNNEL_TOKEN=dev-token-change-me npm start
```

```powershell
# PowerShell
$env:TUNNEL_URL="http://127.0.0.1:8788"; $env:TUNNEL_TOKEN="dev-token-change-me"; npm start
```

Hoặc ghi hai biến này vào file `.env` ở thư mục gốc; file này không bị commit.

## Đưa lên Git và dùng trên máy khác

Repo **không chứa thông tin nhạy cảm**. [.gitignore](.gitignore) đã loại các file sau:

| Không commit | Chứa gì |
|---|---|
| `data/` | `config.json` với Worker URL, **token** và danh sách tunnel |
| `.env`, `.env.*` | Biến môi trường, có thể chứa token |
| `.dev.vars*` | Token dùng cho `wrangler dev` |
| `.wrangler/`, `/wrangler.json(c)` | Cache tài khoản Cloudflare, cấu hình wrangler tự sinh |
| `node_modules/` | Thư viện, cài lại bằng `npm install` |

Các file mẫu `.env.example`, `worker/.dev.vars.example`, `config/config.example.json` vẫn được commit. Token thật chỉ nằm ở hai nơi: secret `TUNNEL_TOKEN` trên Cloudflare và `data/config.json` trên máy bạn.

Đẩy lên lần đầu:

```bash
git init
git add .
git status            # kiểm tra: KHÔNG được thấy data/, .env, .dev.vars, wrangler.jsonc
git commit -m "Mini Tunnel: HTTP tunnel qua Cloudflare Worker + dashboard"
git branch -M main
git remote add origin <url-repo>
git push -u origin main
```

Dùng trên máy khác:

```bash
git clone <url-repo> && cd <thư-mục>
npm run setup         # tạo data/config.json trên máy này
npm start
```

> `npm run setup` trên máy mới sẽ tạo **token mới** và cập nhật secret trên Worker, nên client ở máy cũ sẽ mất kết nối. Mỗi token chỉ dùng được cho một client. Muốn chuyển hẳn sang máy mới mà giữ token cũ, hãy chép `data/config.json` qua bằng cách riêng (USB, trình quản lý mật khẩu…), **không qua Git**.

## Cấu trúc

```text
client/src/
  index.js             khởi động: nối các module, mở dashboard
  connection.js        WebSocket tới Worker: xác thực, heartbeat, reconnect (1s→2s→5s→10s→30s)
  http-tunnel.js       chuyển request HTTP/WebSocket tới ứng dụng local, kiểm soát luồng
  tunnel-manager.js    CRUD tunnel, start/stop, thống kê, kiểm tra cổng local
  dashboard-server.js  API JSON + Server-Sent Events cho dashboard
  config.js            đọc/ghi data/config.json, validate
  protocol.js          định dạng frame dùng chung với Worker
  logger.js            log ra console và lưu vào bộ nhớ cho dashboard
dashboard/             giao diện (HTML/CSS/JS thuần, không cần build)
worker/src/worker.js   Cloudflare Worker + Durable Object TunnelHub
worker/wrangler.toml   cấu hình Worker: tên (= địa chỉ public), binding Durable Object
scripts/setup.js       npm run setup
start.cmd              chạy client + mở dashboard (Windows, nhấp đúp)
```

### Giao thức client ↔ Worker

Mọi thứ đi qua một WebSocket duy nhất:

- **Text frame:** JSON điều khiển, gồm `register`, `req`, `res`, `end`, `err`, `ack`, `cancel`, `ws_open`, `ws_ok`, `ws_close`. Heartbeat `{"t":"ping"}` được Cloudflare tự trả lời mà không đánh thức Durable Object.
- **Binary frame:** `[type u8][stream id u32][payload]`, dùng cho body và message WebSocket. Mỗi frame tối đa 64 KB.
- **Kiểm soát luồng:** mỗi stream chỉ được gửi tối đa 512 KB chưa được xác nhận (`ack`). Nhờ vậy tải file lớn tới người dùng mạng chậm không làm tràn bộ nhớ Worker hay client.
