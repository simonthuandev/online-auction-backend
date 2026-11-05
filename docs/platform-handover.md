# Bàn giao nền tảng

## Phân công và giới hạn

**Thuận**: Auth/Auction; **Tuấn**: Product/Notification; **A Thi**: Payment/Order. Nền tảng cung cấp kết nối, xác thực, schema, migration, route, validation, outbox, dedupe, retry/DLQ và socket facade. Chưa có nghiệp vụ đấu giá, reservation thật, sinh đơn, thanh toán hay lưu thông báo thật. Các internal adapter demo chỉ trả fixture và ghi PlatformProbe.

Mỗi người được tổ chức domain/application/repository theo cách phù hợp trong service mình. Điểm nối vào hạ tầng là `src/service-handlers.ts`; không cần sửa gateway hoặc tạo connection Redis/RabbitMQ mới. Không khai báo controller trùng route contract: platform HTTP dispatcher đã sở hữu route và validation. Auth controller là phần đã triển khai riêng.

## Viết HTTP handler

Đọc `operationId` từ OpenAPI của service rồi đăng ký trong `ServiceHandlers.onModuleInit()`. Có thể inject application service của bạn để delegate công việc.

```ts
this.http.register('product_get__api_products_id', async (request) => {
  // request.params.id đã validate UUID; request.principal có ở route protected.
  // Phân trang đã validate nhưng query vẫn là string; chuyển kiểu khi sử dụng.
  return this.products.findById(String(request.params.id));
});
```

Tên operationId phải copy chính xác từ contract (xem bảng trong README service). HTTP handler trả đúng response schema; status thành công lấy từ contract. Throw HttpException tương ứng cho 400/403/404/409. Xác thực role không thay thế kiểm tra ownership: seller chỉ sửa sản phẩm mình, buyer/seller chỉ xem đơn liên quan, user chỉ đọc notification của mình.

Thêm provider application/repository vào module của service, không thêm vào `libs/common`. Handler thật được ưu tiên trước internal demo adapter. Khi chưa đăng ký, platform trả 501.

## Consumer transaction

```ts
this.events.register('auction.ended', async (tx, event) => {
  if (event.eventName !== 'auction.ended' || !event.payload.winnerId) return;
  await tx.execute(
    'INSERT INTO "Order" (...) VALUES (...) ON CONFLICT ("auctionId") DO NOTHING',
    // SQL parameters, never interpolate user input into SQL.
  );
});
```

`tx` thuộc database của service hiện tại. Platform ghi ProcessedEvent và gọi handler trong cùng transaction; lỗi phải được throw để rollback và retry. Không catch lỗi rồi bỏ qua. Không dùng Prisma root client hay một transaction khác để ghi nghiệp vụ trong consumer. Nếu muốn dùng Prisma domain repository, adapter của repository phải chấp nhận transaction đang có; không tạo giao dịch độc lập.

Consumer có thể trả về một callback `return () => realtime.publishNotification(userId, payload)`. Platform gọi callback sau khi commit thành công; socket là best effort và client phục hồi qua REST nếu gửi thất bại. Không emit socket bên trong transaction.

`PermanentMessageError` dùng cho lỗi nghiệp vụ vĩnh viễn; lỗi dependency tạm thời dùng Error để retry. Các event không có handler thật sẽ vào DLQ khi không phải demo.

## Producer và idempotency

```ts
const result = await withIdempotency(
  db,
  actorId,
  operationId,
  idempotencyKey,
  body,
  202,
  async (tx) => {
    // Ghi business entity bằng chính tx này.
    await enqueueEvent(tx, event); // eventId/version ổn định, payload theo JSON Schema.
    return response;
  },
);
return result.response;
```

Inject `PLATFORM_DB` với type Database từ common. Helper dùng cho Auction/Payment, nơi schema có IdempotencyRecord và OutboxEvent. Response phải là JSON serializable; tiền là string nguyên đồng, thời gian ISO UTC. Relay phát sau commit; không tự publish sau transaction vì có thể mất event khi tiến trình chết.

