import jwt, { JwtPayload } from 'jsonwebtoken';

// Narrow env at module load (TS now knows SECRET is a string)
const SECRET: string = (() => {
  const v = process.env.JWT_SECRET;
  if (!v) throw new Error('JWT_SECRET missing (define it in .env)');
  return v;
})();

export type AppJwtPayload = JwtPayload & { sub: string };

/** Create an access token. Default: 3600s (1h). */
export function signAccessToken(userId: string, expiresInSeconds = 3600): string {
  return jwt.sign({ sub: userId }, SECRET, {
    expiresIn: expiresInSeconds,
    algorithm: 'HS256',
  });
}

/** Verify & decode an access token (throws if invalid/expired). */
export function verifyAccessToken(token: string): AppJwtPayload {
  return jwt.verify(token, SECRET, { algorithms: ['HS256'] }) as AppJwtPayload;
}

/** Safe helper that doesn't throw; returns null if invalid. */
export function tryVerifyAccessToken(token: string): AppJwtPayload | null {
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}
