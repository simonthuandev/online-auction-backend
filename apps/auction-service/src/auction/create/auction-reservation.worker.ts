import {
  Injectable,
  Inject,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  PLATFORM_DB,
  InternalHttp,
  InternalResponseError,
  type Database,
} from '@app/common';

export interface InitializingAuctionRecord {
  id: string;
  productId: string;
  sellerId: string;
  createdAt: Date | string;
}

@Injectable()
export class AuctionReservationWorker implements OnModuleInit, OnModuleDestroy {
  private intervalRef?: NodeJS.Timeout;
  private isProcessing = false;
  private readonly logger = new Logger(AuctionReservationWorker.name);

  constructor(
    @Inject(PLATFORM_DB) private readonly db: Database,
    private readonly internalHttp: InternalHttp,
  ) {}

  onModuleInit() {
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  start(intervalMs = 1000): void {
    if (this.intervalRef) return;
    this.intervalRef = setInterval(() => {
      void this.processBatch();
    }, intervalMs);
    this.intervalRef.unref();
    void this.processBatch();
  }

  stop(): void {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = undefined;
    }
  }

  async processBatch(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      const rows = await this.db.query<InitializingAuctionRecord>(
        `SELECT id, "productId", "sellerId", "createdAt"
         FROM "Auction"
         WHERE status = 'INITIALIZING'
         ORDER BY "createdAt" ASC
         LIMIT 50`,
      );

      for (const auction of rows) {
        await this.processAuction(auction);
      }
    } catch (err) {
      this.logger.error('Error during reservation scan', err);
    } finally {
      this.isProcessing = false;
    }
  }

  async processAuction(auction: InitializingAuctionRecord): Promise<void> {
    const now = Date.now();
    const createdTime = new Date(auction.createdAt).getTime();
    const isTimeout = now - createdTime > 10 * 60 * 1000;

    if (isTimeout) {
      // Quyết định #9: Quá 10 phút từ createdAt thì CANCELLED
      await this.cancelAuction(
        auction.id,
        'Reservation timed out after 10 minutes',
      );
      return;
    }

    try {
      // 1. Gọi InternalHttp.reserveProduct NGOÀI transaction (Quy ước 3.1 #4)
      const reservation = await this.internalHttp.reserveProduct(
        auction.productId,
        {
          auctionId: auction.id,
          sellerId: auction.sellerId,
        },
        auction.id,
      );

      // 2. Trong transaction ngắn khóa dòng (FOR UPDATE)
      await this.db.transaction(async (tx) => {
        const rows = await tx.query<{ id: string; status: string }>(
          'SELECT id, status FROM "Auction" WHERE id = $1 FOR UPDATE',
          auction.id,
        );
        const current = rows[0];
        if (current && current.status === 'INITIALIZING') {
          await tx.execute(
            `UPDATE "Auction"
             SET status = 'PENDING',
                 "productTitle" = $1,
                 "productThumbnail" = $2,
                 "updatedAt" = timezone('UTC', now())
             WHERE id = $3`,
            reservation.productTitle,
            reservation.productThumbnail ?? null,
            auction.id,
          );
        }
      });
    } catch (err: unknown) {
      // 3. Phân loại lỗi theo Quyết định #9:
      // InternalResponseError 403/404/409 → CANCELLED (ghi initializationError)
      // 5xx (kể cả 502/503/504 sau retry) và lỗi mạng → giữ INITIALIZING
      if (
        err instanceof InternalResponseError &&
        [403, 404, 409].includes(err.status)
      ) {
        await this.cancelAuction(
          auction.id,
          err.message || `Product reservation rejected with status ${err.status}`,
        );
      } else {
        this.logger.warn(
          `Temporary failure reserving product for auction ${auction.id}, keeping INITIALIZING to retry: ${String(err)}`,
        );
      }
    }
  }

  private async cancelAuction(
    auctionId: string,
    errorMsg: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string; status: string }>(
        'SELECT id, status FROM "Auction" WHERE id = $1 FOR UPDATE',
        auctionId,
      );
      const current = rows[0];
      if (current && current.status === 'INITIALIZING') {
        await tx.execute(
          `UPDATE "Auction"
           SET status = 'CANCELLED',
               "initializationError" = $1,
               "updatedAt" = timezone('UTC', now())
           WHERE id = $2`,
          errorMsg,
          auctionId,
        );
      }
    });
  }
}
