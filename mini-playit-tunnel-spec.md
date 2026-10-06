# Mini Playit.gg / Local Tunnel System

## 1. Mục tiêu

Xây dựng một hệ thống tunnel tự quản lý, tương tự Playit.gg/ngrok, cho phép public service đang chạy trong máy local ra Internet dù máy local nằm sau CGNAT.

Hệ thống phải hỗ trợ:

- HTTP/HTTPS
- WebSocket
- TCP game server
- UDP game server
- Một local client duy nhất quản lý nhiều tunnel
- Dashboard local để tạo/sửa/xóa/start/stop tunnel
- Tự reconnect khi mất mạng hoặc server restart
- Có authentication/token
- Có thống kê traffic, connection và trạng thái

---

## 2. Vấn đề cần giải quyết

Máy người dùng ở nhà thường:

```text
Internet
   |
   | CGNAT
   |
Router
   |
PC local
```

Do CGNAT nên không thể đơn giản port-forward từ Internet vào PC.

Tuy nhiên PC local vẫn có thể chủ động kết nối outbound tới một server có public IP.

Giải pháp:

```text
Internet
    |
    v
Public Relay VPS
    |
    | persistent tunnel
    v
Local Client
    |
    +--> localhost:8001
    +--> localhost:25565
    +--> localhost:7777
```

Local Client luôn chủ động kết nối tới Relay VPS nên không cần mở port trên router.

---

# 3. Kiến trúc tổng thể

Có 3 thành phần chính.

## A. Local Client

Chạy trên PC người dùng.

Nhiệm vụ:

- Kết nối outbound tới Relay Server
- Duy trì persistent connection
- Auto reconnect
- Authenticate
- Forward HTTP request tới localhost
- Forward TCP stream tới local TCP server
- Forward UDP packet tới local UDP server
- Quản lý nhiều tunnel
- Gửi heartbeat
- Thu thập thống kê
- Cung cấp API cho dashboard local

Ví dụ:

```text
client.exe
```

---

## B. Relay Server

Chạy trên VPS có public IPv4.

Đây là thành phần bắt buộc cho TCP/UDP.

Nhiệm vụ:

- Có public IP
- Listen các public TCP/UDP port
- Nhận traffic từ Internet
- Xác định tunnel tương ứng
- Chuyển traffic qua connection tới Local Client
- Nhận traffic từ Local Client và trả lại Internet
- Authentication
- Quản lý client/tunnel/session
- Timeout và cleanup
- Statistics

Relay Server KHÔNG chạy game server.

Nó chỉ làm nhiệm vụ trung chuyển traffic.

Ví dụ:

```text
Player
  |
  | 1.2.3.4:30001
  v
Relay VPS
  |
  | tunnel
  v
Local Client
  |
  v
127.0.0.1:25565
```

---

## C. Cloudflare Worker

Dùng cho HTTP/HTTPS nếu muốn sử dụng domain cố định:

```text
https://abc.workers.dev
```

Worker không thể trực tiếp forward raw TCP/UDP game traffic.

Worker phù hợp với:

- HTTP
- HTTPS
- WebSocket

Worker có thể giao tiếp với Local Client qua persistent WebSocket.

Ví dụ:

```text
Internet
   |
   v
Cloudflare Worker
   |
   | WebSocket tunnel
   v
Local Client
   |
   v
localhost:8001
```

---

# 4. Vì sao cần Relay Server?

Cloudflare Worker không phải TCP/UDP relay server.

Nếu muốn public game server:

```text
TCP :25565
UDP :7777
```

thì cần một máy có public IP thực sự để listen các port này.

Relay VPS chính là máy đó.

Có thể hiểu:

> Relay Server = trạm trung chuyển có public IP.

Playit.gg cũng sử dụng mô hình tương tự về mặt kiến trúc: client ở máy local tạo outbound tunnel tới infrastructure public, sau đó traffic Internet được chuyển qua tunnel.

---

# 5. Luồng TCP

Ví dụ game chạy:

```text
127.0.0.1:25565
```

Public:

```text
VPS_IP:30001
```

