import { request,fetch  } from 'undici';

const LICHESS_BASE = 'https://lichess.org';
const CLIENT_ID = process.env.LICHESS_CLIENT_ID || 'chesscoin-local';
const REDIRECT_BASE = process.env.LICHESS_REDIRECT_BASE || 'http://localhost:4000';
const SCOPE = 'board:play challenge:write';

export type PkceEntry = { verifier: string; userId: string; exp: number };
export const pkceStore = new Map<string, PkceEntry>();

/** URL d’auth pour LINK protégé -> /lichess/callback */
export function buildLinkAuthUrl(state: string, codeChallenge: string) {
  const redirectUri = `${REDIRECT_BASE}/lichess/callback`;
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
  });
  return `${LICHESS_BASE}/oauth?${p.toString()}`;
}

type TokenKind = 'link';

/** Échange code OAuth + PKCE -> access_token */
export async function exchangeCodeForToken(params: { code: string; verifier: string; kind: TokenKind }) {
  const redirectUri = `${REDIRECT_BASE}/lichess/callback`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: params.verifier,
  }).toString();

  // Log minimal (sans secrets)
  console.log('[oauth] token exchange', { client_id: CLIENT_ID, redirect_uri: redirectUri, kind: params.kind });

  const r = await request(`${LICHESS_BASE}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (r.statusCode !== 200) {
    const txt = await r.body.text();
    throw new Error(`token exchange failed ${r.statusCode}: ${txt}`);
  }
  return (await r.body.json()) as { access_token: string; token_type: string; expires_in?: number };
}

/** /api/account -> { id, username } */
export async function fetchMe(accessToken: string) {
  const r = await request(`${LICHESS_BASE}/api/account`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (r.statusCode !== 200) throw new Error('fetchMe failed ' + r.statusCode);
  return (await r.body.json()) as { id: string; username: string };
}

/**
 * SSE user events (robuste): parse uniquement les lignes "data:"
 * - Retourne une fonction stop() qui abort le flux
 * - Heartbeat: si aucune donnée pendant 2 min, on coupe (le caller peut relancer)
 */
export async function streamUserEvents(
  accessToken: string,
  onEvent: (ev: any) => void
) {
  const controller = new AbortController();
  let stopped = false;

  const connect = async () => {
    console.log('[stream] connecting to Lichess SSE…');
    const r = await fetch(`${LICHESS_BASE}/api/stream/event`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    });

    if (!r.ok || !r.body) {
      const txt = await r.text().catch(() => '');
      console.error('[stream] failed', r.status, r.statusText, txt);
      throw new Error('streamUserEvents failed ' + r.status);
    }

    console.log('[stream] connected');
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev?.type === 'gameFinish') {
              console.log('[stream] gameFinish', ev?.game?.id);
            } else if (ev?.type) {
              console.log('[stream] event', ev.type);
            }
            onEvent(ev);
          } catch {
            // ignore lignes non JSON
          }
        }
      }
    } catch (e: any) {
      if (!stopped) {
        console.error('[stream] reader error', e?.message || e);
        throw e;
      }
    }
  };

  // boucle de (re)connexion simple
  (async () => {
    let attempt = 0;
    while (!stopped) {
      try {
        await connect();
        if (!stopped) {
          console.log('[stream] ended gracefully');
        }
        break;
      } catch {
        attempt++;
        const waitMs = Math.min(30000, 1000 * attempt);
        console.log(`[stream] reconnect in ${waitMs}ms (attempt ${attempt})`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  })();

  return () => {
    stopped = true;
    console.log('[stream] abort by caller');
    controller.abort();
  };
}


/**
 * Résumé d’une partie (JSON quand possible, fallback PGN parsé)
 * Retourne un objet minimal: { players, winner?, status? }
 */
export async function fetchGameSummary(accessToken: string, gameId: string) {
  const url = `${LICHESS_BASE}/game/export/${gameId}?pgnInJson=true&moves=false&clocks=false&evals=false&opening=false`;
  const r = await request(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json', // 👈 force JSON quand possible
    },
  });

  const txt = await r.body.text();
  if (r.statusCode !== 200) {
    throw new Error('fetch game failed ' + r.statusCode + ': ' + txt);
  }

  // 1) Essaye JSON d’abord
  try {
    return JSON.parse(txt);
  } catch {
    // 2) Fallback PGN minimal : déduire winner / draw / noms
    // Tags typiques: [Result "1-0"], [White "xxx"], [Black "yyy"]
    const result = /(?<=\[Result\s+")([0-9\/\-*]+)(?="\])/.exec(txt)?.[0] ?? '*';
    const whiteName = /(?<=\[White\s+")([^"]+)(?="\])/.exec(txt)?.[0] ?? '';
    const blackName = /(?<=\[Black\s+")([^"]+)(?="\])/.exec(txt)?.[0] ?? '';
    let winner: 'white' | 'black' | undefined;
    let status: string | undefined;
    if (result === '1-0') winner = 'white';
    else if (result === '0-1') winner = 'black';
    else if (result === '1/2-1/2') status = 'draw';

    return {
      players: {
        white: { user: whiteName ? { name: whiteName } : undefined },
        black: { user: blackName ? { name: blackName } : undefined },
      },
      winner,
      status,
    };
  }
}

/** Ouvrir une “seek” 3+0 */
export async function createSeek(
  accessToken: string,
  opts: { time: number; increment: number; rated: boolean; color: 'white' | 'black' | 'random' }
) {
  const body = new URLSearchParams({
    rated: String(opts.rated),
    time: String(opts.time),
    increment: String(opts.increment),
    color: opts.color,
  }).toString();

  const r = await request(`${LICHESS_BASE}/api/challenge/open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (r.statusCode !== 200) {
    const txt = await r.body.text();
    throw new Error('createSeek failed ' + r.statusCode + ': ' + txt);
  }
  return await r.body.json();
}
