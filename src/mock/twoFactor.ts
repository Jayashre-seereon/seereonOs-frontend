// Two-step verification state and checks shared by the sign-in routes (auth.ts) and the /me/2fa routes (people.ts).
// The state lives in `pending_tokens` rows (DB-backed, multi-instance safe):
//   two_factor_setup  {secret, attempts}           a started setup, 30 min
//   two_factor        TwoFactorPayload              the active factor of a user (no expiry)
//   mfa_login         {attempts}                    a sign-in waiting for its second step, 5 min, id = SHA-256(token)
// Secrets are sealed with the installed SecretBox (AES-256-GCM on the server); recovery codes are stored hashed.
import type * as E from '@/types/entities'
import { getDb, nowISO, persist, type PendingToken } from './server'
import { openSecret } from './secrets'
import { constantTimeEqual, hashRecoveryCode, normalizeRecoveryCode, verifyTotp } from '@/domain/totp'

export const MFA_LOGIN_MINUTES = 5
export const MFA_MAX_ATTEMPTS = 5
export const TWO_FACTOR_SETUP_MINUTES = 30
export const TWO_FACTOR_SETUP_ATTEMPTS = 5
export const FAR_FUTURE = '9999-12-31T00:00:00.000Z'

export interface TwoFactorPayload {
  /** sealed base32 TOTP secret */
  secret: string
  /** per-user salt of the recovery-code hashes */
  salt: string
  /** SHA-256 hashes of the unused recovery codes */
  recovery: string[]
  /** last accepted TOTP time step (a code is accepted once) */
  last_step: number | null
  /** consecutive wrong codes on authenticated checks (disable / new recovery codes) */
  fails: number
  enabled_at: string
}

export function twoFactorRecord(user: E.User): (PendingToken & { payload: TwoFactorPayload }) | null {
  return (getDb().pending_tokens.find((t) => t.kind === 'two_factor' && t.user_id === user.id && t.tenant_id === user.tenant_id) as (PendingToken & { payload: TwoFactorPayload }) | undefined) ?? null
}

export function touch(t: PendingToken, payload: unknown) {
  t.payload = payload
  t.updated_at = nowISO()
  t.version++
  persist()
}

/**
 * Checks a TOTP code or a recovery code against the user's active factor. On success the code is consumed (TOTP step
 * remembered; recovery code removed) and the kind is returned; null when wrong. Never throws.
 */
export function useSecondFactor(rec: PendingToken & { payload: TwoFactorPayload }, input: { code?: unknown; recovery_code?: unknown }): 'totp' | 'recovery' | null {
  const p = rec.payload
  const code = String(input.code ?? '').replace(/\s/g, '')
  const rc = normalizeRecoveryCode(String(input.recovery_code ?? ''))
  if (code) {
    const secret = openSecret(p.secret)
    const step = secret ? verifyTotp(secret, code, { afterStep: p.last_step }) : null
    if (step === null) return null
    touch(rec, { ...p, last_step: step, fails: 0 })
    return 'totp'
  }
  if (rc.length >= 8) {
    const h = hashRecoveryCode(p.salt, rc)
    let hit = -1
    p.recovery.forEach((x, i) => {
      if (constantTimeEqual(x, h) && hit < 0) hit = i
    })
    if (hit < 0) return null
    touch(rec, { ...p, recovery: p.recovery.filter((_, i) => i !== hit), fails: 0 })
    return 'recovery'
  }
  return null
}