Flow:

```text
Game Player
     |
     | TCP connect :30001
     v
Relay Server
     |
     | tunnel stream
     v
Local Client
     |
     | TCP connect
     v
127.0.0.1:25565
```

Response đi ngược lại:

```text
Game Server
     |
Local Client
     |
Relay Server
     |
Player
```

TCP phải giữ nguyên byte stream, không được xử lý như HTTP.

---

# 6. Luồng UDP

Ví dụ game:

```text
127.0.0.1:7777/UDP
```

Public:

```text
VPS_IP:30002/UDP
```

Flow:

```text
Player
   |
   | UDP packet
   v
Relay VPS
   |
   | tunnel
   v
Local Client
   |
   v
127.0.0.1:7777
```

UDP phức tạp hơn TCP vì phải quản lý:

- Source IP
- Source port
- Destination
- Session mapping
- Timeout
- NAT-like mapping
- Concurrent players

Mỗi UDP flow cần được map tới local service phù hợp.

---

# 7. Multiplexing

Không nên tạo một connection riêng tới server cho mỗi request.

Local Client nên có persistent connection.

Ví dụ:

```text
Local Client
     |
     | persistent connection
     |
     +--- HTTP tunnel
     +--- TCP tunnel
     +--- UDP tunnel
     +--- heartbeat
     +--- control messages
```

Protocol cần có:

```text
client_id
tunnel_id
connection_id
request_id
message_type
payload
```

Ví dụ message types:

```text
AUTH
AUTH_OK
HEARTBEAT
TUNNEL_REGISTER
TUNNEL_UNREGISTER
TCP_OPEN
TCP_DATA
TCP_CLOSE
UDP_DATA
UDP_CLOSE
HTTP_REQUEST
HTTP_RESPONSE
ERROR
```

Có thể thiết kế binary framing cho TCP/UDP để tránh ambiguity khi truyền stream.

---

# 8. Cấu hình tunnel

Ví dụ:

```json
{
  "tunnels": [
    {
      "id": "crm",
      "name": "CRM",
      "protocol": "http",
      "localHost": "127.0.0.1",
      "localPort": 8001,
      "enabled": true,
      "autoStart": true
    },
    {
      "id": "minecraft",
      "name": "Minecraft",
      "protocol": "tcp",
      "localHost": "127.0.0.1",
      "localPort": 25565,
      "remotePort": 30001,
      "enabled": true,
      "autoStart": true
    },
    {
      "id": "game-udp",
      "name": "Game UDP",
      "protocol": "udp",
      "localHost": "127.0.0.1",
      "localPort": 7777,
      "remotePort": 30002,
      "enabled": true,
      "autoStart": true
    }
  ]
}
```

---

# 9. Dashboard

Dashboard chỉ bind:

```text
127.0.0.1:8787
```

Không public trực tiếp Internet.

UI mong muốn:

```text
+------------------------------------------------+
|             MINI TUNNEL MANAGER                |
+------------------------------------------------+
| Status: ● Connected                            |
+------------------------------------------------+
| Name       Local             Type      Status   |
|------------------------------------------------|
| CRM        127.0.0.1:8001    HTTP      ONLINE   |
| Minecraft  127.0.0.1:25565   TCP       ONLINE   |
| Game UDP   127.0.0.1:7777    UDP       ONLINE   |
+------------------------------------------------+
| [+ Add Tunnel]                                  |
+------------------------------------------------+
```

Chức năng:

- Add tunnel
- Edit tunnel
- Delete tunnel
- Start
- Stop
- Restart
- Enable/disable
- View logs
- View statistics

Statistics:

- Uptime
- RX bytes
- TX bytes
- Active connections
- Request count
- Last error
- Connection state

---

# 10. Auto reconnect

Local Client phải tự reconnect khi:

- Internet mất
- VPS restart
- Relay process restart
- Worker restart
- Connection timeout

Backoff:

```text
1s
2s
5s
10s
30s
30s
30s
...
```

Sau khi reconnect:

