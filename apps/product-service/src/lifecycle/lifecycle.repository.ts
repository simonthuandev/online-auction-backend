import { Injectable } from '@nestjs/common';
import type { Transaction } from '@app/common';
import type {
  ProductLifecycleRecord,
  LifecycleDecision,
} from './lifecycle.types.js';

@Injectable()
export class LifecycleRepository {
  async lockAndFindProductByAuctionId(
    tx: Transaction,
    auctionId: string,
  ): Promise<ProductLifecycleRecord | null> {
    const rows = await tx.query<ProductLifecycleRecord>(
      `SELECT "id", "sellerId", "status", "reservedAuctionId", "reservationSnapshot", "lastAuctionVersion"
       FROM "Product"
       WHERE "reservedAuctionId" = $1
       FOR UPDATE`,
      auctionId,
    );

    if (!rows || rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      id: row.id,
      sellerId: row.sellerId,
      status: row.status,
      reservedAuctionId: row.reservedAuctionId,
      reservationSnapshot: row.reservationSnapshot,
      lastAuctionVersion: Number(row.lastAuctionVersion),
    };
  }

  async updateProductLifecycle(
    tx: Transaction,
    decision: Extract<LifecycleDecision, { action: 'UPDATE' }>,
  ): Promise<void> {
    if (decision.clearReservation) {
      await tx.execute(
        `UPDATE "Product"
         SET "status" = 'READY'::"ProductStatus",
             "reservedAuctionId" = NULL,
             "reservationSnapshot" = NULL,
             "lastAuctionVersion" = $1,
             "updatedAt" = now()
         WHERE "id" = $2`,
        decision.lastAuctionVersion,
        decision.productId,
      );
    } else if (decision.status === 'IN_AUCTION') {
      await tx.execute(
        `UPDATE "Product"
         SET "status" = 'IN_AUCTION'::"ProductStatus",
             "lastAuctionVersion" = $1,
             "updatedAt" = now()
         WHERE "id" = $2`,
        decision.lastAuctionVersion,
        decision.productId,
      );
    } else if (decision.status === 'SOLD') {
      await tx.execute(
        `UPDATE "Product"
         SET "status" = 'SOLD'::"ProductStatus",
             "lastAuctionVersion" = $1,
             "updatedAt" = now()
         WHERE "id" = $2`,
        decision.lastAuctionVersion,
        decision.productId,
      );
    }
  }
}

