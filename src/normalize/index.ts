import { parsePhoneNumberFromString } from 'libphonenumber-js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Minúsculas, sem espaços. Null se vazio ou sem formato de e-mail. */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const email = input.replace(/\s+/g, '').toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

/** E.164 (ex: +5584999999999). Sem código do país assume BR. Null se inválido. */
export function normalizePhone(input: string | null | undefined, defaultCountry: 'BR' = 'BR'): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (raw.startsWith('+')) {
    const p = parsePhoneNumberFromString(`+${digits}`);
    return p?.isValid() ? p.number : null;
  }
  // Sem "+": primeiro como nacional (84999999999 não pode virar +84, Vietnã),
  // depois como internacional sem o "+" (5584999999999).
  const national = parsePhoneNumberFromString(digits, defaultCountry);
  if (national?.isValid()) return national.number;
  const intl = parsePhoneNumberFromString(`+${digits}`);
  return intl?.isValid() ? intl.number : null;
}

/** Sem query string, sem fragmento, sem barra final. Null se não for URL. */
export function normalizeLandingUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}
