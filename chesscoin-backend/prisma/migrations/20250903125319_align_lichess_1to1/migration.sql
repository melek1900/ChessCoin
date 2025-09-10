-- CreateIndex
CREATE INDEX "Match_createdAt_idx" ON "public"."Match"("createdAt");

-- CreateIndex
CREATE INDEX "TxLedger_userId_createdAt_idx" ON "public"."TxLedger"("userId", "createdAt");
