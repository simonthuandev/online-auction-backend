-- CreateEnum
CREATE TYPE "AuctionStatus" AS ENUM ('INITIALIZING', 'PENDING', 'ACTIVE', 'ENDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Auction" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "productTitle" TEXT,
    "productThumbnail" TEXT,
    "startingPrice" DECIMAL(18,2) NOT NULL,
    "currentPrice" DECIMAL(18,2) NOT NULL,
    "bidIncrement" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" "AuctionStatus" NOT NULL DEFAULT 'INITIALIZING',
    "leadingBidderId" TEXT,
    "winnerId" TEXT,
    "finalPrice" DECIMAL(18,2),
    "version" INTEGER NOT NULL DEFAULT 0,
    "initializationRequest" JSONB NOT NULL,
    "initializationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Auction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformProbe" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformProbe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "aggregateVersion" INTEGER NOT NULL,
    "exchange" TEXT NOT NULL,
    "routingKey" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB,
    "statusCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Auction_status_endTime_idx" ON "Auction"("status", "endTime");

-- CreateIndex
CREATE INDEX "Auction_status_startTime_idx" ON "Auction"("status", "startTime");

-- CreateIndex
CREATE INDEX "Auction_sellerId_createdAt_idx" ON "Auction"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "Auction_productId_createdAt_idx" ON "Auction"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "Bid_auctionId_createdAt_idx" ON "Bid"("auctionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformProbe_runId_kind_key" ON "PlatformProbe"("runId", "kind");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_aggregateId_aggregateVersion_key" ON "OutboxEvent"("aggregateId", "aggregateVersion");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_actorId_operation_key_key" ON "IdempotencyRecord"("actorId", "operation", "key");

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX "Auction_one_open_per_product" ON "Auction" ("productId") WHERE status IN ('INITIALIZING','PENDING','ACTIVE');
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_times" CHECK ("endTime" > "startTime"), ADD CONSTRAINT "Auction_prices" CHECK ("startingPrice" > 0 AND "bidIncrement" > 0 AND "currentPrice" >= "startingPrice");
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_amount_positive" CHECK (amount > 0);
