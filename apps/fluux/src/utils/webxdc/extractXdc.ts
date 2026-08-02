import { unzipSync } from 'fflate'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { sanitizeFilename } from './sanitizeFilename'
import { parseManifest, type WebxdcManifest } from './parseManifest'

/**
 * Extracted webxdc app data
 */
export interface ExtractedXdc {
  extractPath: string
  manifest: WebxdcManifest
}

/**
 * Extract webxdc .xdc ZIP file to temporary directory.
 *
 * Validates structure (index.html required), sanitizes filenames,
 * and parses manifest. Extracts to instance-specific directory
 * for isolation.
 *
 * @param xdcBytes - Raw .xdc file bytes
 * @param instanceId - Instance identifier (conversationId:attachmentUrl)
 * @param filename - Original filename (for manifest fallback)
 * @returns Extraction path and parsed manifest
 * @throws Error if invalid structure or unsafe filenames
 */
export async function extractXdc(
  xdcBytes: Uint8Array,
  instanceId: string,
  filename: string
): Promise<ExtractedXdc> {
  // Unzip in memory
  const files = unzipSync(xdcBytes)

  // Validate index.html exists
  if (!('index.html' in files)) {
    throw new Error('Invalid webxdc: index.html not found')
  }

  // Generate extraction path: $TEMP/fluux-webxdc/{conversationId}/{hash}/
  const [conversationId, attachmentUrl] = instanceId.split(':')
  const hash = createHash('sha256').update(attachmentUrl).digest('hex').slice(0, 16)
  const extractPath = join(tmpdir(), 'fluux-webxdc', conversationId, hash)

  // Create extraction directory
  await mkdir(extractPath, { recursive: true })

  // Extract files with sanitization
  let manifestContent = ''
  for (const [path, content] of Object.entries(files)) {
    const sanitized = sanitizeFilename(path)
    if (!sanitized) {
      throw new Error(`Unsafe filename detected: ${path}`)
    }

    const targetPath = join(extractPath, sanitized)

    // Create parent directories if needed
    const parentDir = join(targetPath, '..')
    await mkdir(parentDir, { recursive: true })

    // Write file
    await writeFile(targetPath, content)

    // Capture manifest for parsing
    if (sanitized === 'manifest.toml') {
      manifestContent = new TextDecoder().decode(content)
    }
  }

  // Parse manifest (or use defaults)
  const manifest = parseManifest(manifestContent, filename)

  return { extractPath, manifest }
}