Aggregate version phải tăng nguyên tử theo aggregate. Outbox gửi lần lượt theo aggregate; consumer vẫn cần bảo vệ state/version trước event cũ. Chốt bid và đóng phiên bằng khóa cùng dòng Auction, dùng đồng hồ database sau khi lấy khóa; quy tắc nghiệp vụ đầy đủ xem master plan.

## Realtime

Inject `Realtime`, dùng `publishBidUpdate`, `publishAuctionStatus`, `publishNotification` sau commit. Không nhận userId tùy ý từ client để join notification room. Không coi socket là kho lịch sử; REST đọc database để phục hồi sau reconnect.

## Viết test nghiệp vụ

Chia test thành hai tầng; đặt test tại `tests/` hoặc thư mục service tương ứng:

1. **Unit/business spec** (`*.spec.ts`): không cần Docker, database hay broker; mock dependency và kiểm tra quy tắc nghiệp vụ, quyền sở hữu, lỗi và kết quả. `npm test` chạy tầng này trong CI. Ví dụ: `tests/platform.spec.ts`.
2. **Integration spec** (`*.integration.spec.ts`): chạy trên stack integration local đã migrate, khởi động bằng Compose project riêng và dùng env file riêng (khuyến nghị `.env.integration`). Chạy `npm run test:integration`; script nạp env từ `.env` hoặc `PLATFORM_ENV_FILE`, đặt `PLATFORM_INTEGRATION=true` và chỉ chạy các file theo pattern này. Ví dụ PowerShell: `$env:PLATFORM_ENV_FILE='.env.integration'; npm run test:integration`; macOS/Linux: `PLATFORM_ENV_FILE=.env.integration npm run test:integration`. Ví dụ spec: `tests/idempotency.integration.spec.ts`.

Integration test luôn dùng database của service sở hữu; không truy cập database service khác. Tạo `runId` riêng cho mỗi test, truyền nó vào mọi fixture có thể gắn mã chạy (ví dụ `PlatformProbe.runId`, `IdempotencyRecord.actorId` và tên consumer/event), rồi gọi `cleanupRunData(pool, runId)` trong `afterAll`/`finally`. Helper ở `tests/support/pg-database.ts` bỏ qua các bảng platform không tồn tại trong database service đó; lỗi dọn dữ liệu được báo rõ, không bị nuốt. Migration test có thể dùng schema tạm và rollback như `tests/payment-migration.integration.spec.ts`.

Giữ hậu tố `.integration.spec.ts` cho test cần stack thật; các test không cần stack dùng `.spec.ts`. Vì integration spec cũng khớp `npm test`, chúng phải dùng `integrationEnabled` và `describe.skipIf(!integrationEnabled)` để CI mặc định skip. Không reset volume hoặc xóa dữ liệu không thuộc `runId`.

## Mở rộng database/hợp đồng

- Migration mới ở service sở hữu; không sửa migration đã apply, không db push.
- Giữ partial unique/check constraints trong SQL.
- OpenAPI và event JSON Schema là nguồn chính. Generated types và KrakenD không sửa bằng tay.
- Thay đổi thêm trường optional ưu tiên trước; breaking change cần phiên bản contract và cập nhật producer/consumer cùng nhau.
- Sau thay contract chạy generate/check, test và render gateway lại.
- AI agent đọc AGENTS.md và README service trước khi thay đổi.

## Quy trình nhận việc

1. Chạy các bước quickstart trong README root.
2. Chạy platform:smoke; lưu báo cáo baseline.
3. Đọc README service và contracts.
4. Viết handler nghiệp vụ; thay demo bằng handler thật từng luồng.
5. Test ownership, transaction, lỗi và trùng request/event.
6. PR kèm migration, request/event ví dụ và bằng chứng kiểm thử.

Không tự xóa volume để giải quyết lỗi migration. Không commit env, khóa hoặc token. Lệnh kiểm thử riêng service: `npm exec vitest run apps/<service>-service`; contract unit tests chung: `npm test`. Integration thật: `npm run platform:smoke`.
