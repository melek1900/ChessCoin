import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { auth } from './middleware/auth';
import { signAccessToken, verifyAccessToken } from './jwt';
import { holdStake, resolveMatch } from './wallet';

import {
  buildLinkAuthUrl,
  pkceStore,
  exchangeCodeForToken,
  fetchMe,
  streamUserEvents,
  fetchGameSummary,
  createSeek
} from './lichess';

import { generateVerifier, challengeFromVerifier } from './pkce';

const app = express();
const db = new PrismaClient();

app.use(cors({ origin: process.env.FRONT_ORIGIN || true, credentials: false }));
app.use(express.json());

/* ------------------------------------------------------------------ */
/* Matchmaking in-memory (pas de migration DB)                        */
/* ------------------------------------------------------------------ */
type MMKey = `${number}+${number}+${number}+${0|1}`; // time+inc+stake+rated(0/1)
type Ticket = { userId: string; username: string; stake: number; time: number; inc: number; rated: boolean; ts: number };

const mmQueues = new Map<MMKey, Ticket[]>();
function mmKey(time: number, inc: number, stake: number, rated: boolean): MMKey {
  return `${time}+${inc}+${stake}+${rated ? 1 : 0}`;
}

// Pending “stake match” pour lier au prochain gameStart/gameFinish
const pendingStakeByUser = new Map<string, string>(); // userId -> matchId

// Pending challenge “A défie B”
type PendingChallenge = {
  matchId: string;
  aUserId: string;
  bUserId: string;
  stake: number;
  time: number;
  inc: number;
  rated: boolean;
  started: boolean;
  timeout: NodeJS.Timeout;
};
const pendingChallenges = new Map<string, PendingChallenge>(); // matchId -> data

