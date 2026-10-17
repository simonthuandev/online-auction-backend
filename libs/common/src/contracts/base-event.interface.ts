export interface BaseEvent<T> {
  eventId: string; // UUID v4 dùng để kiểm tra Idempotency
  eventName: string; // Tên sự kiện định danh
  timestamp: string; // ISO 8601 UTC timestamp
  payload: T;
}
