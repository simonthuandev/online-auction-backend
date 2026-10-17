// Sự kiện khi thanh toán đơn hàng thành công
export interface PaymentSucceededPayload {
  paymentId: string;
  orderId: string;
  userId: string;
  amount: number;
  paymentMethod: string;
  transactionId: string;
  paidAt: string;
}
