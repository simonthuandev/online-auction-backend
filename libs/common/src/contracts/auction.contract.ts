// 1. Sự kiện khi phiên đấu giá bắt đầu (đồng bộ trạng thái sang product-service)
export interface AuctionStartedPayload {
  auctionId: string;
  productId: string;
  sellerId: string;
  startTime: string;
  endTime: string;
}

// 2. Sự kiện khi có người đặt giá mới thành công
export interface BidPlacedPayload {
  auctionId: string;
  productId: string;
  productTitle: string;
  newBidderId: string;
  previousBidderId: string | null; // Dùng để gửi thông báo OUTBID
  currentPrice: number;
  bidTime: string;
}

// 3. Sự kiện khi phiên đấu giá kết thúc
export interface AuctionEndedPayload {
  auctionId: string;
  productId: string;
  productTitle: string; // Snapshot sang bảng Order
  productThumbnail: string | null; // Snapshot sang bảng Order
  sellerId: string;
  winnerId: string | null; // null nếu phiên đấu giá không có ai đặt
  finalPrice: number | null;
  endedAt: string;
}
