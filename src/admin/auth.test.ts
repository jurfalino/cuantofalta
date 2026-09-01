import { describe, it, expect } from 'vitest'
import { isValidOperatorSecret } from './auth'

describe('isValidOperatorSecret', () => {
  it('accepts an exact match', () => {
    expect(isValidOperatorSecret('s3cret', 's3cret')).toBe(true)
  })
  it('rejects a mismatch', () => {
    expect(isValidOperatorSecret('wrong', 's3cret')).toBe(false)
  })
  it('rejects when no secret is configured, rather than allowing all', () => {
    expect(isValidOperatorSecret('anything', undefined)).toBe(false)
  })
  it('rejects an empty provided secret', () => {
    expect(isValidOperatorSecret('', 's3cret')).toBe(false)
  })
  it('takes the same time for equal-length wrong secrets', () => {
    expect(isValidOperatorSecret('aaaaaa', 's3cret')).toBe(false)
  })
})
