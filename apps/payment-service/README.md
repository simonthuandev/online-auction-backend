# Payment Service

Owner: **a Thi**. Cổng mặc định **3005**. Database **payment_db**, role **payment_app**. Models: **Payment, PaymentAttempt**. Chỉ service này được truy cập database/Prisma Client tương ứng.

## Nhận việc và chạy

Đọc [README root](../../README.md), [hướng dẫn bàn giao](../../docs/platform-handover.md) và [AGENTS.md](../../AGENTS.md). Setup chung tạo credential, khóa, kết nối và migration. Không cần tự khai báo KrakenD, queue hoặc Redis adapter.

```bash
# Tại root repo, sau quickstart
 docker compose logs -f payment-service
 npm run db:generate -- payment-service
 npm run db:migrate:dev -- payment-service descriptive_change
 npm run db:migrate:deploy -- payment-service
 npm run start:payment
```

Script start riêng chạy trên host; phải dừng container cùng service trước để tránh trùng cổng. Khi muốn full host mode, dùng infra:up và start:all theo README root. Schema đổi cần generate client và rebuild Docker image của service.

## Hợp đồng HTTP

Nguồn chính: [OpenAPI](../../contracts/openapi/payment.json). Dev cung cấp `GET /openapi.json`. Internal routes không được publish qua gateway. `x-backend-path` trong OpenAPI là URL trực tiếp của service; public path trong bảng là URL gateway.

| Method/path | operationId đăng ký handler | Auth/role | Trạng thái |
|---|---|---|---|
| `GET /api/payment/health` | `payment_get__api_payment_health` | public  | completed |
| `GET /internal/payment/dependencies` | `payment_get__internal_payment_dependencies` | internal  | completed |
| `POST /api/payments` | `payment_post__api_payments` | bearer USER,SELLER | planned |
| `GET /api/payments/order/{orderId}` | `payment_get__api_payments_order_orderId` | bearer  | planned |
| `GET /api/payments/vnpay/ipn` | `payment_get__api_payments_vnpay_ipn` | public  | planned |
| `GET /api/payments/vnpay/return` | `payment_get__api_payments_vnpay_return` | public  | planned |

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

Service nhận `PAYMENT_DATABASE_URL`, `PAYMENT_PORT`, JWT public key/issuer/audience, RABBITMQ_URL, REDIS_URL, CORS_ORIGINS và PLATFORM_ADMIN_KEY. Auth nhận thêm private key/refresh secret. Auction/Product nhận INTERNAL_AUCTION_KEY; Payment/Order nhận INTERNAL_PAYMENT_KEY. Compose chỉ cấp credential cần thiết.

Host entrypoint dùng role riêng từ `PAYMENT_DB_USER/PASSWORD`; không copy secret vào code. Demo chỉ bật khi PLATFORM_DEMO_ENABLED=true và NODE_ENV khác production.

## Database và migration

[Schema hiện tại](prisma/schema.prisma) và [thiết kế dữ liệu](../../docs/data-model.md). Chỉ thêm migration mới của service mình; không sửa migration đã apply, không dùng db push. Cần giữ các partial unique/check constraint ghi trong SQL. FK xuyên service bị cấm; logical reference chỉ là ID.

## Phương thức thanh toán đã chốt

Chỉ có `COD` (tiền mặt khi nhận hàng) và `VNPAY`; đây là giá trị dùng thống nhất trong Prisma, REST và event contract. Nghiệp vụ vẫn chờ owner triển khai.

- COD: tạo payment/attempt đang chờ; không tự đánh dấu SUCCESS khi buyer chọn phương thức. Owner phải thiết kế luồng xác nhận thu tiền có xác thực/ownership phù hợp và bổ sung contract trước khi triển khai. Chỉ sau xác nhận hợp lệ mới ghi SUCCESS và enqueue `payment.succeeded` cùng local transaction; `transactionId` dùng mã biên nhận nội bộ.
- VNPay: xác minh checksum/ref/amount ở IPN trước khi ghi nhận thành công. Return URL chỉ phục vụ hiển thị; không tin trạng thái do client gửi.

Migration mới `20261026000000_payment_method_cod` đổi nhãn enum cũ `MOCK_GATEWAY` thành `COD`, giữ dữ liệu/ID/status/index và migration foundation. Các attempt demo cũ sẽ đọc ra COD; việc đổi tên không phải bằng chứng thu tiền thật. Áp dụng bằng `npm run db:migrate:deploy -- payment-service`, generate client rồi rebuild các service chịu ảnh hưởng.

Đây là điều chỉnh contract baseline trước bàn giao, không tương thích với payload cũ mang phương thức mock. Cập nhật client cùng Payment/Order/Notification. JSON trong outbox, broker queue/DLQ, probe hoặc biên nhận lịch sử không tự đổi theo enum: kiểm tra dữ liệu demo cũ trước khi replay; không đổi thanh toán giả thành chứng từ thu tiền thật. Không xóa volume để nâng cấp.

## Checklist nghiệp vụ cần làm

- [ ] Lấy amount/buyer từ Order, không tin amount client.
- [ ] Triển khai COD với xác nhận thu tiền có quyền phù hợp và provider VNPay với IPN xác minh checksum/ref/amount.
- [ ] Bảo vệ một pending attempt, success không bị kết quả đến muộn ghi đè.
- [ ] Test request hợp lệ/sai quyền/không tồn tại/conflict và response đúng contract.
- [ ] Test rollback, retry và event trùng nếu có consumer/producer.
- [ ] Cập nhật ví dụ request/event và README khi thêm tính năng.

## Kiểm thử và bàn giao

`npm test` chạy unit/contract tests chung; thêm test nghiệp vụ trong service rồi dùng `npm exec vitest run apps/payment-service`. `npm run typecheck`, `npm run lint` và `npm run platform:smoke` kiểm tra toàn nền tảng. Shared contract/common thay đổi phải chạy cả sáu build/typecheck.

Không cần service khác hoàn thiện nghiệp vụ để bắt đầu: dùng fixture và internal demo adapter. HTTP planned 501 là trạng thái chờ code, không phải lỗi Docker. Dừng demo khi kiểm thử business flow thật để không nhầm fixture với dữ liệu thật.
