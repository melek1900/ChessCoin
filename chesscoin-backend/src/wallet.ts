import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

type Result = 'W' | 'L' | 'D' | 'abort';
type TxType = 'gain' | 'spend' | 'stake_hold' | 'stake_release' | 'refund';

function now() { return new Date(); }

/**
 * Idempotence applicative via (userId,type,ref).
 * RECO DB: ajouter un index unique (userId,type,ref) sur TxLedger pour blindage:
 *   CREATE UNIQUE INDEX "TxLedger_user_type_ref_uq" ON "TxLedger"("userId","type","ref");
 */
async function ensureTx(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    type: TxType;
    amount: number;      // >0 crédit / <0 débit / 0 trace
    ref?: string | null; // ex: matchId ou lichessGameId
  }
) {
  const ref = params.ref ?? null;

  const existing = ref
    ? await tx.txLedger.findFirst({
        where: { userId: params.userId, type: params.type as any, ref },
      })
    : null;
  if (existing) return existing;

  const created = await tx.txLedger.create({
    data: {
      id: randomUUID(),
      userId: params.userId,
      type: params.type as any,
      amount: params.amount,
      ref,
      createdAt: now(),
    },
  });

  // Mettre à jour la balance (et updatedAt NOT NULL)
  await tx.balance.update({
    where: { userId: params.userId },
    data: {
      ...(params.amount !== 0 ? { chessCC: { increment: params.amount } } : {}),
      updatedAt: now(),
    },
  });

  return created;
}

/** Débiter la mise (hold) + init/maj escrow. */
export async function holdStake(args: {
  matchId: string;
  whoUserId: string;
  whoColor: 'white' | 'black';
  stake: number;
}) {
  if (args.stake <= 0) return;

  await prisma.$transaction(async (tx) => {
    const bal = await tx.balance.findUnique({ where: { userId: args.whoUserId } });
    if (!bal || bal.chessCC < args.stake) throw new Error('INSUFFICIENT_FUNDS');

    await ensureTx(tx, {
      userId: args.whoUserId,
      type: 'stake_hold',
      amount: -args.stake,
      ref: args.matchId,
    });

    const esc = await tx.escrow.findUnique({ where: { matchId: args.matchId } });
    if (!esc) {
      await tx.escrow.create({
        data: {
          matchId: args.matchId,
          whiteHold: args.whoColor === 'white' ? args.stake : 0,
          blackHold: args.whoColor === 'black' ? args.stake : 0,
          status: 'held',
        },
      });
    } else {
      await tx.escrow.update({
        where: { matchId: args.matchId },
        data: {
          whiteHold: esc.whiteHold + (args.whoColor === 'white' ? args.stake : 0),
          blackHold: esc.blackHold + (args.whoColor === 'black' ? args.stake : 0),
        },
      });
    }
  });
}

/**
 * Résoudre un match:
 * - D / abort: refund totalité des deux holds, escrow -> refunded
 * - W: gain pour le winner (hold adverse), release (0) côté loser, escrow -> resolved
 * - Idempotent si match.result déjà défini
 */
// wallet.ts
export async function resolveMatch(args: {
  matchId: string;
  lichessGameId: string;
  result: Result;               // 'W' | 'L' | 'D' | 'abort'
  winnerUserId?: string | null; // requis si 'W'
  whiteUserId: string | null;
  blackUserId: string | null;
}) {
  await prisma.$transaction(async (tx) => {
    const match = await tx.match.findUnique({ where: { id: args.matchId } });
    if (!match) throw new Error('MATCH_NOT_FOUND');
    if (match.result) return; // déjà résolu

    const escrow = await tx.escrow.findUnique({ where: { matchId: args.matchId } });
    const stakeWhite = escrow?.whiteHold ?? 0;
    const stakeBlack = escrow?.blackHold ?? 0;

    await tx.match.update({
      where: { id: args.matchId },
      data: { lichessGameId: args.lichessGameId, result: args.result as any },
    });

    if (!escrow || (!stakeWhite && !stakeBlack)) {
      // rien à faire niveau escrow
      return;
    }

    // Draw / Abort -> remboursement simple des mises présentes
    if (args.result === 'D' || args.result === 'abort') {
      if (args.whiteUserId && stakeWhite > 0) {
        await ensureTx(tx as any, { userId: args.whiteUserId, type: 'refund', amount: stakeWhite, ref: args.lichessGameId });
      }
      if (args.blackUserId && stakeBlack > 0) {
        await ensureTx(tx as any, { userId: args.blackUserId, type: 'refund', amount: stakeBlack, ref: args.lichessGameId });
      }
      await tx.escrow.update({ where: { matchId: args.matchId }, data: { status: 'refunded' } });
      return;
    }

    if (args.result === 'W') {
      const winner = args.winnerUserId;
      if (!winner) throw new Error('WINNER_REQUIRED');

      const winnerIsWhite = winner === args.whiteUserId;
      const winnerOwnStake = winnerIsWhite ? stakeWhite : stakeBlack;   // mise du gagnant (à rembourser)
      const loserStake     = winnerIsWhite ? stakeBlack : stakeWhite;   // mise adverse (le “gain”)

      // 1) Rembourse TOUJOURS la mise du gagnant si elle a été bloquée
      if (winnerOwnStake > 0) {
        await ensureTx(tx as any, { userId: winner, type: 'refund', amount: winnerOwnStake, ref: args.lichessGameId });
      }

      // 2) Crédite le gain correspondant à la mise de l’adversaire s’il y en a une
      if (loserStake > 0) {
        await ensureTx(tx as any, { userId: winner, type: 'gain', amount: loserStake, ref: args.lichessGameId });
      }

      // 3) Trace “release” côté perdant si perdant existe (montant 0 = trace idempotente)
      const loser = winnerIsWhite ? args.blackUserId : args.whiteUserId;
      if (loser) {
        await ensureTx(tx as any, { userId: loser, type: 'stake_release', amount: 0, ref: args.lichessGameId });
      }

      await tx.escrow.update({ where: { matchId: args.matchId }, data: { status: 'resolved' } });
      return;
    }

    // cas 'L' côté point de vue — normalement on ne passe pas par là (on résout avec 'W')
  });
}


