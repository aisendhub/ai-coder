import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

// AES-256-GCM at-rest encryption for provider tokens. The DB stores base64
// blobs; only the server reads plaintext. Rotate INTEGRATIONS_KEY to revoke
// all stored tokens in one step.
//
// Stored blob layout: [12-byte IV][16-byte auth tag][ciphertext]. Concatenated
// and base64-encoded before going to the DB.

const ALGO = "aes-256-gcm"
const IV_LEN = 12
const TAG_LEN = 16

function loadKey(): Buffer {
  const raw = process.env.INTEGRATIONS_KEY
  if (!raw) {
    throw new Error(
      "INTEGRATIONS_KEY env var is required to encrypt/decrypt provider tokens. " +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    )
  }
  // Accept either a raw base64 32-byte key or any string (we hash to derive
  // a 32-byte key). Hashing means short passphrases work, at the cost of some
  // brute-force resistance — users should still prefer a real 32-byte key.
  try {
    const decoded = Buffer.from(raw, "base64")
    if (decoded.length === 32) return decoded
  } catch { /* fall through */ }
  return createHash("sha256").update(raw).digest()
}

let keyCache: Buffer | null = null
function key(): Buffer {
  if (!keyCache) keyCache = loadKey()
  return keyCache
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString("base64")
}

export function decryptToken(blob: string): string {
  const buf = Buffer.from(blob, "base64")
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("token blob too short — corrupt or wrong key")
  }
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const enc = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")
}
