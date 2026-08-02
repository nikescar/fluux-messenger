import { describe, it, expect } from 'vitest'
import { parseManifest } from './parseManifest'

describe('parseManifest', () => {
  it('parses valid TOML manifest', () => {
    const toml = `
name = "Chess Game"
icon = "icon.png"
min_api = 1
source_code_url = "https://github.com/example/chess"
`
    const result = parseManifest(toml, 'chess.xdc')
    expect(result).toEqual({
      name: 'Chess Game',
      icon: 'icon.png',
      min_api: 1,
      source_code_url: 'https://github.com/example/chess'
    })
  })

  it('returns defaults for missing fields', () => {
    const toml = 'name = "Simple App"'
    const result = parseManifest(toml, 'app.xdc')
    expect(result.name).toBe('Simple App')
    expect(result.icon).toBeUndefined()
    expect(result.min_api).toBeUndefined()
  })

  it('uses filename as fallback when name missing', () => {
    const toml = '# Empty manifest'
    const result = parseManifest(toml, 'mygame.xdc')
    expect(result.name).toBe('mygame.xdc')
  })

  it('handles malformed TOML gracefully', () => {
    const toml = 'invalid [ toml = syntax'
    const result = parseManifest(toml, 'broken.xdc')
    expect(result.name).toBe('broken.xdc')
    expect(result.icon).toBeUndefined()
  })

  it('handles empty TOML', () => {
    const toml = ''
    const result = parseManifest(toml, 'empty.xdc')
    expect(result.name).toBe('empty.xdc')
  })
})
