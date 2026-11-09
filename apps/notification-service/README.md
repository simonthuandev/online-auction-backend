# Notification Service

Owner: **Tuấn**. Cổng mặc định **3006**. Database **notification_db**, role **notification_app**. Models: **Notification**. Chỉ service này được truy cập database/Prisma Client tương ứng.

## Nhận việc và chạy

Đọc [README root](../../README.md), [hướng dẫn bàn giao](../../docs/platform-handover.md) và [AGENTS.md](../../AGENTS.md). Setup chung tạo credential, khóa, kết nối và migration. Không cần tự khai báo KrakenD, queue hoặc Redis adapter.

```bash
# Tại root repo, sau quickstart
 docker compose logs -f notification-service
 npm run db:generate -- notification-service
 npm run db:migrate:dev -- notification-service descriptive_change
 npm run db:migrate:deploy -- notification-service
 npm run start:notification
```

Script start riêng chạy trên host; phải dừng container cùng service trước để tránh trùng cổng. Khi muốn full host mode, dùng infra:up và start:all theo README root. Schema đổi cần generate client và rebuild Docker image của service.

## Hợp đồng HTTP

Nguồn chính: [OpenAPI](../../contracts/openapi/notification.json). Dev cung cấp `GET /openapi.json`. Internal routes không được publish qua gateway. `x-backend-path` trong OpenAPI là URL trực tiếp của service; public path trong bảng là URL gateway.

| Method/path | operationId đăng ký handler | Auth/role | Trạng thái |
|---|---|---|---|
| `GET /api/notification/health` | `notification_get__api_notification_health` | public  | completed |
| `GET /internal/notification/dependencies` | `notification_get__internal_notification_dependencies` | internal  | completed |
| `GET /api/notifications` | `notification_get__api_notifications` | bearer  | implemented |
| `PATCH /api/notifications/{id}/read` | `notification_patch__api_notifications_id_read` | bearer  | implemented |

Completed là code thật. Planned trả 501 khi chưa đăng ký handler. Demo internal chỉ bật dev/test và ghi PlatformProbe, chưa thay đổi bảng nghiệp vụ. Ownership phải kiểm tra trong handler, không chỉ dựa role.

## Điểm viết nghiệp vụ

`src/service-handlers.ts` đã được đưa vào module. Đăng ký `HttpHandlers.register(operationId, handler)` và `EventHandlers.register(eventName, handler)` ở đây, rồi delegate tới application service/repository của bạn. HTTP validation, token và role đã chạy trước handler.

Ví dụ pattern (copy operationId đúng từ bảng trên):

```ts
this.http.register('<operationId>', async request => {
  // request.principal.sub là user đã xác thực trên protected endpoint.
  // Gọi application service và trả response đúng OpenAPI.
  return this.application.execute(request);
});
```

Không tạo controller trùng route dispatcher. Có thể tự tổ chức domain/application/repository nội bộ. Consumer phải dùng transaction được truyền vào, không mở transaction riêng để ghi nghiệp vụ.

## Nghiệp vụ Notification

### 1. Danh sách thông báo (`notification_get__api_notifications`)
- **Endpoint**: `GET /api/notifications`
- **Xác thực**: Bearer token (JWT), người dùng lấy từ `request.principal.sub`. Tuyệt đối không nhận hoặc ghi đè `userId` từ query/body.
- **Sắp xếp**: `createdAt desc`, tie-breaker ổn định theo `id desc`.
- **Phân trang**: `page` (mặc định 1), `pageSize` (mặc định 20, tối đa 100). Trả về đúng schema `NotificationPage`.
- **Lọc theo trạng thái (`status`)**: Contract **đã có** tham số query `status`:
  - `status=UNREAD`: lọc các thông báo chưa đọc (`isRead = false`).
  - `status=READ`: lọc các thông báo đã đọc (`isRead = true`).
  - Giá trị `status` khác hai giá trị trên $\rightarrow$ trả về lỗi **`400 Bad Request`**.
- **Tìm kiếm (`search`)**: Hỗ trợ tìm kiếm không phân biệt hoa thường trong `title` hoặc `message`.
- **Mã lỗi**:
  - `400 Bad Request`: `page`, `pageSize`, hoặc `status` không hợp lệ.
  - `401 Unauthorized`: Chưa đăng nhập hoặc token không hợp lệ.

