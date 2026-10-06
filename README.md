# Mini Tunnel

Public ứng dụng đang chạy trên máy bạn (ví dụ `localhost:8001`) ra Internet qua Cloudflare Worker. Không cần VPS, không cần mở port, chạy được cả khi mạng nằm sau CGNAT, hoàn toàn miễn phí.

## Chức năng

- HTTP/HTTPS, WebSocket, SSE, upload/download file lớn
- Nhiều tunnel cùng lúc: địa chỉ chính `/`, đường dẫn riêng `/t/<mã>/` hoặc tên miền riêng
- Dashboard tại `http://127.0.0.1:8787`: thêm/sửa/xóa, bật/tắt tunnel, kiểm tra ứng dụng local có chạy không, thống kê, request gần đây, nhật ký
- Tự kết nối lại khi mất mạng, xác thực bằng token

## Yêu cầu

- Node.js 22+
- Tài khoản Cloudflare (gói Free là đủ)

## Cài đặt và chạy

**1. Setup** (chỉ chạy lần đầu):

```bash
npm run setup
```

Lệnh này đăng nhập Cloudflare, deploy Worker, tạo token và ghi cấu hình vào `data/config.json`.

**2. Start:**

```bash
npm start
```

Mở http://127.0.0.1:8787, bấm **Thêm tunnel**, nhập cổng của ứng dụng, rồi gửi link public cho người khác.

## Lưu ý

- **Đổi tên Worker (cũng là địa chỉ public):** chỉ sửa dòng `name` trong `worker/wrangler.toml`, sau đó chạy lại `npm run setup`.
- **Deploy lại sau khi sửa code Worker:** chạy `npm run deploy`. Đừng chạy `npx wrangler deploy` ở thư mục gốc.
