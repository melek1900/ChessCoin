-- ========= Idempotence TxLedger (évite doublons d'écriture) =========
-- Un même (userId, type, ref) ne peut exister qu'une fois.
CREATE UNIQUE INDEX IF NOT EXISTS "TxLedger_user_type_ref_uq"
ON "public"."TxLedger"("userId","type","ref");

-- ========= Index de confort/perf =========
-- (facultatif mais utile si tu filtres souvent par ref)
CREATE INDEX IF NOT EXISTS "TxLedger_ref_idx"
ON "public"."TxLedger"("ref");
