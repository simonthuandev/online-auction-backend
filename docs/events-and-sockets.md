# Event và Socket.IO

## RabbitMQ

| Exchange | Routing key | Queue nhận |
|---|---|---|
| auction_exchange | auction.started | queue.product.auction-events |
| auction_exchange | bid.placed | queue.notification.events |
| auction_exchange | auction.ended | queue.product.auction-events, queue.order.events, queue.notification.events |
| payment_exchange | payment.succeeded | queue.order.events, queue.notification.events |

Bootstrap publisher assert toàn bộ exchange/queue/binding trước khi publish. Mỗi queue có `.retry` (TTL 5 giây, dead-letter về queue chính) và `.dlq`. Prefetch 10, manual ACK. Tối đa 3 retry sau lần đầu. Các message sao chép sang retry/DLQ chờ publisher confirm trước ACK. Delivery là at-least-once; crash sau confirm có thể tạo bản sao và cần ProcessedEvent.

Queue durable/message persistent và volume RabbitMQ bảo vệ restart node đơn. Retry TTL dead-letter của queue classic không phải bảo đảm không mất dữ liệu khi toàn bộ broker/storage lỗi. Đây là baseline một node, chưa phải cluster HA. Outbox bảo vệ khoảng trống DB→broker, không thay thế backup hay độ bền storage.

Schema đầy đủ trong `contracts/events/*.json`; TypeScript generated trong common/contracts. Envelope có eventId, eventName, schemaVersion, occurredAt, producer, aggregateId, aggregateVersion, correlationId và payload. `demo: {runId}` là trường optional dành dev/test; production consumer từ chối demo. Producer/schema version được kiểm tra tại runtime.

Ví dụ event hợp lệ:

```json
{
  "eventId": "40000000-0000-4000-8000-000000000001",
  "eventName": "payment.succeeded",
  "schemaVersion": 1,
  "occurredAt": "2026-10-25T00:00:00.000Z",
  "producer": "payment",
  "aggregateId": "40000000-0000-4000-8000-000000000002",
  "aggregateVersion": 1,
  "correlationId": "40000000-0000-4000-8000-000000000003",
  "payload": {
    "paymentId": "40000000-0000-4000-8000-000000000002",
    "orderId": "40000000-0000-4000-8000-000000000004",
    "userId": "10000000-0000-4000-8000-000000000003",
    "amount": "100000",
    "currency": "VND",
    "paymentMethod": "COD",
    "transactionId": "TXN_EXAMPLE",
    "paidAt": "2026-10-25T00:00:00.000Z"
  }
}
```

Không publish event của service khác. Không đổi eventId khi retry/replay. `rmq:inspect` hiển thị số message; `rmq:replay -- <main-queue> <count>` chuyển có confirm từ DLQ sang queue chính. Malformed JSON được bọc `{malformed: "raw bytes as UTF-8"}` khi vào DLQ để giữ nội dung chẩn đoán; cần sửa payload trước khi replay.

Payment hỗ trợ `COD` (tiền mặt khi nhận hàng) và `VNPAY`. Event COD chỉ phát sau khi có xác nhận thu tiền hợp lệ; tạo yêu cầu COD chưa phải thanh toán thành công. `transactionId` của COD là mã biên nhận nội bộ. Ví dụ/smoke nền tảng vẫn là fixture kiểm tra kết nối, không xác nhận thu tiền thật.

## Socket.IO

Hai server độc lập chạy trong Auction/Notification; không đi qua KrakenD CE. Namespace `/auctions` và `/notifications`, path `/socket.io`, WebSocket transport. Token access RS256 truyền bằng `auth.token`.

```ts
import { io } from 'socket.io-client';
const auction = io('http://localhost:3003/auctions', {
  transports: ['websocket'], auth: { token: accessToken },
});
auction.on('connect', async () => {
  const result = await auction.timeout(3000).emitWithAck('auction:subscribe', { auctionId });
  // result: {ok: true, auctionId} hoặc {ok: false, code: 'INVALID_AUCTION_ID'}
});
auction.on('auction:bid_updated', payload => {/* payload gồm version */});
auction.on('auction:status_changed', payload => {/* fetch REST nếu cần */});
auction.emit('auction:unsubscribe', { auctionId });

const notifications = io('http://localhost:3006/notifications', {
  transports: ['websocket'], auth: { token: accessToken },
});
notifications.on('notification:new', notification => {/* render */});
```

Room Auction: `auction:{auctionId}`. Notification room `user:{sub}` do server tự join; không có API join user room khác. Token hết hạn: server disconnect, client refresh và reconnect. Khi reconnect cần subscribe lại Auction và fetch REST. Giá socket dùng money string; version dùng bỏ event cũ.

Các socket facade nhận payload nghiệp vụ từ owner sau transaction commit; JSON schema event là nguồn cho dữ liệu đấu giá, notification mới theo schema Notification trong OpenAPI. Demo dùng thông báo được đánh dấu metadata.demoRunId và không lưu Notification thật.

Redis adapter dùng hai channel prefix `auction:socket` và `notification:socket`; không dùng Redis DB index để giả định cách ly Pub/Sub. Key probe có prefix service và TTL 30 giây. Redis không lưu lịch sử socket. Mất Redis có thể khiến broadcast liên replica không tới; REST phục hồi trạng thái.
