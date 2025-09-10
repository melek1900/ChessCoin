import crypto from 'crypto';

function base64url(buf: Buffer) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateVerifier(): string {
  return base64url(crypto.randomBytes(32)); // 43-128 chars
}

export function challengeFromVerifier(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64url(hash);
}