```text
CONNECT
   |
AUTH
   |
RESTORE TUNNELS
   |
HEARTBEAT
   |
ONLINE
```

Tunnel configuration phải được lưu local để client có thể tự khôi phục.

---

# 11. Authentication

Không được cho phép bất kỳ client nào tự ý kết nối Relay.

Tối thiểu:

```text
CLIENT_TOKEN
```

Flow:

```text
Client
  |
  | AUTH(token, client_id)
  v
Relay
  |
  | validate
  v
AUTH_OK
```

Không hard-code secret trong source code.

Nên lưu token trong:

```text
.env
```

hoặc config ngoài source.

Dashboard không được expose token.

---

# 12. Security

MVP phải có:

- Token authentication
- Dashboard bind localhost
- Không log token
- Validate tunnel ownership
- Validate remote port
- Rate limit/control message nếu cần
- Timeout connection
- Cleanup dead sessions
- Không cho client truy cập tùy ý vào filesystem
- Không execute command từ tunnel protocol

Nếu public dashboard sau này thì cần thêm:

- HTTPS
- Login
- Session/JWT
- CSRF protection
- Rate limiting

---

# 13. Công nghệ đề xuất

## Local Client

Node.js.

Lý do:

- Dễ phát triển
- TCP/UDP native
- WebSocket dễ triển khai
- Có thể build thành executable sau này
- Dashboard local có thể dùng cùng process

Có thể dùng:

- `net`
- `dgram`
- `http`
- `https`
- WebSocket library hoặc WebSocket native tùy Node version

---

## Relay Server

Node.js cho MVP.

Có thể chạy:

```text
relay-server
```

trên Ubuntu VPS.

Sau khi ổn định có thể rewrite phần data plane bằng Go/Rust nếu cần performance cao.

---

## Worker

JavaScript/TypeScript.

Dùng cho:

- HTTP public endpoint
- WebSocket endpoint
- Authentication
- Routing request tới local client

---

# 14. Project structure

Đề xuất:

```text
mini-tunnel/
│
├── client/
│   ├── src/
│   │   ├── index.js
│   │   ├── connection.js
│   │   ├── tunnel-manager.js
│   │   ├── tcp-tunnel.js
│   │   ├── udp-tunnel.js
│   │   ├── http-tunnel.js
│   │   ├── protocol.js
│   │   ├── config.js
│   │   └── logger.js
│   └── package.json
│
├── relay/
│   ├── src/
│   │   ├── index.js
│   │   ├── server.js
│   │   ├── client-manager.js
│   │   ├── tcp-relay.js
│   │   ├── udp-relay.js
│   │   ├── protocol.js
│   │   └── logger.js
│   └── package.json
│
├── worker/
│   ├── src/
│   │   └── worker.js
│   └── wrangler.toml
│
├── dashboard/
│   ├── index.html
│   ├── app.js
│   └── style.css
│
├── config/
│   └── config.example.json
│
└── README.md
```

---

# 15. MVP implementation order

Không làm tất cả cùng lúc.

## Phase 1 — TCP

Ưu tiên cao nhất.

Làm:

```text
Relay VPS
    ↕
Local Client
    ↕
localhost TCP service
```

Test bằng:

```text
nc
```

hoặc một TCP echo server.

Mục tiêu:

```text
Internet -> VPS:30001 -> Local PC:25565
```

hoạt động ổn định.

---

## Phase 2 — HTTP

Implement Worker + Local Client.

Test:

```text
https://abc.workers.dev
        ↓
localhost:8001
```

Support:

- GET
- POST
- PUT
- PATCH
- DELETE
- OPTIONS
- HEAD
- Query string
- Headers
- Cookies
- Body
- Status code

---

## Phase 3 — UDP

Implement:

```text
Internet
   ↓
Relay UDP port
   ↓
UDP tunnel
   ↓
Local UDP server
```

Phải xử lý session mapping và timeout.

---

## Phase 4 — Dashboard

Sau khi protocol hoạt động ổn định:

- CRUD
- Start/Stop
- Status
- Logs
- Statistics

---

## Phase 5 — Production hardening

Thêm:

