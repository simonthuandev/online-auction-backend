import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

export interface VnpayAttemptInput {
    id: string;
    amount: string | number;
    providerReference: string;
}

@Injectable()
export class VnpayGateway {
    /**
     * Kiểm tra xem các biến môi trường của VNPay đã được cấu hình chưa
     */
    isConfigured(): boolean {
        return Boolean(
            process.env.VNPAY_TMN_CODE &&
            process.env.VNPAY_HASH_SECRET &&
            process.env.VNPAY_URL,
        );
    }

    /**
     * Sinh URL thanh toán VNPay
     * - Nếu chưa có env -> quăng 501 trước khi tạo attempt
     * - Triển khai chi tiết ở PAY-04
     */
    buildPaymentUrl(attempt: VnpayAttemptInput): string {
        if (!this.isConfigured()) {
            throw new HttpException(
                'FEATURE_NOT_IMPLEMENTED',
                HttpStatus.NOT_IMPLEMENTED,
            );
        }
        // Stub URL tạm thời, PAY-04 sẽ hoàn thiện mã hóa HMAC-SHA512
        return `${process.env.VNPAY_URL}?vnp_TxnRef=${attempt.providerReference}&vnp_Amount=${attempt.amount}`;
    }
}
