// Two-step verification primitives shared by the browser demo (src/mock) and the API server.
// RFC 6238 TOTP (HMAC-SHA-1, 30 s step, 6 digits) over an RFC 4648 base32 secret, plus SHA-256 for hashing
// single-use recovery codes and sign-in challenge tokens.
//
// Pure JavaScript and SYNCHRONOUS on purpose: the shared route handlers are synchronous (they run inside a Unit of
// Work on the server), so Web Crypto's async digest cannot be used there. Randomness comes from
// crypto.getRandomValues (Web Crypto; global in browsers and Node 19+). The implementation is verified against the
// RFC 6238 appendix B vectors (backend/tests/unit/test_totp_rfc.py on the Python port, golden-tested against this file).

/* ---------------- bytes ---------------- */
const enc = new TextEncoder()
export const utf8 = (s: string) => enc.encode(s)
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** cryptographically random bytes */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  globalThis.crypto.getRandomValues(b)
  return b
}

/** 32 random bytes as base64url (43 chars) — opaque bearer-style tokens */
export function randomToken(bytes = 32): string {
  const b = randomBytes(bytes)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** comparison whose running time does not depend on where the inputs differ */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0) // out of range → NaN | 0 = 0
  return diff === 0
}

/* ---------------- SHA-1 / SHA-256 / HMAC ---------------- */
const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n))
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** Merkle–Damgård padding into 64-byte blocks (big-endian bit length) */
function pad(msg: Uint8Array): DataView {
  const len = msg.length
  const total = (((len + 9 + 63) >> 6) << 6) >>> 0
  const buf = new Uint8Array(total)
  buf.set(msg)
  buf[len] = 0x80
  const dv = new DataView(buf.buffer)
  const bits = len * 8
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000))
  dv.setUint32(total - 4, bits >>> 0)
  return dv
}

export function sha1(msg: Uint8Array): Uint8Array {
  const dv = pad(msg)
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const w = new Int32Array(80)
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let i = 0; i < 80; i++) {
      let f: number, k: number
      if (i < 20) (f = (b & c) | (~b & d)), (k = 0x5a827999)
      else if (i < 40) (f = b ^ c ^ d), (k = 0x6ed9eba1)
      else if (i < 60) (f = (b & c) | (b & d) | (c & d)), (k = 0x8f1bbcdc)
      else (f = b ^ c ^ d), (k = 0xca62c1d6)
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = t
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }
  const out = new DataView(new ArrayBuffer(20))
  ;[h0, h1, h2, h3, h4].forEach((h, i) => out.setInt32(i * 4, h))
  return new Uint8Array(out.buffer)
}

const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256(msg: Uint8Array): Uint8Array {
  const dv = pad(msg)
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Int32Array(64)
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K256[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
    h[5] = (h[5] + f) | 0
    h[6] = (h[6] + g) | 0
    h[7] = (h[7] + hh) | 0
  }
  const out = new DataView(new ArrayBuffer(32))
  h.forEach((x, i) => out.setInt32(i * 4, x))
  return new Uint8Array(out.buffer)
}

export const sha256Hex = (s: string) => toHex(sha256(utf8(s)))

function hmac(hash: (m: Uint8Array) => Uint8Array, key: Uint8Array, msg: Uint8Array): Uint8Array {
  const B = 64
  let k = key.length > B ? hash(key) : key
  const kk = new Uint8Array(B)
  kk.set(k)
  k = kk
  const inner = new Uint8Array(B + msg.length)
  const outer = new Uint8Array(B + (hash === sha1 ? 20 : 32))
  for (let i = 0; i < B; i++) {
    inner[i] = k[i] ^ 0x36
    outer[i] = k[i] ^ 0x5c
  }
  inner.set(msg, B)
  outer.set(hash(inner), B)
  return hash(outer)
}
export const hmacSha1 = (key: Uint8Array, msg: Uint8Array) => hmac(sha1, key, msg)
export const hmacSha256 = (key: Uint8Array, msg: Uint8Array) => hmac(sha256, key, msg)

/* ---------------- base32 (RFC 4648, no padding) ---------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32Encode(b: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const x of b) {
    value = (value << 8) | x
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
/** decodes base32 (case-insensitive; spaces, dashes and padding ignored); null when invalid */
export function base32Decode(s: string): Uint8Array | null {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0, value = 0
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) return null
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/* ---------------- TOTP (RFC 6238) ---------------- */
export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6
export const TOTP_WINDOW = 1 // ±1 step accepted (clock drift)

/** HOTP (RFC 4226) for a counter, `digits` long */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS, hash: 'sha1' | 'sha256' = 'sha1'): string {
  const msg = new Uint8Array(8)
  const dv = new DataView(msg.buffer)
  dv.setUint32(0, Math.floor(counter / 0x100000000))
  dv.setUint32(4, counter >>> 0)
  const mac = hash === 'sha1' ? hmacSha1(key, msg) : hmacSha256(key, msg)
  const o = mac[mac.length - 1] & 0x0f
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export const totpStep = (timeMs: number, step = TOTP_STEP_SECONDS) => Math.floor(timeMs / 1000 / step)

/** the code for a base32 secret at a time */
export function totp(secretB32: string, timeMs = Date.now(), digits = TOTP_DIGITS): string {
  const key = base32Decode(secretB32)
  if (!key) throw new Error('invalid base32 secret')
  return hotp(key, totpStep(timeMs), digits)
}

/**
 * Verifies a 6-digit code against the secret within ±`window` steps. Returns the matched time step, or null.
 * `afterStep`: steps ≤ this value are refused (a code may be used only once — replay protection).
 */
export function verifyTotp(secretB32: string, code: string, opts: { now?: number; window?: number; afterStep?: number | null } = {}): number | null {
  const c = String(code ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) return null
  const key = base32Decode(secretB32)
  if (!key || !key.length) return null
  const now = totpStep(opts.now ?? Date.now())
  const w = opts.window ?? TOTP_WINDOW
  let matched: number | null = null
  // check every step in the window (no early exit) so the timing does not reveal which step matched
  for (let s = now - w; s <= now + w; s++) if (constantTimeEqual(hotp(key, s), c) && matched === null && (opts.afterStep == null || s > opts.afterStep)) matched = s
  return matched
}

/** a new 160-bit secret (RFC 4226 recommends ≥ 128, 160 is the SHA-1 block-friendly default) */
export const newTotpSecret = () => base32Encode(randomBytes(20))

/** otpauth:// key URI (Google Authenticator format) for QR codes / "open in app" */
export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const i = encodeURIComponent(issuer)
  return `otpauth://totp/${i}:${encodeURIComponent(account)}?secret=${secret}&issuer=${i}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
}

/* ---------------- recovery codes ---------------- */
export const RECOVERY_CODE_COUNT = 10
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789' // no 0/o, 1/l/i
/** ten codes like "k7m2q-x9p4t" (50 bits each) */
export function newRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const out: string[] = []
  while (out.length < n) {
    const b = randomBytes(10)
    let s = ''
    for (const x of b) s += RC_ALPHABET[x % RC_ALPHABET.length]
    const code = s.slice(0, 5) + '-' + s.slice(5)
    if (!out.includes(code)) out.push(code)
  }
  return out
}
export const normalizeRecoveryCode = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
/** stored form: SHA-256 over a per-user salt and the normalised code (codes have ≥ 50 bits of entropy, are single-use
 * and attempts are rate-limited, so a fast hash is adequate) */
export const hashRecoveryCode = (salt: string, code: string) => sha256Hex('rc1:' + salt + ':' + normalizeRecoveryCode(code))
