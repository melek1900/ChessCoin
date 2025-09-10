import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../jwt';

export function auth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    const payload = verifyAccessToken(token); // { sub, iat, exp }
    (req as any).userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}
