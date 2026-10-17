// Password rules shared by the API (sign-up, reset, invite, change password) and the forms (strength hints).
// ASVS 2.1: ≥ 8 characters (workspace minimum, default 10), long passphrases allowed (≤ 128), no composition rules,
// refuse well-known breached/common passwords and the account's e-mail / username with digits added.

export const PASSWORD_MAX = 128
export const PASSWORD_FLOOR = 8

// The most common passwords of public breach corpora (base words; trailing digits/symbols are stripped before
// the lookup, so "Password@123" and "welcome2024!" are refused as well).
const COMMON = new Set(
  (
    'password passw0rd p@ssw0rd p@ssword pass1234 123456 1234567 12345678 123456789 1234567890 0987654321 111111 000000 ' +
    '123123 654321 666666 121212 112233 qwerty qwertyuiop qwerty123 asdfgh asdfghjkl zxcvbnm 1q2w3e4r 1qaz2wsx qazwsx ' +
    'abc123 abcd1234 abcdef iloveyou admin administrator welcome letmein monkey dragon sunshine princess football ' +
    'baseball master shadow superman batman trustno1 starwars freedom whatever qwer1234 login hello hellohello ' +
    'changeme secret default guest test tester testing temp temporary access access14 computer internet mustang ' +
    'michael jennifer jordan hunter killer pokemon cheese summer winter spring autumn india bharat mumbai delhi ' +
    'ganesh krishna sairam omsairam jaishreeram iloveu lovely loveyou charlie donald flower naruto samsung ' +
    'company office business manager employee user username'
  ).split(/\s+/),
)

export interface PasswordProblem {
  code: 'PASSWORD_WEAK'
  message: string
}

/** null when acceptable; otherwise the first problem (messages are shown under the field). */
export function checkPassword(pw: string, opts: { min?: number; email?: string | null } = {}): PasswordProblem | null {
  const min = Math.max(PASSWORD_FLOOR, opts.min ?? 10)
  const p = String(pw ?? '')
  if (p.length < min) return { code: 'PASSWORD_WEAK', message: `Use at least ${min} characters.` }
  if (p.length > PASSWORD_MAX) return { code: 'PASSWORD_WEAK', message: `Use at most ${PASSWORD_MAX} characters.` }
  const lower = p.toLowerCase()
  const base = lower.replace(/[^a-z]+$/, '').replace(/^[^a-z]+/, '')
  if (COMMON.has(lower) || COMMON.has(base) || /^(.)\1+$/.test(p) || /^(0123456789|1234567890|abcdefghij|qwertyuiop)+$/.test(lower))
    return { code: 'PASSWORD_WEAK', message: 'This password is too common. Choose something harder to guess.' }
  // context-specific: the e-mail itself, or the username part with only digits/symbols around it ("ritika@123")
  const email = String(opts.email ?? '').toLowerCase()
  const local = email.split('@')[0].replace(/[^a-z]/g, '')
  if (email && (lower === email || (local.length >= 3 && base === local))) return { code: 'PASSWORD_WEAK', message: 'Don’t use your email address as your password.' }
  return null
}