Ví dụ Response (`200 OK`):
```json
{
  "items": [
    {
      "id": "30000000-0000-4000-8000-000000000001",
      "userId": "10000000-0000-4000-8000-000000000003",
      "title": "Bạn đã bị vượt giá!",
      "message": "Có người vừa đặt giá cao hơn cho Máy ảnh film",
      "type": "OUTBID",
      "isRead": false,
      "metadata": {
        "auctionId": "20000000-0000-4000-8000-000000000001",
        "currentPrice": "150000"
      },
      "createdAt": "2026-11-09T10:00:00.000Z"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

### 2. Đánh dấu đã đọc (`notification_patch__api_notifications_id_read`)
- **Endpoint**: `PATCH /api/notifications/{id}/read`
- **Xác thực**: Bearer token (JWT), chỉ chủ sở hữu (`userId = request.principal.sub`) mới có thể đánh dấu đã đọc.
- **Thao tác nguyên tử**: Thực hiện cập nhật nguyên tử theo cả `id` và `userId` (`UPDATE "Notification" SET "isRead" = true WHERE "id" = $1 AND "userId" = $2`), không tách rời lệnh đọc và ghi.
- **Idempotent**: Gọi lại khi thông báo đã đọc vẫn trả về `200 OK` với trạng thái hiện tại của thông báo, không gây lỗi.
- **Bảo mật**: Thông báo không tồn tại **hoặc** thuộc về người dùng khác đều trả về **`404 Not Found`** (không dùng 403 để tránh lộ sự tồn tại của thông báo thuộc người khác).
- **Mã lỗi**:
  - `400 Bad Request`: `id` không phải định dạng UUID.
  - `401 Unauthorized`: Chưa đăng nhập hoặc token không hợp lệ.
  - `404 Not Found`: Thông báo không tồn tại hoặc không thuộc quyền sở hữu của người gọi.

Ví dụ Response (`200 OK`):
```json
{
  "id": "30000000-0000-4000-8000-000000000001",
  "userId": "10000000-0000-4000-8000-000000000003",
  "title": "Bạn đã bị vượt giá!",
  "message": "Có người vừa đặt giá cao hơn cho Máy ảnh film",
  "type": "OUTBID",
  "isRead": true,
  "metadata": {
    "auctionId": "20000000-0000-4000-8000-000000000001",
    "currentPrice": "150000"
  },
  "createdAt": "2026-11-09T10:00:00.000Z"
}
```

## Kết nối sẵn có

- PrismaService riêng trong `src/prisma`; schema/migration dưới `prisma/`.
- Platform DB token `PLATFORM_DB`: SQL parameterized và transaction adapter.
- Config, auth, lỗi chuẩn, request ID, health, Redis client và RabbitMQ connection đã tích hợp.
- [Event/Socket catalog](../../docs/events-and-sockets.md) là nguồn routing và room convention.
- Publisher dùng enqueueEvent trong transaction; consumer dùng EventHandlers và ProcessedEvent.
- Auction/Payment có outbox + idempotency table; Product/Order/Notification có inbox dedupe.
- Realtime facade chỉ có server hoạt động trong Auction/Notification; không tạo connection socket mới trong business code.

## Biến môi trường

Service nhận `NOTIFICATION_DATABASE_URL`, `NOTIFICATION_PORT`, JWT public key/issuer/audience, RABBITMQ_URL, REDIS_URL, CORS_ORIGINS và PLATFORM_ADMIN_KEY. Auth nhận thêm private key/refresh secret. Auction/Product nhận INTERNAL_AUCTION_KEY; Payment/Order nhận INTERNAL_PAYMENT_KEY. Compose chỉ cấp credential cần thiết.

Host entrypoint dùng role riêng từ `NOTIFICATION_DB_USER/PASSWORD`; không copy secret vào code. Demo chỉ bật khi PLATFORM_DEMO_ENABLED=true và NODE_ENV khác production.

## Database và migration

[Schema hiện tại](prisma/schema.prisma) và [thiết kế dữ liệu](../../docs/data-model.md). Chỉ thêm migration mới của service mình; không sửa migration đã apply, không dùng db push. Cần giữ các partial unique/check constraint ghi trong SQL. FK xuyên service bị cấm; logical reference chỉ là ID.

## Checklist nghiệp vụ cần làm

- [ ] Lưu notification chống trùng theo sourceEventId/userId/type.
- [x] Chỉ người nhận được đọc/đánh dấu đã đọc.
- [ ] Phát socket sau commit và dùng REST phục hồi.
- [ ] Test request hợp lệ/sai quyền/không tồn tại/conflict và response đúng contract.
- [ ] Test rollback, retry và event trùng nếu có consumer/producer.
- [ ] Cập nhật ví dụ request/event và README khi thêm tính năng.

## Kiểm thử và bàn giao

`npm test` chạy unit/contract tests chung; thêm test nghiệp vụ trong service rồi dùng `npm exec vitest run apps/notification-service`. `npm run typecheck`, `npm run lint` và `npm run platform:smoke` kiểm tra toàn nền tảng. Shared contract/common thay đổi phải chạy cả sáu build/typecheck.

Không cần service khác hoàn thiện nghiệp vụ để bắt đầu: dùng fixture và internal demo adapter. HTTP planned 501 là trạng thái chờ code, không phải lỗi Docker. Dừng demo khi kiểm thử business flow thật để không nhầm fixture với dữ liệu thật.
