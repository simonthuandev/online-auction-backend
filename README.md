# Online Auction

NestJS monorepo với sáu service độc lập: Auth, Product, Auction, Order, Payment và Notification. Mỗi service sở hữu database/Prisma Client riêng; REST qua KrakenD, event qua RabbitMQ và realtime qua Socket.IO/Redis.

## Hướng dẫn chạy dự án lần đầu (sau clone)

### 1. Kiểm tra công cụ

```bash
node --version
npm --version
docker version
docker compose version
docker buildx version
```

Node phải là **24.x** trở lên (nên đúng bản **24.x**); Prisma baseline là **6.4.1**. Cần Docker Engine/Desktop chạy Linux containers, Compose v2 và Buildx. 

### 2. Cài và khởi động

```bash
npm ci
npm run setup:dev
npm run db:generate -- all
docker compose up -d --build
docker compose ps -a
npm run db:seed
npm run platform:check
npm run platform:smoke
```
**Không gửi `.env`, `.local/keys/`, token hoặc credential qua Git.** Mỗi máy tự setup. Private key chỉ Auth được mount; không sửa quyền thành đọc công khai để chữa lỗi.

### 3. Địa chỉ mặc định

| Thành phần | Địa chỉ/cổng |
| --- | --- |
| REST gateway | `http://localhost:8080` |
| Auth | `http://localhost:3001` |
| Product | `http://localhost:3002` |
| Auction | `http://localhost:3003` |
| Order | `http://localhost:3004` |
| Payment | `http://localhost:3005` |
| Notification | `http://localhost:3006` |
| Auction socket namespace | `http://localhost:3003/auctions` |
| Notification socket namespace | `http://localhost:3006/notifications` |
| RabbitMQ management | `http://localhost:15672` |
| PostgreSQL / Redis | `localhost:5432` / `localhost:6379` trong dev |

Thông số thực tế đọc trong `.env`. RabbitMQ dùng `RABBITMQ_USER/PASSWORD`; tài khoản seed dùng `SEED_PASSWORD`:

| Email | Vai trò |
| --- | --- |
| `admin@auction.test` | Admin |
| `seller@auction.test` | Seller |
| `bidder@auction.test` | Bidder |
| `bidder2@auction.test` | Bidder thứ hai |

Seed không ghi đè tài khoản đã tồn tại. Nếu đổi `SEED_PASSWORD` sau khi seed, mật khẩu tài khoản cũ không tự đổi theo.

## Làm việc hằng ngày

### Khởi động và xem logs

```bash
docker compose up -d
docker compose logs -f product-service # <tên service>
```

Sửa file TypeScript của service mình, quan sát watcher build lại rồi khởi động app. Sửa `libs/common` sẽ tác động các service phụ thuộc. Nếu Docker Desktop không nhận file events, thêm `WATCH_POLLING=true` vào `.env`, sau đó recreate service.

### Sửa đổi package*.json

Sau khi đổi dependencies/lockfile:

```bash
npm ci
docker compose up -d --build
```

### Sửa contract

Sau khi sửa contract: `npm run contracts:generate`, chạy contract checks:

```bash
npm run contracts:check
```

Tái tạo `gateway-config` và restart KrakenD.

```bash
docker compose run --rm --no-deps gateway-config
docker compose restart krakend
```

### Thêm / Sửa schema

Khi thêm/sửa schema, tạo migration bằng lệnh host rồi rebuild image tương ứng để cập nhật Prisma Client:

```bash
npm run db:migrate:dev -- product-service descriptive_change
npm run db:generate -- product-service
docker compose up -d --build product-migrate product-service
```

Dev bootstrap tạo thêm shadow database riêng cho mỗi service để Prisma migrate dev không cần quyền CREATEDB; production không tạo shadow database.

Không sửa migration đã apply. Không dùng `db push` để đồng bộ schema nhóm. Các partial index/check constraint nằm trong migration SQL; phải duy trì khi tạo migration mới.

### Dừng và giữ dữ liệu

```bash
docker compose down
```

Không dùng `down -v`, `prisma migrate reset` hoặc xóa volume để chữa lỗi. Dữ liệu và lịch sử migration cần được giữ.

## Bản đóng gói runtime (kiểm tra bản chạy thực tế, lead dùng)

```bash
docker compose -f docker-compose.yml up -d --build
```

File gốc không có watcher, source mount, cổng DB/Redis hoặc adapter demo. Auction/Notification có cổng cho socket; HTTP bảo vệ vẫn xác minh JWT khi truy cập trực tiếp. Bản runtime ở Phase 1 vẫn có nghiệp vụ trả 501. Đưa lên môi trường từ xa cần TLS cho REST/socket và origin phù hợp; Compose hiện tại là baseline đóng gói, không tự cấp certificate.

## Kiến trúc và phân công

