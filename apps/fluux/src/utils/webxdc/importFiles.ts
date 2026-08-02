/**
 * Import files from messenger into WebXDC app.
 */

import { invoke, convertFileSrc } from '@tauri-apps/api/core'

interface ImportFilesOptions {
  extensions?: string[]
  mimeTypes?: string[]
  multiple?: boolean
}

/**
 * Import files from the messenger.
 *
 * In testing, mockFiles can be provided to simulate user file selection.
 * In production, this would trigger native file picker via Tauri.
 */
export async function importFiles(
  options: ImportFilesOptions,
  mockFiles?: File[]
): Promise<File[]> {
  // Validate MIME types
  if (options.mimeTypes) {
    for (const mimeType of options.mimeTypes) {
      if (!mimeType.includes('/')) {
        throw new Error('invalid MIME type format')
      }
    }
  }

  // Validate extensions
  if (options.extensions) {
    for (const ext of options.extensions) {
      if (!ext.startsWith('.')) {
        throw new Error('extension must start with dot')
      }
    }
  }

  // In test mode, use mock files
  if (mockFiles !== undefined) {
    // Filter files based on options
    let filtered = mockFiles

    // Apply MIME type filter if provided and not empty
    if (options.mimeTypes && options.mimeTypes.length > 0) {
      filtered = filtered.filter(file => options.mimeTypes!.includes(file.type))
    }

    // Apply extension filter if provided and not empty
    if (options.extensions && options.extensions.length > 0) {
      filtered = filtered.filter(file => {
        const ext = '.' + file.name.split('.').pop()
        return options.extensions!.includes(ext)
      })
    }

    // Limit to single file if multiple is false
    if (options.multiple === false && filtered.length > 1) {
      filtered = [filtered[0]]
    }

    return filtered
  }

  // Production mode - call Tauri file picker
  const filePaths = await invoke<string[]>('webxdc_import_files', {
    extensions: options.extensions || [],
    mimeTypes: options.mimeTypes || [],
    multiple: options.multiple !== false
  })

  // Convert file paths to File objects
  const files: File[] = []
  for (const path of filePaths) {
    const url = convertFileSrc(path)
    const response = await fetch(url)
    const blob = await response.blob()
    const fileName = path.split('/').pop() || 'file'
    files.push(new File([blob], fileName, { type: blob.type }))
  }

  return files
}
