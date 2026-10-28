-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'SELLER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'GOOGLE');

-- DropIndex
DROP INDEX "RefreshToken_token_key";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "googleId" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provider" "AuthProvider" NOT NULL DEFAULT 'LOCAL',
ALTER COLUMN "password" DROP NOT NULL,
ALTER COLUMN "role" DROP DEFAULT,
ALTER COLUMN "role" TYPE "UserRole" USING "role"::"UserRole",
ALTER COLUMN "role" SET DEFAULT 'USER';

-- AlterTable
ALTER TABLE "RefreshToken" 
ADD COLUMN     "jti" TEXT,
ADD COLUMN     "tokenHash" TEXT;

-- CreateTable
CREATE TABLE "PlatformProbe" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformProbe_pkey" PRIMARY KEY ("id")
);

UPDATE "RefreshToken" SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex'), "jti" = "id", "isRevoked" = true;
ALTER TABLE "RefreshToken" ALTER COLUMN "tokenHash" SET NOT NULL, ALTER COLUMN "jti" SET NOT NULL, DROP COLUMN "token";
-- CreateIndex
CREATE UNIQUE INDEX "PlatformProbe_runId_kind_key" ON "PlatformProbe"("runId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_jti_key" ON "RefreshToken"("jti");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_familyId_idx" ON "RefreshToken"("userId", "familyId");

