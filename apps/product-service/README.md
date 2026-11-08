# Product Service

Owner: **Tuấn**. Cổng mặc định **3002**. Database **product_db**, role **product_app**. Models: **Category, Product, ProductImage**. Chỉ service này được truy cập database/Prisma Client tương ứng.

## Nhận việc và chạy

Đọc [README root](../../README.md), [hướng dẫn bàn giao](../../docs/platform-handover.md) và [AGENTS.md](../../AGENTS.md). Setup chung tạo credential, khóa, kết nối và migration. Không cần tự khai báo KrakenD, queue hoặc Redis adapter.

```bash
# Tại root repo, sau quickstart
 docker compose logs -f product-service
 npm run db:generate -- product-service
 npm run db:migrate:dev -- product-service descriptive_change
 npm run db:migrate:deploy -- product-service
 npm run start:product
```

Script start riêng chạy trên host; phải dừng container cùng service trước để tránh trùng cổng. Khi muốn full host mode, dùng infra:up và start:all theo README root. Schema đổi cần generate client và rebuild Docker image của service.

## Hợp đồng HTTP

Nguồn chính: [OpenAPI](../../contracts/openapi/product.json). Dev cung cấp `GET /openapi.json`. Internal routes không được publish qua gateway. `x-backend-path` trong OpenAPI là URL trực tiếp của service; public path trong bảng là URL gateway.

| Method/path                                       | operationId đăng ký handler                             | Auth/role     | Trạng thái  |
| ------------------------------------------------- | ------------------------------------------------------- | ------------- | ----------- |
| `GET /api/product/health`                         | `product_get__api_product_health`                       | public        | completed   |
| `GET /internal/product/dependencies`              | `product_get__internal_product_dependencies`            | internal      | completed   |
| `GET /api/categories`                             | `product_get__api_categories`                           | public        | implemented |
| `POST /api/categories`                            | `product_post__api_categories`                          | bearer ADMIN  | implemented |
| `PATCH /api/categories/{id}`                      | `product_patch__api_categories_id`                      | bearer ADMIN  | implemented |
| `DELETE /api/categories/{id}`                     | `product_delete__api_categories_id`                     | bearer ADMIN  | implemented |
| `GET /api/products`                               | `product_get__api_products`                             | public        | implemented |
| `POST /api/products`                              | `product_post__api_products`                            | bearer SELLER | implemented |
| `GET /api/products/{id}`                          | `product_get__api_products_id`                          | public        | implemented |
| `PATCH /api/products/{id}`                        | `product_patch__api_products_id`                        | bearer SELLER | implemented |
| `DELETE /api/products/{id}`                       | `product_delete__api_products_id`                       | bearer SELLER | implemented |
| `PUT /internal/products/{id}/auction-reservation` | `product_put__internal_products_id_auction-reservation` | internal      | implemented |

Completed/implemented là code thật. Planned trả 501 khi chưa đăng ký handler. Demo internal chỉ bật dev/test và ghi PlatformProbe, chưa thay đổi bảng nghiệp vụ. Ownership phải kiểm tra trong handler, không chỉ dựa role.

## Điểm viết nghiệp vụ

`src/service-handlers.ts` đã được đưa vào module. Đăng ký `HttpHandlers.register(operationId, handler)` và `EventHandlers.register(eventName, handler)` ở đây, rồi delegate tới application service/repository của bạn. HTTP validation, token và role đã chạy trước handler.

Ví dụ pattern (copy operationId đúng từ bảng trên):

```ts
this.http.register('<operationId>', async (request) => {
  // request.principal.sub là user đã xác thực trên protected endpoint.
  // Gọi application service và trả response đúng OpenAPI.
  return this.application.execute(request);
});
```

Không tạo controller trùng route dispatcher. Có thể tự tổ chức domain/application/repository nội bộ. Consumer phải dùng transaction được truyền vào, không mở transaction riêng để ghi nghiệp vụ.

Category CRUD nằm trong `src/category`: danh sách công khai, phân trang ổn định theo tên và ID; `search` coi `%` và `_` là ký tự thường. Các thao tác ghi yêu cầu ADMIN; tên được trim, tên trùng trả 409, PATCH rỗng trả 400 và category còn product không thể bị xóa.

## Product CRUD

- `sellerId` luôn lấy từ `request.principal.sub`; body không thể chọn chủ sở hữu. PATCH/DELETE kiểm tra ownership, người khác nhận `403`.
- Chỉ product `DRAFT` và `READY` được PATCH/DELETE; `RESERVED`, `IN_AUCTION` và `SOLD` nhận `409`. PATCH chỉ chuyển `DRAFT` ↔ `READY`; trạng thái reservation chỉ do luồng reservation/event thay đổi.
- Tạo product mặc định `DRAFT`/`NEW`; POST chỉ chấp nhận `DRAFT`. Chuyển sang `READY` cần ít nhất một ảnh và đúng một ảnh primary. Nhiều hơn một ảnh primary luôn nhận `400`.
- PATCH `images` thay thế toàn bộ danh sách ảnh trong transaction; không gửi `images` thì giữ nguyên. Product cùng ảnh được tạo atomically.
- List hỗ trợ `categoryId`, `status`, `search` (không phân biệt hoa thường trên title/description), `page` và `pageSize`; list luôn ẩn `DRAFT`, kể cả khi `status=DRAFT`. Detail trả mọi trạng thái.
- Response có `category` và `images`; tuyệt đối không trả `reservedAuctionId`, `reservationSnapshot` hoặc `lastAuctionVersion`.

Ví dụ tạo product:

