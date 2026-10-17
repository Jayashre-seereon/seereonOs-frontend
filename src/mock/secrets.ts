// Sealing of secrets the shared logic must store but never show again (TOTP keys). The browser demo keeps them as
// they are (prefix "plain:"); the API server installs an AES-256-GCM box keyed from MFA_ENCRYPTION_KEY
// (backend/app/auth/secret_box.py), so a database dump or backup alone does not reveal anyone's second factor.
export interface SecretBox {
  seal(plain: string): string
  /** null when the value cannot be opened (wrong key, tampered, unknown format) */
  open(sealed: string): string | null
}

const plainBox: SecretBox = {
  seal: (p) => 'plain:' + p,
  open: (s) => (typeof s === 'string' && s.startsWith('plain:') ? s.slice(6) : null),
}
let box: SecretBox = plainBox

export function setSecretBox(b: SecretBox | null) {
  box = b ?? plainBox
}
export const sealSecret = (plain: string) => box.seal(plain)
export const openSecret = (sealed: unknown) => (typeof sealed === 'string' ? box.open(sealed) : null)