/* ------------------------------------------------------------------ */
/* Health                                                             */
/* ------------------------------------------------------------------ */
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/health/db', async (_req, res) => {
  try {
    await db.$queryRaw`SELECT 1`;
    res.json({ db: 'up' });
  } catch (e: any) {
    res.status(500).json({ db: 'down', error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Dev signup (JWT rapide)                                            */
/* ------------------------------------------------------------------ */
app.post('/dev/signup', async (req, res) => {
  const email = (req.body?.email as string) ?? `u${Date.now()}@mail.test`;
  try {
    const user = await db.user.create({ data: { email } });
    // Balance.updatedAt est @updatedAt NOT NULL → initialise-la
    await db.balance.create({ data: { userId: user.id, updatedAt: new Date() } });
    const token = signAccessToken(user.id);
    res.json({ user, token });
  } catch (e: any) {
    if (e.code === 'P2002') {
      const existing = await db.user.findUnique({ where: { email } });
      if (existing) return res.json({ user: existing, token: signAccessToken(existing.id) });
    }
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Lichess LINK (protégé)                                             */
/* ------------------------------------------------------------------ */

// 1) Démarrer l’OAuth pour lier le compte Lichess
app.get('/lichess/login', auth, async (req, res) => {
  const userId = req.userId as string;
  const state = signAccessToken(userId, 600); // 10 min
  const verifier = generateVerifier();
  const challenge = challengeFromVerifier(verifier);
  pkceStore.set(state, { verifier, userId, exp: Date.now() + 10 * 60 * 1000 });
  res.json({ url: buildLinkAuthUrl(state, challenge) });
});

// 2) Callback OAuth → lie au user courant (pas de “switch auto”)
app.get('/lichess/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code || !state) return res.status(400).send('Missing code/state');

  let userId: string;
  try {
    userId = verifyAccessToken(state).sub;
  } catch {
    return res.status(400).send('Invalid state');
  }

  const entry = pkceStore.get(state);
  if (!entry || entry.userId !== userId || entry.exp < Date.now()) {
    return res.status(400).send('State expired');
  }
  pkceStore.delete(state);

  try {
    const tok = await exchangeCodeForToken({ code, verifier: entry.verifier, kind: 'link' });
    const me = await fetchMe(tok.access_token);
    console.log('[lichess] me', me); // { id, username }

    // refuser si déjà lié ailleurs
    const existing = await db.user.findUnique({ where: { lichessId: me.id } });
    if (existing && existing.id !== userId) {
      const FRONT_ORIGIN = process.env.FRONT_ORIGIN || 'http://localhost:5173';
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.status(409).send(`<!doctype html>
<meta charset="utf-8" />
<script>
 (function(){
   var payload = {
     type: 'lichess_conflict',
     ok: false,
     reason: 'already_linked',
     existingUser: ${JSON.stringify({ id: existing.id, email: existing.email, lichessUsername: existing.lichessUsername })}
   };
   try { if (window.opener) window.opener.postMessage(payload, ${JSON.stringify(FRONT_ORIGIN)}); } catch(e){}
   setTimeout(function(){ try{ window.close(); }catch(e){} }, 800);
 })();
</script>
<h3>⚠️ Ce compte Lichess est déjà lié à un autre compte de l’app.</h3>`);
    }

    // garde-fou : s'assurer que le user existe encore
    const exists = await db.user.findUnique({ where: { id: userId } });
    if (!exists) {
      const FRONT_ORIGIN = process.env.FRONT_ORIGIN || 'http://localhost:5173';
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.status(400).send(`<!doctype html>
<meta charset="utf-8" />
<script>
 (function(){
   var payload = { type: 'lichess_error', ok: false, reason: 'session_lost' };
   try { if (window.opener) window.opener.postMessage(payload, ${JSON.stringify(FRONT_ORIGIN)}); } catch(e){}
   setTimeout(function(){ try{ window.close(); }catch(e){} }, 500);
 })();
</script>
<h3>Session expirée. Reconnecte-toi à l’app puis relance “Connect Lichess”.</h3>`);
    }

    // lier au user courant
    const user = await db.user.update({
      where: { id: userId },
      data: { lichessId: me.id, lichessUsername: me.username }
    });

    await db.lichessAuth.upsert({
      where: { userId: user.id },
      update: { accessToken: tok.access_token, updatedAt: new Date() },
      create: { userId: user.id, accessToken: tok.access_token, updatedAt: new Date() }
    });

    const FRONT_ORIGIN = process.env.FRONT_ORIGIN || 'http://localhost:5173';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(`<!doctype html>
<meta charset="utf-8" />
<script>
 (function(){
   var payload = { type: 'lichess_linked', ok: true, linked: { id: ${JSON.stringify(me.id)}, username: ${JSON.stringify(me.username)} } };
   try { if (window.opener) window.opener.postMessage(payload, ${JSON.stringify(FRONT_ORIGIN)}); } catch(e){}
   setTimeout(function(){ try{ window.close(); }catch(e){} }, 500);
 })();
</script>
<h3>✅ Compte Lichess lié. Tu peux fermer cette page.</h3>`);
  } catch (e: any) {
    console.error('lichess/callback error', e);
    return res.status(500).send('OAuth failed: ' + (e?.message || 'unknown'));
  }
});

/* ------------------------------------------------------------------ */
/* Play staké (solo)                                                  */
/* ------------------------------------------------------------------ */
app.post('/play/staked', auth, async (req, res) => {
  try {
    const userId = req.userId as string;
    const stake = Math.max(0, Number(req.body?.stake ?? 0) || 0);
    if (!stake) return res.status(400).json({ ok:false, error:'stake required' });

    const authRow = await db.lichessAuth.findUnique({ where: { userId } });
    if (!authRow) return res.status(400).json({ ok:false, error:'link lichess first' });

    // Crée un match “en attente”
    const match = await db.match.create({
      data: { source: 'lichess', stakeCC: stake }
    });

    // Bloque la mise du user (couleur provisoire)
    await holdStake({ matchId: match.id, whoUserId: userId, whoColor: 'white', stake });

    // Tag pending → prochain gameStart/gameFinish
    pendingStakeByUser.set(userId, match.id);

    // Assure stream & lance une seek
    await ensureStreamFor(userId, authRow.accessToken);
    await createSeek(authRow.accessToken, { time: 3, increment: 0, rated: false, color: 'random' });

    return res.json({ ok: true, launch: 'https://lichess.org/' });
  } catch (e: any) {
    return res.status(500).json({ ok:false, error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Lichess LINK status                                                */
/* ------------------------------------------------------------------ */
app.get('/lichess/status', auth, async (req, res) => {
  const u = await db.user.findUnique({ where: { id: req.userId } });
  res.json({ linked: Boolean(u?.lichessId), username: u?.lichessUsername ?? null });
});

/* ------------------------------------------------------------------ */
/* Stream & récompense + statut                                       */
/* ------------------------------------------------------------------ */
type GameFinishEvent = { type: 'gameFinish'; game: { id: string } };
type GameStartEvent  = { type: 'gameStart';  game: { id: string } };
type AnyEvent = GameFinishEvent | GameStartEvent | { type?: string; [k: string]: any };

type StreamInfo = {
  stop: () => void;
  lastEventAt: number | null;
  lastGameId: string | null;
};
const runningStreams = new Map<string, StreamInfo>(); // userId -> info

function rewardFromSummary(
  summary: { winner?: 'white' | 'black'; status?: string },
  isWhite: boolean | undefined
) {
  if (summary.status === 'draw') return 3;
  if (!summary.winner) return 1;
  const win =
    (summary.winner === 'white' && isWhite) ||
    (summary.winner === 'black' && isWhite === false);
  return win ? 8 : 1;
}

async function startStreamIfPossible(userId: string) {
  const authRow = await db.lichessAuth.findUnique({ where: { userId } });
  if (!authRow) return;
  if (runningStreams.get(userId)) return;
  await ensureStreamFor(userId, authRow.accessToken);
}

// Statut du stream
app.get('/lichess/stream/status', auth, async (req, res) => {
  const userId = req.userId as string;
  const info = runningStreams.get(userId) || null;
  res.json({
    streaming: Boolean(info),
    lastEventAt: info?.lastEventAt ?? null,
    lastGameId: info?.lastGameId ?? null
  });
});

// Start/Stop manuels
app.post('/lichess/stream/start', auth, async (req, res) => {
  try {
    const userId = req.userId as string;
    const authRow = await db.lichessAuth.findUnique({ where: { userId } });
    if (!authRow) return res.status(400).json({ ok: false, error: 'link lichess first' });

    // reset si déjà lancé
    const info = runningStreams.get(userId);
    info?.stop?.();
    runningStreams.delete(userId);

    await ensureStreamFor(userId, authRow.accessToken);
    res.json({ ok: true, streaming: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/lichess/stream/stop', auth, async (req, res) => {
  const userId = req.userId as string;
  const info = runningStreams.get(userId);
  info?.stop?.();
  runningStreams.delete(userId);
  res.json({ ok: true, streaming: false });
});

// Types d’événements (simplifiés)
type LichessEvent =
  | { type: 'gameStart'; game: { id: string } }
  | { type: 'gameFinish'; game: { id: string } }
  | { type: string; [k: string]: any };

// Assure un stream SSE pour le user si pas déjà actif
async function ensureStreamFor(userId: string, accessToken: string): Promise<void> {
  if (runningStreams.get(userId)) return;

  const stop = await streamUserEvents(accessToken, async (ev: LichessEvent) => {
    // book-keeping pour le statut
    const info = runningStreams.get(userId);
    if (info) {
      info.lastEventAt = Date.now();
      const gid = (ev as any)?.game?.id;
      if (gid) info.lastGameId = gid;
      runningStreams.set(userId, info);
    }

    // ---------- Lier le match stake "pending" au gameId au démarrage ----------
    if (ev?.type === 'gameStart' && ev?.game?.id) {
      const matchId = pendingStakeByUser.get(userId);
      if (matchId) {
        try {
          await db.match.update({
            where: { id: matchId },
            data: { lichessGameId: ev.game.id },
          });

          const pend = pendingChallenges.get(matchId);
          if (pend) {
            pend.started = true;
            clearTimeout(pend.timeout);
            pendingChallenges.set(matchId, pend);
          }

          console.log('[stake] linked', matchId, '->', ev.game.id);
        } catch (e) {
          console.error('[stake] link error', e);
        }
      }
      return;
    }

    // ---------- Fin de partie : résolution ----------
    if (ev?.type === 'gameFinish' && ev?.game?.id) {
      try {
        const sum: any = await fetchGameSummary(accessToken, ev.game.id);

        // Détecter la couleur du user courant
        let isWhite: boolean | undefined = undefined;
        const me = await db.user.findUnique({ where: { id: userId } });
        if (me?.lichessUsername && sum?.players) {
          const un = me.lichessUsername.toLowerCase();
          const white = String(sum.players?.white?.user?.name ?? sum.players?.white?.userId ?? '').toLowerCase();
          const black = String(sum.players?.black?.user?.name ?? sum.players?.black?.userId ?? '').toLowerCase();
          if (white === un) isWhite = true;
          else if (black === un) isWhite = false;
        }

        // Résultat W/D/L pour ce user (ou null si indéterminable)
        const result: 'W' | 'D' | 'L' | null =
          sum?.status === 'draw'
            ? 'D'
            : sum?.winner && isWhite !== undefined
            ? ((sum.winner === 'white' && isWhite) || (sum.winner === 'black' && isWhite === false) ? 'W' : 'L')
            : null;

        // Tenter d’identifier l’adversaire (et s’il est ChessCoin)
        let opponentUserId: string | null = null;
        const oppName =
          isWhite === true
            ? (sum?.players?.black?.user?.name ?? sum?.players?.black?.userId)
            : (isWhite === false
                ? (sum?.players?.white?.user?.name ?? sum?.players?.white?.userId)
                : null);

        if (oppName) {
          const opp = await db.user.findFirst({
            where: { lichessUsername: { equals: String(oppName), mode: 'insensitive' } },
          });
          opponentUserId = opp?.id ?? null;
        }

        // Upsert du match (création si inconnu) + mise à jour du résultat
        const match = await db.match.upsert({
          where: { lichessGameId: ev.game.id },
          update: { result: result ?? undefined },
          create: {
            source: 'lichess',
            lichessGameId: ev.game.id,
            whiteId:
              isWhite === true
                ? userId
                : (opponentUserId && isWhite === false ? opponentUserId : undefined),
            blackId:
              isWhite === false
                ? userId
                : (opponentUserId && isWhite === true ? opponentUserId : undefined),
            result: result ?? undefined,
          },
        });

        // ---------- Stake : résoudre via escrow ----------
        if (match.stakeCC > 0) {
          let winnerUserId: string | null | undefined = null;
          if (result === 'W') {
            if (isWhite === true) winnerUserId = match.whiteId || userId;
            else if (isWhite === false) winnerUserId = match.blackId || userId;
          }

          await resolveMatch({
            matchId: match.id,
            lichessGameId: ev.game.id,
            result: result ?? 'abort',
            winnerUserId: winnerUserId ?? null,
            whiteUserId: match.whiteId ?? null,
            blackUserId: match.blackId ?? null,
          });

          // Nettoyage des pendings
          const pend = pendingChallenges.get(match.id);
          if (pend) { clearTimeout(pend.timeout); pendingChallenges.delete(match.id); }
          pendingStakeByUser.delete(userId);
          if (opponentUserId) pendingStakeByUser.delete(opponentUserId);

          console.log('[stake] resolved match', match.id, 'result', result);
          return;
        }

        // ---------- Pas stake : reward “casual” ----------
        const delta =
          sum?.status === 'draw'
            ? 3
            : !sum?.winner
            ? 1
            : ((sum.winner === 'white' && isWhite) || (sum.winner === 'black' && isWhite === false) ? 8 : 1);

        await db.$transaction([
          db.balance.update({
            where: { userId },
            data: { chessCC: { increment: delta }, updatedAt: new Date() },
          }),
          db.txLedger.create({
            data: { userId, type: 'gain', amount: delta, ref: ev.game.id },
          }),
        ]);

        console.log(`[reward] user=${userId} +${delta}CC for game ${ev.game.id}`);
      } catch (e) {
        console.error('reward/resolve error', e);
      }
    }
  });

  runningStreams.set(userId, { stop, lastEventAt: Date.now(), lastGameId: null });
}

/* ------------------------------------------------------------------ */
/* DEV streams helpers                                                */
/* ------------------------------------------------------------------ */
app.get('/dev/streams', async (_req, res) => {
  res.json({ running: Array.from(runningStreams.keys()) });
});

app.post('/dev/streams/restart', auth, async (req, res) => {
  const userId = req.userId as string;
  try {
    const authRow = await db.lichessAuth.findUnique({ where: { userId } });
    if (!authRow) return res.status(400).json({ ok: false, error: 'link lichess first' });
    runningStreams.get(userId)?.stop?.();
    runningStreams.delete(userId);
    await ensureStreamFor(userId, authRow.accessToken);
    return res.json({ ok: true, restarted: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Jouer vite (3+0 casual)                                            */
/* ------------------------------------------------------------------ */
app.post('/play/quick', auth, async (req, res) => {
  try {
    const userId = req.userId as string;
    const authRow = await db.lichessAuth.findUnique({ where: { userId } });
    if (!authRow) return res.status(400).json({ ok: false, error: 'link lichess first' });

    await ensureStreamFor(userId, authRow.accessToken);
    await createSeek(authRow.accessToken, { time: 3, increment: 0, rated: false, color: 'random' });

    return res.json({ ok: true, launch: 'https://lichess.org/' });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Défi ami (stake)                                                   */
/* ------------------------------------------------------------------ */
app.post('/play/staked/challenge', auth, async (req, res) => {
  try {
    const userId = req.userId as string;
    const { opponent, stake, time = 3, increment = 0, rated = false } = req.body || {};
    const stakeN = Math.max(1, Number(stake || 0));

    if (!opponent || !stakeN) return res.status(400).json({ ok:false, error:'opponent & stake required' });

    const me = await db.user.findUnique({ where: { id: userId } });
    if (!me?.lichessUsername) return res.status(400).json({ ok:false, error:'link lichess first' });

    const opp = await db.user.findFirst({
      where: { lichessUsername: { equals: String(opponent), mode: 'insensitive' } }
    });
    if (!opp?.lichessId) return res.status(400).json({ ok:false, error:'opponent is not linked to ChessCoin' });
    if (opp.id === userId) return res.status(400).json({ ok:false, error:'cannot challenge yourself' });

    const meAuth = await db.lichessAuth.findUnique({ where: { userId } });
    if (!meAuth) return res.status(400).json({ ok:false, error:'link lichess first' });

    // crée un match et hold la mise du challenger (A)
    const match = await db.match.create({
      data: { source: 'lichess', stakeCC: stakeN, whiteId: null, blackId: null }
    });

    await holdStake({ matchId: match.id, whoUserId: userId, whoColor: 'white', stake: stakeN }); // couleur provisoire

    // Enregistre pending pour A et B → lier au gameStart
    pendingStakeByUser.set(userId, match.id);
    pendingStakeByUser.set(opp.id, match.id);

    // Assure les streams pour les deux users
    const aTok = meAuth.accessToken;
    const bAuth = await db.lichessAuth.findUnique({ where: { userId: opp.id } });
    if (!bAuth) return res.status(400).json({ ok:false, error:'opponent must have linked lichess' });

    await ensureStreamFor(userId, aTok);
    await ensureStreamFor(opp.id, bAuth.accessToken);

    // Challenge direct vers l'adversaire (API Lichess)
    const body = new URLSearchParams({
      rated: String(rated),
      clock: JSON.stringify({ limit: time * 60, increment }),
      color: 'random',
      message: `ChessCoin stake: ${stakeN} CC`,
    }).toString();

    const challengeUrl = `https://lichess.org/api/challenge/${opp.lichessUsername}`;
    const r = await fetch(challengeUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aTok}`, 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(500).json({ ok:false, error: `lichess challenge failed: ${txt}` });
    }

    // Timeout: si la partie ne démarre pas, on annule et on rembourse
    const timeout = setTimeout(async () => {
      try {
        const m = await db.match.findUnique({ where: { id: match.id } });
        if (!m?.lichessGameId && !pendingChallenges.get(match.id)?.started) {
          await resolveMatch({
            matchId: match.id,
            lichessGameId: `cancel-${Date.now()}`,
            result: 'abort',
            winnerUserId: null,
            whiteUserId: userId,
            blackUserId: opp.id,
          });
          pendingStakeByUser.delete(userId);
          pendingStakeByUser.delete(opp.id);
          pendingChallenges.delete(match.id);
          console.log('[challenge] timeout → refund');
        }
      } catch (e) { console.error('[challenge] timeout error', e); }
    }, 2 * 60 * 1000);

    pendingChallenges.set(match.id, {
      matchId: match.id,
      aUserId: userId,
      bUserId: opp.id,
      stake: stakeN,
      time, inc: increment, rated,
      started: false,
      timeout,
    });

    return res.json({ ok: true, launch: 'https://lichess.org/' });
  } catch (e: any) {
    return res.status(500).json({ ok:false, error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Queue matchmaking                                                  */
/* ------------------------------------------------------------------ */
app.post('/queue/join', auth, async (req, res) => {
  try {
    const userId = req.userId as string;
    const { stake, time = 3, increment = 0, rated = false } = req.body || {};
    const stakeN = Math.max(1, Number(stake || 0));
    if (!stakeN) return res.status(400).json({ ok:false, error:'stake required' });

    const me = await db.user.findUnique({ where: { id: userId } });
    if (!me?.lichessUsername) return res.status(400).json({ ok:false, error:'link lichess first' });

    const authRow = await db.lichessAuth.findUnique({ where: { userId } });
    if (!authRow) return res.status(400).json({ ok:false, error:'link lichess first' });

    await ensureStreamFor(userId, authRow.accessToken);

    const key = mmKey(time, increment, stakeN, rated);
    const q = mmQueues.get(key) ?? [];
    if (q.find(t => t.userId === userId)) return res.json({ ok:true, queued: true });

    q.push({ userId, username: me.lichessUsername!, stake: stakeN, time, inc: increment, rated, ts: Date.now() });
    mmQueues.set(key, q);

    // matchmaking simple
    if (q.length >= 2) {
      const a = q.shift()!;
      const b = q.shift()!;
      mmQueues.set(key, q);

      // crée match & hold stakes
      const match = await db.match.create({ data: { source: 'lichess', stakeCC: stakeN } });
      await holdStake({ matchId: match.id, whoUserId: a.userId, whoColor: 'white', stake: stakeN });
      await holdStake({ matchId: match.id, whoUserId: b.userId, whoColor: 'black', stake: stakeN });

      // pending
      pendingStakeByUser.set(a.userId, match.id);
      pendingStakeByUser.set(b.userId, match.id);

      // streams
      const aTok = (await db.lichessAuth.findUnique({ where: { userId: a.userId } }))!.accessToken;
      const bTok = (await db.lichessAuth.findUnique({ where: { userId: b.userId } }))!.accessToken;
      await ensureStreamFor(a.userId, aTok);
      await ensureStreamFor(b.userId, bTok);

      // A challenge B
      const body = new URLSearchParams({
        rated: String(rated),
        clock: JSON.stringify({ limit: time * 60, increment }),
        color: 'random',
        message: `ChessCoin stake: ${stakeN} CC`,
      }).toString();

      const r = await fetch(`https://lichess.org/api/challenge/${b.username}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aTok}`, 'content-type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!r.ok) {
        const txt = await r.text();
        // refund si challenge KO
        await resolveMatch({
          matchId: match.id,
          lichessGameId: `cancel-${Date.now()}`,
          result: 'abort',
          winnerUserId: null,
          whiteUserId: a.userId,
          blackUserId: b.userId,
        });
        pendingStakeByUser.delete(a.userId);
        pendingStakeByUser.delete(b.userId);
        return res.status(500).json({ ok:false, error: `lichess challenge failed: ${txt}` });
      }

      // timeout si personne n'accepte
      const timeout = setTimeout(async () => {
        try {
          const m = await db.match.findUnique({ where: { id: match.id } });
          if (!m?.lichessGameId) {
            await resolveMatch({
              matchId: match.id,
              lichessGameId: `cancel-${Date.now()}`,
              result: 'abort',
              winnerUserId: null,
              whiteUserId: a.userId,
              blackUserId: b.userId,
            });
            pendingStakeByUser.delete(a.userId);
            pendingStakeByUser.delete(b.userId);
            console.log('[queue] timeout → refund');
          }
        } catch (e) { console.error('[queue] timeout error', e); }
      }, 2 * 60 * 1000);

      pendingChallenges.set(match.id, {
        matchId: match.id, aUserId: a.userId, bUserId: b.userId,
        stake: stakeN, time, inc: increment, rated, started: false, timeout
      });

      return res.json({ ok:true, matched: true, launch: 'https://lichess.org/' });
    }

    return res.json({ ok:true, queued: true });
  } catch (e: any) {
    return res.status(500).json({ ok:false, error: e.message });
  }
});

app.post('/queue/leave', auth, async (req, res) => {
  try {
    const userId = req.userId as string;
    for (const [key, q] of mmQueues) {
      const i = q.findIndex(t => t.userId === userId);
      if (i >= 0) {
        q.splice(i, 1);
        mmQueues.set(key, q);
      }
    }
    return res.json({ ok:true, left:true });
  } catch (e: any) {
    return res.status(500).json({ ok:false, error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Me / Wallet / History                                              */
/* ------------------------------------------------------------------ */
app.get('/me', auth, async (req, res) => {
  const userId = req.userId as string;
  const me = await db.user.findUnique({
    where: { id: userId },
    include: { balance: true }
  });

  if (me?.lichessId) {
    try { await startStreamIfPossible(userId); } catch (e) {
      console.error('[me] startStreamIfPossible error', (e as any)?.message || e);
    }
  }

  res.json({ me });
});

app.get('/wallet', auth, async (req, res) => {
  const userId = req.userId as string;
  const take = Math.min(Math.max(Number(req.query.take ?? 20), 1), 100);
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const type = typeof req.query.type === 'string' ? (req.query.type as string) : undefined;

  const where: any = { userId };
  if (type === 'gain' || type === 'spend') where.type = type;

  const balance = await db.balance.findUnique({ where: { userId } });
  const ledger = await db.txLedger.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
  });

  const nextCursor = ledger.length === take ? ledger[ledger.length - 1].id : null;
  res.json({ balance, ledger, nextCursor });
});

app.get('/history', auth, async (req, res) => {
  const userId = req.userId as string;
  const take = Math.min(Math.max(Number(req.query.take ?? 20), 1), 100);
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  const items = await db.match.findMany({
    where: { OR: [{ whiteId: userId }, { blackId: userId }] },
    orderBy: { createdAt: 'desc' },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
  });

  const nextCursor = items.length === take ? items[items.length - 1].id : null;
  res.json({
    items: items.map(m => ({
      id: m.id,
      gameId: m.lichessGameId,
      result: m.result ?? null,
      at: m.createdAt
    })),
    nextCursor
  });
});

/* ------------------------------------------------------------------ */
/* Leaderboards                                                       */
/* ------------------------------------------------------------------ */
app.get('/leaderboard/balance', async (_req, res) => {
  const rows = await db.balance.findMany({
    orderBy: [{ chessCC: 'desc' }, { updatedAt: 'desc' }],
    take: 50,
    include: { user: true }
  });
  res.json({
    items: rows.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      email: r.user.email,
      lichess: r.user.lichessUsername,
      chessCC: r.chessCC,
      updatedAt: r.updatedAt,
    }))
  });
});

app.get('/leaderboard/gains30d', async (_req, res) => {
  const since = new Date(Date.now() - 30*24*60*60*1000);
  const rows = await db.txLedger.groupBy({
    by: ['userId'],
    where: { type: 'gain', createdAt: { gte: since } },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: 50,
  });

  const users = await db.user.findMany({ where: { id: { in: rows.map(r => r.userId) } } });
  const byId = new Map(users.map(u => [u.id, u]));

  res.json({
    items: rows.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      email: byId.get(r.userId)?.email ?? null,
      lichess: byId.get(r.userId)?.lichessUsername ?? null,
      gained: r._sum.amount ?? 0,
      since,
    }))
  });
});

/* ------------------------------------------------------------------ */
/* Auto-restore streams au boot                                       */
/* ------------------------------------------------------------------ */
(async () => {
  try {
    const rows = await db.lichessAuth.findMany();
    for (const row of rows) {
      ensureStreamFor(row.userId, row.accessToken).catch(() => {});
    }
    console.log(`[lichess] streams auto-restored for ${rows.length} users`);
  } catch (e) {
    console.error("[lichess] auto-start failed", e);
  }
})();

/* ------------------------------------------------------------------ */
/* Shutdown propre                                                    */
/* ------------------------------------------------------------------ */
async function shutdown(code = 0) {
  try { await db.$disconnect(); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => console.log('API on :' + PORT));
