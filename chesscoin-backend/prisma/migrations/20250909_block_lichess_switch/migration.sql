-- Empêche de changer lichessId/lichessUsername lorsqu'ils sont déjà non NULL
-- => On force un UNLINK explicite (remettre à NULL) avant de relier un nouveau compte.

-- 1) Fonction de trigger
CREATE OR REPLACE FUNCTION public.prevent_user_lichess_switch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Protéger lichessId : si déjà défini, interdire toute valeur différente
  IF (OLD."lichessId" IS NOT NULL) AND (NEW."lichessId" IS DISTINCT FROM OLD."lichessId") THEN
    RAISE EXCEPTION 'User already linked to a Lichess account (%. Unlink first).', OLD."lichessId"
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  -- Protéger lichessUsername : même logique
  IF (OLD."lichessUsername" IS NOT NULL) AND (NEW."lichessUsername" IS DISTINCT FROM OLD."lichessUsername") THEN
    RAISE EXCEPTION 'User already linked to a Lichess username (%. Unlink first).', OLD."lichessUsername"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- 2) Trigger avant UPDATE sur public.User
DROP TRIGGER IF EXISTS trg_prevent_user_lichess_switch ON public."User";

CREATE TRIGGER trg_prevent_user_lichess_switch
BEFORE UPDATE ON public."User"
FOR EACH ROW
EXECUTE FUNCTION public.prevent_user_lichess_switch();
