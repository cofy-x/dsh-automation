import { describe, expect, it } from 'vitest'
import { planReleaseTags } from '../scripts/release/tags.mjs'

describe('release dist-tag planning', () => {
  it('removes an automatically-created latest tag from a first prerelease', () => {
    expect(
      planReleaseTags('0.2.0-alpha.0', ['0.2.0-alpha.0'], {
        latest: '0.2.0-alpha.0',
        next: '0.2.0-alpha.0',
      }),
    ).toEqual([{ action: 'remove', tag: 'latest' }])
  })

  it('preserves an existing stable latest tag', () => {
    expect(
      planReleaseTags('0.3.0-alpha.0', ['0.2.0', '0.3.0-alpha.0'], {
        latest: '0.2.0',
        next: '0.3.0-alpha.0',
      }),
    ).toEqual([])
  })

  it('restores latest to the highest stable version', () => {
    expect(
      planReleaseTags('1.0.0-beta.0', ['0.9.0', '0.10.0', '1.0.0-beta.0'], {
        latest: '1.0.0-beta.0',
      }),
    ).toEqual([
      { action: 'add', tag: 'next', version: '1.0.0-beta.0' },
      { action: 'add', tag: 'latest', version: '0.10.0' },
    ])
  })

  it('points a stable release at latest', () => {
    expect(planReleaseTags('1.0.0', ['1.0.0'], {})).toEqual([{ action: 'add', tag: 'latest', version: '1.0.0' }])
  })
})
