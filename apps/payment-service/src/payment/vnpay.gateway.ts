import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

export interface VnpayAttemptInput {
    id: string;
    amount: string | number;
    providerReference: string;
}

@Injectable()
export class VnpayGateway {
    private getBaseUrl(): string | undefined {
        return process.env.VNPAY_PAY_URL || process.env.VNPAY_URL;
    }

    /**
     * Kiểm tra xem các biến môi trường của VNPay đã được cấu hình chưa
     */
    isConfigured(): boolean {
        return Boolean(
            process.env.VNPAY_TMN_CODE &&
            process.env.VNPAY_HASH_SECRET &&
            this.getBaseUrl(),
        );
    }

    /**
     * Sinh URL thanh toán VNPay
     * - Nếu chưa có env -> quăng 501 trước khi tạo attempt
     * - Triển khai chi tiết ở PAY-04
     */
    buildPaymentUrl(attempt: VnpayAttemptInput): string {
        const baseUrl = this.getBaseUrl();
        if (!this.isConfigured() || !baseUrl) {
            throw new HttpException(
                'FEATURE_NOT_IMPLEMENTED',
                HttpStatus.NOT_IMPLEMENTED,
            );
        }
        // Stub URL tạm thời, PAY-04 sẽ hoàn thiện mã hóa HMAC-SHA512
        return `${baseUrl}?vnp_TxnRef=${attempt.providerReference}&vnp_Amount=${attempt.amount}`;
    }
}
