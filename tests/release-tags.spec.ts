import { describe, expect, it } from 'vitest'
import { releaseTagFailures } from '../scripts/release/tags.mjs'

describe('release dist-tag verification', () => {
  it('accepts npm latest on the first prerelease line', () => {
    expect(
      releaseTagFailures('0.2.0-alpha.1', ['0.2.0-alpha.0', '0.2.0-alpha.1'], {
        latest: '0.2.0-alpha.0',
        next: '0.2.0-alpha.1',
      }),
    ).toEqual([])
  })

  it('preserves an existing stable latest tag', () => {
    expect(
      releaseTagFailures('0.3.0-alpha.0', ['0.2.0', '0.3.0-alpha.0'], {
        latest: '0.2.0',
        next: '0.3.0-alpha.0',
      }),
    ).toEqual([])
  })

  it('rejects a prerelease latest after a stable version exists', () => {
    expect(
      releaseTagFailures('1.0.0-beta.0', ['0.9.0', '1.0.0-beta.0'], {
        latest: '1.0.0-beta.0',
        next: '1.0.0-beta.0',
      }),
    ).toEqual(['latest must remain on a stable version'])
  })

  it('requires stable releases on latest', () => {
    expect(releaseTagFailures('1.0.0', ['1.0.0'], { next: '1.0.0' })).toEqual(['latest must point to 1.0.0'])
  })
})
