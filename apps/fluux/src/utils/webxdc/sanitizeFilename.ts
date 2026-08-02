/**
 * Sanitize ZIP entry filename to prevent path traversal attacks.
 *
 * Security requirements:
 * - Block ../ traversal
 * - Block absolute paths (/, \)
 * - Block null bytes
 * - Normalize Unicode (NFKC)
 * - Allow relative paths (subdirectories)
 *
 * @param filename - ZIP entry filename
 * @returns Sanitized filename or null if unsafe
 */
export function sanitizeFilename(filename: string): string | null {
  if (!filename || filename.trim().length === 0) {
    return null
  }

  // Normalize Unicode to prevent evasion via different representations
  const normalized = filename.normalize('NFKC')

  // Reject null bytes (file system attacks)
  if (normalized.includes('\0')) {
    return null
  }

  // Reject absolute paths
  if (normalized.startsWith('/') || normalized.startsWith('\\') || /^[A-Za-z]:/.test(normalized)) {
    return null
  }

  // Reject path traversal
  const parts = normalized.split(/[/\\]/)
  if (parts.some(part => part === '..' || part === '.')) {
    return null
  }

  return normalized
}
