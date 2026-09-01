import { describe, it, expect } from 'vitest'
import { encryptToken, decryptToken, generateKeyBase64 } from './crypto'

describe('token encryption', () => {
  it('round-trips a token', async () => {
    const key = await generateKeyBase64()
    const cipher = await encryptToken('APP_USR-12345', key)
    expect(await decryptToken(cipher, key)).toBe('APP_USR-12345')
  })

  it('does not leak the plaintext into the ciphertext', async () => {
    const key = await generateKeyBase64()
    const cipher = await encryptToken('APP_USR-12345', key)
    expect(cipher).not.toContain('APP_USR')
  })

  it('produces a different ciphertext each time for the same input', async () => {
    const key = await generateKeyBase64()
    expect(await encryptToken('same', key)).not.toBe(await encryptToken('same', key))
  })

  it('fails to decrypt with the wrong key rather than returning garbage', async () => {
    const cipher = await encryptToken('secret', await generateKeyBase64())
    await expect(decryptToken(cipher, await generateKeyBase64())).rejects.toThrow()
  })
})