```text
Client REST → KrakenD → Auth / Product / Auction / Order / Payment / Notification
                         ↓ mỗi service dùng database và role riêng

Auction ── internal REST ──→ Product
Payment ── internal REST ──→ Order
Auction / Payment ── outbox → RabbitMQ → các consumer tương ứng

Client Socket.IO → Auction / Notification ↔ Redis adapter
```

| Người phụ trách | Service | Phạm vi nghiệp vụ tiếp theo |
| --- | --- | --- |
| Thành viên 1 | Auth, Auction | Tài khoản/quyền; tạo phiên, bid, đóng phiên, phát event |
| Thành viên 2 | Product, Notification | Catalog/reservation; lưu và phát thông báo |
| Thành viên 3 | Payment, Order | Thanh toán/callback; tạo và quản lý đơn từ event |

Mỗi service sở hữu DB, generated Prisma Client và business behavior của mình. Dùng chung PostgreSQL server và monorepo vẫn phù hợp với kiến trúc này, vì quyền truy cập và ranh giới dữ liệu được tách. Không import code của app khác, query DB app khác, tạo foreign key hoặc SQL join xuyên service. Khi cần dữ liệu ngoài service, dùng REST contract hoặc event.

Socket server nằm trong Auction và Notification, **không có container socket riêng**. REST đi qua gateway; socket kết nối trực tiếp đến cổng service trong baseline hiện tại.

## Những file cần biết

| File/thư mục | Dùng khi nào |
| --- | --- |
| `README.md` | Quickstart và lệnh vận hành chuẩn |
| `AGENTS.md` | Quy tắc làm việc cho người và AI agent |
| `apps/<name>-service/README.md` | Trách nhiệm, operationId, hợp đồng và điểm nối của service |
| `apps/<name>-service/src/service-handlers.ts` | Đăng ký HTTP/event business handlers |
| `apps/<name>-service/prisma/` | Schema và lịch sử migrations của owner |
| `contracts/openapi/` | Nguồn chính của REST contract |
| `contracts/events/` | Nguồn chính của integration event |
| `contracts/socket.json` | Contract Socket.IO |
| `libs/common/` | Hạ tầng dùng chung; không đặt domain riêng tại đây |
| `Dockerfile` | Các stage dependency/dev/build/migration/runtime |
| `docker-compose.yml` | Toàn bộ stack runtime |
| `docker-compose.override.yml` | Tự merge khi dev: watcher, source mount, cổng hạ tầng và demo |
| `scripts/platform/` | Setup, migration, generator, smoke và kiểm thử nâng cao |
| `.github/workflows/platform.yml` | Checks và integration CI |
| `.local/` | Key và báo cáo local; không gửi lên Git |

## Hợp đồng và chia việc

- [Hướng dẫn nhận việc](docs/platform-handover.md)
- [Thiết kế dữ liệu](docs/data-model.md)
- [Sự kiện và Socket.IO](docs/events-and-sockets.md)
- [Auth](apps/auth-service/README.md), [Product](apps/product-service/README.md), [Auction](apps/auction-service/README.md), [Order](apps/order-service/README.md), [Payment](apps/payment-service/README.md), [Notification](apps/notification-service/README.md)

OpenAPI JSON trong `contracts/openapi/` là nguồn route/request/response. JSON Schema trong `contracts/events/` là nguồn event. `npm run contracts:generate` sinh TypeScript và KrakenD; không sửa generated artifact bằng tay. CI kiểm tra drift và import boundary. Dev/test service cung cấp `/openapi.json` để import vào công cụ API.

## Chẩn đoán

- `501`: đã tới đúng handler placeholder; xem README service để viết nghiệp vụ.
- `401/403`: gateway có thể trả body rỗng; client dùng HTTP status. Lỗi từ backend có Error envelope. Kiểm tra access token, role hoặc internal key; giả `x-user-id` không có tác dụng.
- `503 readiness`: database/migration chưa sẵn sàng; xem log service và `*-migrate`.
- Broker ngừng: HTTP vẫn nhận thao tác outbox; dependency health báo degraded, relay tiếp tục sau reconnect.
- Redis ngừng: realtime nhiều replica có thể thiếu cập nhật; client phải fetch lại REST sau reconnect.
- Lỗi quyền private key: kiểm tra `LOCAL_GID`, group của file và mode 640; không đổi khóa thành world-readable.
- Lỗi thiếu Buildx: cài Docker Buildx chính thức trước khi build; cache mounts yêu cầu BuildKit.
- Cổng đang dùng: dừng đúng chế độ cũ hoặc đổi cổng trong `.env`; không reset volume để sửa xung đột cổng.

```bash
npm run rmq:inspect
npm run rmq:replay -- queue.order.events 1
```

Replay DLQ chỉ sau khi kiểm tra payload và sửa nguyên nhân. Message sai schema sẽ quay lại DLQ. Báo cáo smoke tại `.local/smoke-report.json`.
