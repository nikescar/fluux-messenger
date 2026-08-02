import { describe, it, expect } from 'vitest'
import { sanitizeFilename } from './sanitizeFilename'

describe('sanitizeFilename', () => {
  it('allows safe filenames', () => {
    expect(sanitizeFilename('index.html')).toBe('index.html')
    expect(sanitizeFilename('app.js')).toBe('app.js')
    expect(sanitizeFilename('icon.png')).toBe('icon.png')
    expect(sanitizeFilename('my-app_v2.css')).toBe('my-app_v2.css')
  })

  it('rejects path traversal attempts', () => {
    expect(sanitizeFilename('../etc/passwd')).toBeNull()
    expect(sanitizeFilename('../../secret.txt')).toBeNull()
    expect(sanitizeFilename('.././../bad')).toBeNull()
  })

  it('rejects absolute paths', () => {
    expect(sanitizeFilename('/etc/passwd')).toBeNull()
    expect(sanitizeFilename('/home/user/file.txt')).toBeNull()
    expect(sanitizeFilename('\\Windows\\System32\\cmd.exe')).toBeNull()
  })

  it('rejects null bytes', () => {
    expect(sanitizeFilename('file\0.txt')).toBeNull()
    expect(sanitizeFilename('index.html\0')).toBeNull()
  })

  it('rejects empty filenames', () => {
    expect(sanitizeFilename('')).toBeNull()
    expect(sanitizeFilename('   ')).toBeNull()
  })

  it('allows subdirectories', () => {
    expect(sanitizeFilename('css/style.css')).toBe('css/style.css')
    expect(sanitizeFilename('images/icon.png')).toBe('images/icon.png')
  })

  it('normalizes Unicode', () => {
    // NFKC normalization
    expect(sanitizeFilename('café.txt')).toBe('café.txt')
  })
})
