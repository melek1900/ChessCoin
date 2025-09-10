-- CreateEnum
CREATE TYPE "public"."TxType" AS ENUM ('gain', 'spend', 'stake_hold', 'stake_release', 'refund');

-- CreateEnum
CREATE TYPE "public"."Source" AS ENUM ('lichess', 'ai', 'native');

-- CreateEnum
CREATE TYPE "public"."Result" AS ENUM ('W', 'L', 'D', 'abort');

-- CreateEnum
CREATE TYPE "public"."EscrowStatus" AS ENUM ('held', 'resolved', 'refunded');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "lichessId" TEXT,
    "lichessUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Balance" (
    "userId" TEXT NOT NULL,
    "chessCC" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Balance_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "public"."TxLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "public"."TxType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "ref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TxLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Match" (
    "id" TEXT NOT NULL,
    "source" "public"."Source" NOT NULL,
    "lichessGameId" TEXT,
    "whiteId" TEXT,
    "blackId" TEXT,
    "stakeCC" INTEGER NOT NULL DEFAULT 0,
    "result" "public"."Result",
    "pgn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Escrow" (
    "matchId" TEXT NOT NULL,
    "whiteHold" INTEGER NOT NULL,
    "blackHold" INTEGER NOT NULL,
    "status" "public"."EscrowStatus" NOT NULL DEFAULT 'held',

    CONSTRAINT "Escrow_pkey" PRIMARY KEY ("matchId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_lichessId_key" ON "public"."User"("lichessId");

-- CreateIndex
CREATE UNIQUE INDEX "User_lichessUsername_key" ON "public"."User"("lichessUsername");

-- CreateIndex
CREATE UNIQUE INDEX "Match_lichessGameId_key" ON "public"."Match"("lichessGameId");

-- AddForeignKey
ALTER TABLE "public"."Balance" ADD CONSTRAINT "Balance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TxLedger" ADD CONSTRAINT "TxLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Match" ADD CONSTRAINT "Match_whiteId_fkey" FOREIGN KEY ("whiteId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Match" ADD CONSTRAINT "Match_blackId_fkey" FOREIGN KEY ("blackId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Escrow" ADD CONSTRAINT "Escrow_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "public"."Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
