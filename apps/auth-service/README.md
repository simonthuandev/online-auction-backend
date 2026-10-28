# Auth Service

Owner: **Thuận**. Cổng mặc định **3001**. Database **auth_db**, role **auth_app**. Models: **User, RefreshToken**. Chỉ service này được truy cập database/Prisma Client tương ứng.

## Nhận việc và chạy

Đọc [README root](../../README.md), [hướng dẫn bàn giao](../../docs/platform-handover.md) và [AGENTS.md](../../AGENTS.md). Setup chung tạo credential, khóa, kết nối và migration. Không cần tự khai báo KrakenD, queue hoặc Redis adapter.

```bash
# Tại root repo, sau quickstart
 docker compose logs -f auth-service
 npm run db:generate -- auth-service
 npm run db:migrate:dev -- auth-service descriptive_change
 npm run db:migrate:deploy -- auth-service
 npm run start:auth
```

Script start riêng chạy trên host; phải dừng container cùng service trước để tránh trùng cổng. Khi muốn full host mode, dùng infra:up và start:all theo README root. Schema đổi cần generate client và rebuild Docker image của service.

## Hợp đồng HTTP

Nguồn chính: [OpenAPI](../../contracts/openapi/auth.json). Dev cung cấp `GET /openapi.json`. Internal routes không được publish qua gateway. `x-backend-path` trong OpenAPI là URL trực tiếp của service; public path trong bảng là URL gateway.

| Method/path | operationId đăng ký handler | Auth/role | Trạng thái |
|---|---|---|---|
| `GET /api/auth/health` | `auth_get__api_auth_health` | public  | completed |
| `GET /internal/auth/dependencies` | `auth_get__internal_auth_dependencies` | internal  | completed |
| `POST /api/auth/register` | `auth_post__api_auth_register` | public  | completed |
| `POST /api/auth/login` | `auth_post__api_auth_login` | public  | completed |
| `POST /api/auth/refresh` | `auth_post__api_auth_refresh` | public  | completed |
| `POST /api/auth/logout` | `auth_post__api_auth_logout` | public  | completed |
| `GET /api/auth/me` | `auth_get__api_auth_me` | bearer  | planned |
| `PATCH /api/auth/me` | `auth_patch__api_auth_me` | bearer  | planned |
| `PATCH /api/admin/users/{id}/role` | `auth_patch__api_admin_users_id_role` | bearer ADMIN | planned |

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

## Kết nối sẵn có

- PrismaService riêng trong `src/prisma`; schema/migration dưới `prisma/`.
- Platform DB token `PLATFORM_DB`: SQL parameterized và transaction adapter.
- Config, auth, lỗi chuẩn, request ID, health, Redis client và RabbitMQ connection đã tích hợp.
- [Event/Socket catalog](../../docs/events-and-sockets.md) là nguồn routing và room convention.
- Publisher dùng enqueueEvent trong transaction; consumer dùng EventHandlers và ProcessedEvent.
- Auction/Payment có outbox + idempotency table; Product/Order/Notification có inbox dedupe.
- Realtime facade chỉ có server hoạt động trong Auction/Notification; không tạo connection socket mới trong business code.

## Biến môi trường

Service nhận `AUTH_DATABASE_URL`, `AUTH_PORT`, JWT public key/issuer/audience, RABBITMQ_URL, REDIS_URL, CORS_ORIGINS và PLATFORM_ADMIN_KEY. Auth nhận thêm private key/refresh secret. Auction/Product nhận INTERNAL_AUCTION_KEY; Payment/Order nhận INTERNAL_PAYMENT_KEY. Compose chỉ cấp credential cần thiết.

Host entrypoint dùng role riêng từ `AUTH_DB_USER/PASSWORD`; không copy secret vào code. Demo chỉ bật khi PLATFORM_DEMO_ENABLED=true và NODE_ENV khác production.

## Database và migration

[Schema hiện tại](prisma/schema.prisma) và [thiết kế dữ liệu](../../docs/data-model.md). Chỉ thêm migration mới của service mình; không sửa migration đã apply, không dùng db push. Cần giữ các partial unique/check constraint ghi trong SQL. FK xuyên service bị cấm; logical reference chỉ là ID.

## Checklist nghiệp vụ cần làm

- [ ] Hoàn thiện profile và quản trị role.
- [ ] Giữ rotation/reuse detection; không lưu refresh token thô.
- [ ] Test request hợp lệ/sai quyền/không tồn tại/conflict và response đúng contract.
- [ ] Test rollback, retry và event trùng nếu có consumer/producer.
- [ ] Cập nhật ví dụ request/event và README khi thêm tính năng.

## Kiểm thử và bàn giao

`npm test` chạy unit/contract tests chung; thêm test nghiệp vụ trong service rồi dùng `npm exec vitest run apps/auth-service`. `npm run typecheck`, `npm run lint` và `npm run platform:smoke` kiểm tra toàn nền tảng. Shared contract/common thay đổi phải chạy cả sáu build/typecheck.

Không cần service khác hoàn thiện nghiệp vụ để bắt đầu: dùng fixture và internal demo adapter. HTTP planned 501 là trạng thái chờ code, không phải lỗi Docker. Dừng demo khi kiểm thử business flow thật để không nhầm fixture với dữ liệu thật.
