import { describe, it, expect, afterEach } from 'vitest'
import { extractXdc } from './extractXdc'
import { zipSync } from 'fflate'
import { readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('extractXdc', () => {
  const testDir = join(tmpdir(), 'fluux-webxdc-test')

  afterEach(async () => {
    // Cleanup test extractions
    await rm(testDir, { recursive: true, force: true })
  })

  it('extracts valid webxdc ZIP', async () => {
    const zip = zipSync({
      'index.html': new TextEncoder().encode('<h1>Hello</h1>'),
      'manifest.toml': new TextEncoder().encode('name = "Test App"'),
      'icon.png': new Uint8Array([137, 80, 78, 71])
    })

    const result = await extractXdc(
      zip,
      'test@example.com:https://example.com/app.xdc',
      'app.xdc'
    )

    expect(result.extractPath).toContain('fluux-webxdc')
    expect(result.manifest.name).toBe('Test App')

    const files = await readdir(result.extractPath)
    expect(files).toContain('index.html')
    expect(files).toContain('manifest.toml')
    expect(files).toContain('icon.png')
  })

  it('rejects ZIP without index.html', async () => {
    const zip = zipSync({
      'app.js': new TextEncoder().encode('console.log("no index")')
    })

    await expect(
      extractXdc(zip, 'test:url', 'app.xdc')
    ).rejects.toThrow('index.html not found')
  })

  it('handles missing manifest.toml gracefully', async () => {
    const zip = zipSync({
      'index.html': new TextEncoder().encode('<h1>No manifest</h1>')
    })

    const result = await extractXdc(zip, 'test:url', 'noManifest.xdc')
    expect(result.manifest.name).toBe('noManifest.xdc')
  })

  it('rejects path traversal in ZIP entries', async () => {
    const zip = zipSync({
      'index.html': new TextEncoder().encode('<h1>Safe</h1>'),
      '../../../etc/passwd': new TextEncoder().encode('hacked')
    })

    await expect(
      extractXdc(zip, 'test:url', 'malicious.xdc')
    ).rejects.toThrow('Unsafe filename detected')
  })

  it('extracts to instance-specific directory', async () => {
    const zip = zipSync({
      'index.html': new TextEncoder().encode('<h1>Test</h1>')
    })

    const instanceId = 'room@example.com:https://example.com/game.xdc'
    const result = await extractXdc(zip, instanceId, 'game.xdc')

    expect(result.extractPath).toContain('room@example.com')
  })
})
