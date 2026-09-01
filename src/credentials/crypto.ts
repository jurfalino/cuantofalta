const IV_BYTES = 12

const b64encode = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const b64decode = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

async function importKey(keyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64decode(keyBase64), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function generateKeyBase64(): Promise<string> {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)))
}

export async function encryptToken(plain: string, keyBase64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await importKey(keyBase64),
    new TextEncoder().encode(plain),
  )
  const out = new Uint8Array(iv.length + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), iv.length)
  return b64encode(out)
}

export async function decryptToken(cipher: string, keyBase64: string): Promise<string> {
  const raw = b64decode(cipher)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, IV_BYTES) },
    await importKey(keyBase64),
    raw.slice(IV_BYTES),
  )
  return new TextDecoder().decode(pt)
}