```json
{
  "categoryId": "8a59a4c0-f6f6-4f90-b008-3ed280c918ee",
  "title": "Máy ảnh film",
  "description": "Tình trạng tốt",
  "images": [
    { "url": "https://cdn.example.test/camera.jpg", "isPrimary": true }
  ]
}
```

Response Product gồm `id`, `sellerId`, `categoryId`, `category`, `title`, `description`, `status`, `condition` và `images`; category có `id`, `name`, `description`. Các trường reservation/version nội bộ không nằm trong DTO.

```json
{
  "id": "26822af0-1897-4aeb-ae07-4d38ad2c19bf",
  "sellerId": "c1fd37ca-8881-47d1-8667-17ad81ea73b3",
  "categoryId": "8a59a4c0-f6f6-4f90-b008-3ed280c918ee",
  "category": {
    "id": "8a59a4c0-f6f6-4f90-b008-3ed280c918ee",
    "name": "Máy ảnh",
    "description": null
  },
  "title": "Máy ảnh film",
  "description": "Tình trạng tốt",
  "status": "DRAFT",
  "condition": "NEW",
  "images": [
    { "url": "https://cdn.example.test/camera.jpg", "isPrimary": true }
  ]
}
```

## Auction Reservation (Internal)

- Route nội bộ `PUT /internal/products/{id}/auction-reservation`, bảo vệ bằng `INTERNAL_AUCTION_KEY` (dispatcher tự kiểm tra qua header `x-service-key`). Tuyệt đối không publish qua KrakenD Gateway.
- Request body: `{ "auctionId": "...", "sellerId": "..." }`.
- Cập nhật nguyên tử: Sử dụng khóa dòng `SELECT ... FOR UPDATE` trong transaction để chống race condition. Khi product ở trạng thái `READY`, cập nhật nguyên tử:
  - `status = RESERVED`
  - `reservedAuctionId = auctionId`
  - `reservationSnapshot = { productTitle, productThumbnail }` (thumbnail lấy từ ảnh primary hoặc null nếu không có)
  - `lastAuctionVersion = 0`
- Quy tắc kiểm tra:
  - Product không tồn tại → `404 Not Found`.
  - `sellerId` không khớp `product.sellerId` → `403 Forbidden`.
  - Product chưa `READY` và `reservedAuctionId` khác `auctionId` (ví dụ: đang `DRAFT`, `IN_AUCTION`, `SOLD`, hoặc bị giữ bởi auction khác) → `409 Conflict`.
  - Idempotent: Gọi lại cùng `auctionId` (với sellerId hợp lệ) → `200 OK` trả snapshot cũ từ `reservationSnapshot` mà không thay đổi dữ liệu database.
- Response đúng schema `Reservation`:
  ```json
  {
    "auctionId": "11111111-1111-4111-8111-111111111111",
    "productId": "22222222-2222-4222-8222-222222222222",
    "sellerId": "33333333-3333-4333-8333-333333333333",
    "productTitle": "Máy ảnh film",
    "productThumbnail": "https://cdn.example.test/camera.jpg"
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

Service nhận `PRODUCT_DATABASE_URL`, `PRODUCT_PORT`, JWT public key/issuer/audience, RABBITMQ_URL, REDIS_URL, CORS_ORIGINS và PLATFORM_ADMIN_KEY. Auth nhận thêm private key/refresh secret. Auction/Product nhận INTERNAL_AUCTION_KEY; Payment/Order nhận INTERNAL_PAYMENT_KEY. Compose chỉ cấp credential cần thiết.

Host entrypoint dùng role riêng từ `PRODUCT_DB_USER/PASSWORD`; không copy secret vào code. Demo chỉ bật khi PLATFORM_DEMO_ENABLED=true và NODE_ENV khác production.

## Database và migration

[Schema hiện tại](prisma/schema.prisma) và [thiết kế dữ liệu](../../docs/data-model.md). Chỉ thêm migration mới của service mình; không sửa migration đã apply, không dùng db push. Cần giữ các partial unique/check constraint ghi trong SQL. FK xuyên service bị cấm; logical reference chỉ là ID.

## Checklist nghiệp vụ cần làm

- [x] Viết Category CRUD với phân trang/tìm kiếm và chỉ ADMIN được ghi.
- [x] Viết Product CRUD, ownership, trạng thái và quy tắc ảnh.
- [x] Reservation phải cập nhật nguyên tử và idempotent theo auctionId; reset lastAuctionVersion khi giữ sản phẩm cho phiên mới.
- [ ] Consumer lifecycle kiểm tra reservedAuctionId/version, tránh event cũ tác động phiên mới.
- [ ] Test request hợp lệ/sai quyền/không tồn tại/conflict và response đúng contract.
- [ ] Test rollback, retry và event trùng nếu có consumer/producer.
- [ ] Cập nhật ví dụ request/event và README khi thêm tính năng.

## Kiểm thử và bàn giao

`npm exec vitest run apps/product-service` chạy unit tests Product; `npm test` chạy unit/contract tests chung. Dùng thêm `npm run typecheck`, `npm run lint` và `npm run platform:smoke` để kiểm tra nền tảng. Product contract được cập nhật bằng OpenAPI nguồn, rồi generate/check như hướng dẫn ở README root.

Không cần service khác hoàn thiện nghiệp vụ để bắt đầu: dùng fixture và internal demo adapter. Các route HTTP còn `planned` trả 501 khi chưa đăng ký handler; đây không phải lỗi Docker. Dừng demo khi kiểm thử business flow thật để không nhầm fixture với dữ liệu thật.
