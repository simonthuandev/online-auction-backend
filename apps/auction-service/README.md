# Auction Service

Owner: **Thuận**. Cổng mặc định **3003**. Database **auction_db**, role **auction_app**. Models: **Auction, Bid**. Chỉ service này được truy cập database/Prisma Client tương ứng.

## Nhận việc và chạy

Đọc [README root](../../README.md), [hướng dẫn bàn giao](../../docs/platform-handover.md) và [AGENTS.md](../../AGENTS.md). Setup chung tạo credential, khóa, kết nối và migration. Không cần tự khai báo KrakenD, queue hoặc Redis adapter.

```bash
# Tại root repo, sau quickstart
 docker compose logs -f auction-service
 npm run db:generate -- auction-service
 npm run db:migrate:dev -- auction-service descriptive_change
 npm run db:migrate:deploy -- auction-service
 npm run start:auction
```

Script start riêng chạy trên host; phải dừng container cùng service trước để tránh trùng cổng. Khi muốn full host mode, dùng infra:up và start:all theo README root. Schema đổi cần generate client và rebuild Docker image của service.

## Hợp đồng HTTP

Nguồn chính: [OpenAPI](../../contracts/openapi/auction.json). Dev cung cấp `GET /openapi.json`. Internal routes không được publish qua gateway. `x-backend-path` trong OpenAPI là URL trực tiếp của service; public path trong bảng là URL gateway.

| Method/path | operationId đăng ký handler | Auth/role | Trạng thái |
|---|---|---|---|
| `GET /api/auction/health` | `auction_get__api_auction_health` | public  | completed |
| `GET /internal/auction/dependencies` | `auction_get__internal_auction_dependencies` | internal  | completed |
| `GET /api/auctions` | `auction_get__api_auctions` | public  | implemented |
| `POST /api/auctions` | `auction_post__api_auctions` | bearer SELLER | implemented |
| `GET /api/auctions/{id}` | `auction_get__api_auctions_id` | public  | implemented |
| `GET /api/auctions/{id}/bids` | `auction_get__api_auctions_id_bids` | public  | implemented |
| `POST /api/auctions/{id}/bids` | `auction_post__api_auctions_id_bids` | bearer USER,SELLER | implemented |

Completed là code thật. Implemented là handler nghiệp vụ đăng ký qua `src/service-handlers.ts`. Planned trả 501 khi chưa đăng ký handler. Demo internal chỉ bật dev/test và ghi PlatformProbe, chưa thay đổi bảng nghiệp vụ. Ownership phải kiểm tra trong handler, không chỉ dựa role.

### Ví dụ API Đọc Auction (`[AUC-01]`)

#### 1. Danh sách Auction công khai (`GET /api/auctions`)
Route public không yêu cầu token. Hỗ trợ phân trang (`page`, `pageSize`), lọc `status` (`PENDING`, `ACTIVE`, `ENDED`), tìm kiếm `search` theo `productTitle`. Mặc định ẩn các trạng thái nội bộ `INITIALIZING` và `CANCELLED`.

```http
GET /api/auctions?page=1&pageSize=20&status=ACTIVE&search=Vintage HTTP/1.1
Host: localhost:8080
```

