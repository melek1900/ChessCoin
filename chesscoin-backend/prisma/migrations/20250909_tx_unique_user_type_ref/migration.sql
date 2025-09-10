-- Empêche les doublons logiques sur une même ref
CREATE UNIQUE INDEX IF NOT EXISTS "TxLedger_user_type_ref_uq"
ON "public"."TxLedger"("userId","type","ref");
