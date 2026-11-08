export type ReserveProductInput = {
  auctionId: string;
  sellerId: string;
};

export type ReservationSnapshot = {
  productTitle: string;
  productThumbnail: string | null;
};

export type ReservationResponse = {
  auctionId: string;
  productId: string;
  sellerId: string;
  productTitle: string;
  productThumbnail: string | null;
};