- TLS
- Better authentication
- Rate limiting
- Metrics
- Persistent storage
- Client executable
- Windows startup
- Windows service
- Docker deployment
- Monitoring

---

# 16. Windows client

Client phải chạy tốt trên Windows.

Có thể chạy:

```bash
node client/src/index.js
```

Sau khi ổn định build thành:

```text
mini-tunnel-client.exe
```

Có thể dùng:

- Windows Task Scheduler
- NSSM
- Windows Service

để tự chạy khi Windows khởi động.

---

# 17. VPS deployment

Relay Server có thể chạy Docker:

```text
docker-compose.yml
```

Ví dụ:

```text
Internet
   |
   +-- TCP :30001
   +-- TCP :30002
   +-- UDP :30003
   +-- UDP :30004
   |
   v
Docker Relay
```

Firewall VPS phải mở các remote port cần thiết.

---

# 18. Domain

HTTP:

```text
https://abc.workers.dev
```

hoặc custom domain:

```text
https://tunnel.example.com
```

TCP:

```text
VPS_IP:30001
```

UDP:

```text
VPS_IP:30002
```

Sau này có thể hỗ trợ domain/subdomain cho TCP nếu có DNS/port mapping phù hợp, nhưng MVP không cần.

---

# 19. Không nên làm ở MVP

Không cần ngay:

- Kubernetes
- Microservices
- Redis
- PostgreSQL
- Message queue
- Complex authentication
- Multi-region relay
- Load balancing
- Billing
- User management

Mục tiêu đầu tiên:

> Một PC sau CGNAT có thể chạy một game server local và người ngoài Internet kết nối được thông qua một VPS Relay.

---

# 20. Acceptance criteria

MVP được xem là thành công khi:

### TCP

```text
PC nhà
  └── Game Server :25565

VPS
  └── Public :30001

Player
  └── VPS:30001
       ↓
     Game
```

Player có thể kết nối thành công.

### UDP

```text
PC nhà
  └── Game Server :7777/UDP

VPS
  └── Public :30002/UDP

Player
  └── VPS:30002
```

UDP packet đi hai chiều thành công.

### Reconnect

Rút mạng PC:

```text
OFFLINE
```

Cắm mạng lại:

```text
CONNECTING
   ↓
ONLINE
```

Không cần thao tác thủ công.

### Multiple tunnels

Một client có thể đồng thời chạy:

```text
HTTP :8001
TCP  :25565
UDP  :7777
```

### Dashboard

Dashboard hiển thị:

```text
HTTP   ONLINE
TCP    ONLINE
UDP    ONLINE
```

và cho phép Start/Stop.

---

# 21. Nguyên tắc quan trọng

1. Local PC không cần public IP.
2. Local PC không cần port forwarding.
3. Local Client luôn chủ động kết nối outbound.
4. Relay VPS phải có public IP.
5. Worker chỉ xử lý HTTP/WebSocket.
6. TCP/UDP phải đi qua Relay VPS.
7. Dashboard chỉ quản lý client/tunnel, không trực tiếp xử lý game traffic.
8. Protocol phải có authentication và connection/session ID.
9. MVP ưu tiên TCP trước, sau đó HTTP, cuối cùng UDP.
10. Không xây quá phức tạp trước khi tunnel cơ bản chạy end-to-end.

---

# 22. Mục tiêu cuối cùng

Sản phẩm cuối cùng có trải nghiệm:

```text
Install Client
      ↓
Login / nhập token
      ↓
Client tự connect Relay
      ↓
Mở Dashboard
      ↓
Add Tunnel
      ↓
Chọn:

HTTP
TCP
UDP

      ↓
Nhập local host/port
      ↓
Save + Start
      ↓
ONLINE
```

Người dùng không cần hiểu CGNAT, NAT, port forwarding hay tunnel protocol.

Trải nghiệm mong muốn:

> "Game đang chạy ở localhost:25565 → bấm Add Tunnel → nhận địa chỉ public → gửi địa chỉ đó cho bạn bè."

Đây là mục tiêu UX chính của hệ thống.