Response 200:
```json
{
  "items": [
    {
      "id": "20000000-0000-4000-8000-000000000001",
      "productId": "30000000-0000-4000-8000-000000000001",
      "sellerId": "10000000-0000-4000-8000-000000000002",
      "productTitle": "Vintage Mechanical Watch",
      "productThumbnail": "https://example.com/watch.jpg",
      "startingPrice": "100000",
      "currentPrice": "150000",
      "bidIncrement": "10000",
      "currency": "VND",
      "startTime": "2026-11-10T10:00:00.000Z",
      "endTime": "2026-11-12T10:00:00.000Z",
      "status": "ACTIVE",
      "version": 3,
      "winnerId": null,
      "finalPrice": null
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

#### 2. Chi tiết Auction (`GET /api/auctions/{id}`)
Route public không yêu cầu token. Trả về thông tin phiên đấu giá ở mọi trạng thái (kể cả `INITIALIZING` và `CANCELLED` để người bán theo dõi quá trình tạo). Trả về 404 nếu không tìm thấy auction.

```http
GET /api/auctions/20000000-0000-4000-8000-000000000001 HTTP/1.1
Host: localhost:8080
```

Response 200:
```json
{
  "id": "20000000-0000-4000-8000-000000000001",
  "productId": "30000000-0000-4000-8000-000000000001",
  "sellerId": "10000000-0000-4000-8000-000000000002",
  "productTitle": "Vintage Mechanical Watch",
  "productThumbnail": "https://example.com/watch.jpg",
  "startingPrice": "100000",
  "currentPrice": "150000",
  "bidIncrement": "10000",
  "currency": "VND",
  "startTime": "2026-11-10T10:00:00.000Z",
  "endTime": "2026-11-12T10:00:00.000Z",
  "status": "ACTIVE",
  "version": 3,
  "winnerId": null,
  "finalPrice": null
}
```

#### 3. Danh sách lượt đặt giá (`GET /api/auctions/{id}/bids`)
Route public không yêu cầu token. Phân trang (`page`, `pageSize`), sắp xếp mới nhất trước (`createdAt: desc`). Trả về 404 nếu auction không tồn tại.

```http
GET /api/auctions/20000000-0000-4000-8000-000000000001/bids?page=1&pageSize=20 HTTP/1.1
Host: localhost:8080
```

Response 200:
```json
{
  "items": [
    {
      "id": "40000000-0000-4000-8000-000000000001",
      "auctionId": "20000000-0000-4000-8000-000000000001",
      "bidderId": "10000000-0000-4000-8000-000000000003",
      "amount": "150000",
      "createdAt": "2026-11-10T11:00:00.000Z"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

### Ví dụ API Tạo Auction & Worker Reservation (`[AUC-02]`)

#### Tạo phiên đấu giá (`POST /api/auctions`)
Route yêu cầu quyền `SELLER` và header `Idempotency-Key`. Tạo Auction ở trạng thái `INITIALIZING`, trả về **202 Accepted**. Worker nền sẽ quét các auction `INITIALIZING`, gọi internal reservation sang `product-service` để chuyển sang `PENDING`.

```http
POST /api/auctions HTTP/1.1
Host: localhost:8080
Authorization: Bearer <sellerAccessToken>
Idempotency-Key: a1b2c3d4-e5f6-7890-abcd-ef1234567890
Content-Type: application/json

{
  "productId": "30000000-0000-4000-8000-000000000001",
  "startingPrice": "100000",
  "bidIncrement": "10000",
  "startTime": "2026-11-12T10:00:00.000Z",
  "endTime": "2026-11-14T10:00:00.000Z"
}
```

Response 202:
```json
{
  "id": "20000000-0000-4000-8000-000000000001",
  "productId": "30000000-0000-4000-8000-000000000001",
  "sellerId": "10000000-0000-4000-8000-000000000002",
  "productTitle": null,
  "productThumbnail": null,
  "startingPrice": "100000",
  "currentPrice": "100000",
  "bidIncrement": "10000",
  "currency": "VND",
  "startTime": "2026-11-12T10:00:00.000Z",
  "endTime": "2026-11-14T10:00:00.000Z",
  "status": "INITIALIZING",
  "version": 0,
  "winnerId": null,
  "finalPrice": null
}
```

### Vòng đời Auction & Sự kiện Outbox (`[AUC-03]`)

`AuctionLifecycleScheduler` chạy định kỳ (mỗi ~1s), dùng `FOR UPDATE SKIP LOCKED` để tránh tranh chấp giữa các worker instance:
- **`PENDING` → `ACTIVE`**: Khi `startTime <= timezone('UTC', now())`, cập nhật `version = version + 1`, ghi outbox event `auction.started`, sau commit phát socket `auction:status_changed` (`status: ACTIVE`, `version`).
- **`ACTIVE` → `ENDED`**: Khi `endTime <= timezone('UTC', now())`, xác định `winnerId = leadingBidderId` và `finalPrice = currentPrice` (nếu không có bid thì cả hai là `null`), cập nhật `version = version + 1`, ghi outbox event `auction.ended`, sau commit phát socket `auction:status_changed` (`status: ENDED`, `version`).
- **Phục hồi sau restart**: Các auction quá hạn trong thời gian server dừng sẽ được kích hoạt lần lượt `started` (v1) rồi `ended` (v2) tuần tự theo đúng version.

Ví dụ payload event `auction.ended`:
```json
{
  "eventId": "e1f2a3b4-c5d6-7890-abcd-ef1234567890",
  "eventName": "auction.ended",
  "schemaVersion": 1,
  "occurredAt": "2026-11-12T10:00:00.000Z",
  "producer": "auction",
  "aggregateId": "20000000-0000-4000-8000-000000000001",
  "aggregateVersion": 2,
  "correlationId": "c1d2e3f4-a5b6-7890-abcd-ef1234567890",
  "payload": {
    "auctionId": "20000000-0000-4000-8000-000000000001",
    "productId": "30000000-0000-4000-8000-000000000001",
    "productTitle": "Vintage Mechanical Watch",
    "productThumbnail": "https://example.com/watch.jpg",
    "sellerId": "10000000-0000-4000-8000-000000000002",
    "winnerId": "10000000-0000-4000-8000-000000000003",
    "finalPrice": "150000",
    "currency": "VND",
    "endedAt": "2026-11-12T10:00:00.000Z"
  }
}
```

### Đặt Bid chống race & Idempotency (`[AUC-04]`)

#### Đặt giá cho phiên đấu giá (`POST /api/auctions/{id}/bids`)
Route yêu cầu quyền `USER` hoặc `SELLER` và header `Idempotency-Key` (8-128 ký tự).
Xử lý đồng thời và kiểm tra nghiệp vụ theo **Quyết định #4**:
1. Sử dụng `withIdempotency` với payload băm `{ auctionId, amount }` tránh xung đột idempotency key giữa các phiên khác nhau.
2. Khóa dòng Auction bằng `SELECT ... FOR UPDATE` và so sánh giờ DB (`timezone('UTC', now())`).
3. Kiểm tra điều kiện:
   - Phiên phải ở trạng thái `ACTIVE` và chưa hết hạn `now < endTime` (trả về 409 nếu không hợp lệ).
   - Seller không được đặt giá cho phiên của mình (trả về 403 `Forbidden`).
   - Người đang dẫn đầu không được tự nâng giá tiếp (trả về 409 `Conflict`).
   - Lượt bid đầu tiên: `amount >= startingPrice` (trả về 400 nếu nhỏ hơn).
   - Các lượt bid tiếp theo: `amount >= currentPrice + bidIncrement` (trả về 400 nếu nhỏ hơn).
4. Thực thi nguyên tử:
   - Insert bản ghi `Bid`.
   - Cập nhật `Auction` (`currentPrice = amount`, `leadingBidderId = bidderId`, `version = version + 1`, `updatedAt = timezone('UTC', now())`).
   - Enqueue event `bid.placed` vào bảng Outbox cùng transaction (`previousBidderId` là người dẫn đầu trước đó hoặc `null`).
5. Sau khi commit:
   - Chỉ khi cờ `executed` bật (lần chạy đầu, không phải replay) mới emit socket `auction:bid_updated` vào room `auction:${auctionId}`.
   - Gặp lỗi phát socket chỉ log warning, không phá vỡ transaction hoặc response của client.

```http
POST /api/auctions/20000000-0000-4000-8000-000000000001/bids HTTP/1.1
Host: localhost:8080
Authorization: Bearer <bidderAccessToken>
Idempotency-Key: b1c2d3e4-f5a6-7890-abcd-112233445566
Content-Type: application/json

{
  "amount": "160000"
}
```

Response 201:
```json
{
  "id": "40000000-0000-4000-8000-000000000002",
  "auctionId": "20000000-0000-4000-8000-000000000001",
  "bidderId": "10000000-0000-4000-8000-000000000004",
  "amount": "160000",
  "createdAt": "2026-11-10T11:05:00.000Z"
}
```

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

Service nhận `AUCTION_DATABASE_URL`, `AUCTION_PORT`, JWT public key/issuer/audience, RABBITMQ_URL, REDIS_URL, CORS_ORIGINS và PLATFORM_ADMIN_KEY. Auth nhận thêm private key/refresh secret. Auction/Product nhận INTERNAL_AUCTION_KEY; Payment/Order nhận INTERNAL_PAYMENT_KEY. Compose chỉ cấp credential cần thiết.

Host entrypoint dùng role riêng từ `AUCTION_DB_USER/PASSWORD`; không copy secret vào code. Demo chỉ bật khi PLATFORM_DEMO_ENABLED=true và NODE_ENV khác production.

## Database và migration

[Schema hiện tại](prisma/schema.prisma) và [thiết kế dữ liệu](../../docs/data-model.md). Chỉ thêm migration mới của service mình; không sửa migration đã apply, không dùng db push. Cần giữ các partial unique/check constraint ghi trong SQL. FK xuyên service bị cấm; logical reference chỉ là ID.

## Checklist nghiệp vụ cần làm

- [x] Viết INITIALIZING worker và scheduler có khả năng tiếp tục sau restart.
- [x] Khóa cùng dòng Auction khi bid/đóng phiên; kiểm tra thời gian database sau khóa.
- [x] Ghi bid/kết quả/outbox nguyên tử; dùng idempotency key.
- [x] Test request hợp lệ/sai quyền/không tồn tại/conflict và response đúng contract.
- [x] Test rollback, retry và event trùng nếu có consumer/producer.
- [x] Cập nhật ví dụ request/event và README khi thêm tính năng.

## Kiểm thử và bàn giao

`npm test` chạy unit/contract tests chung; thêm test nghiệp vụ trong service rồi dùng `npm exec vitest run apps/auction-service`. `npm run typecheck`, `npm run lint` và `npm run platform:smoke` kiểm tra toàn nền tảng. Shared contract/common thay đổi phải chạy cả sáu build/typecheck.

Không cần service khác hoàn thiện nghiệp vụ để bắt đầu: dùng fixture và internal demo adapter. HTTP planned 501 là trạng thái chờ code, không phải lỗi Docker. Dừng demo khi kiểm thử business flow thật để không nhầm fixture với dữ liệu thật.
