import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256 hexadecimal. O token é aleatório e longo, então hash simples basta (D-10 da seção 17). */
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Compara em tempo constante. Nunca lança: qualquer entrada ruim vira false. */
export function verifyToken(provided: string | null | undefined, storedHash: string): boolean {
  if (!provided || !/^[0-9a-f]{64}$/i.test(storedHash)) return false;
  const a = Buffer.from(hashToken(provided), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 32 bytes aleatórios em base64url (43 caracteres). */
export const generateToken = (): string => randomBytes(32).toString('base64url');
