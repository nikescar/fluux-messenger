/**
 * Send file or text from WebXDC app to messenger chat.
 */

import { invoke } from '@tauri-apps/api/core'

interface SendToChatOptions {
  conversationId: string
  text?: string
  file?: {
    name: string
    blob?: Blob
    base64?: string
  }
}

interface SendToChatResult {
  success: boolean
}

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB

/**
 * Send to chat - exports content from WebXDC to messenger.
 */
export async function sendToChat(options: SendToChatOptions): Promise<SendToChatResult> {
  // Validate conversationId
  if (!options.conversationId || options.conversationId.trim() === '') {
    throw new Error('conversationId required')
  }

  // Validate that either text or file is provided
  if (!options.text && !options.file) {
    throw new Error('text or file required')
  }

  // Validate text if provided without file
  if (options.text === '' && !options.file) {
    throw new Error('text or file required')
  }

  // Handle file upload
  if (options.file) {
    if (!options.file.name || options.file.name.trim() === '') {
      throw new Error('file name required')
    }

    let base64Data: string

    // Validate file content and convert to base64
    if (options.file.blob) {
      // Check file size
      if (options.file.blob.size > MAX_FILE_SIZE) {
        throw new Error('file size exceeds 100MB limit')
      }

      // Convert blob to base64
      base64Data = await blobToBase64(options.file.blob)
    } else if (options.file.base64 !== undefined) {
      // Validate base64 content
      if (options.file.base64.trim() === '') {
        throw new Error('file content required')
      }

      // Validate base64 encoding
      if (!isValidBase64(options.file.base64)) {
        throw new Error('invalid base64')
      }

      base64Data = options.file.base64
    } else {
      throw new Error('file blob or base64 required')
    }

    // Send to Tauri backend via IPC
    await invoke('webxdc_send_to_chat', {
      conversationId: options.conversationId,
      fileName: options.file.name,
      fileData: base64Data,
      text: options.text || null
    })
  } else {
    // Text only
    await invoke('webxdc_send_to_chat', {
      conversationId: options.conversationId,
      fileName: null,
      fileData: null,
      text: options.text
    })
  }

  return { success: true }
}

/**
 * Convert Blob to base64 string.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        // Remove data URL prefix
        const base64 = reader.result.split(',')[1]
        resolve(base64)
      } else {
        reject(new Error('Failed to convert blob to base64'))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read blob'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Validate base64 string.
 */
function isValidBase64(str: string): boolean {
  try {
    // Try to decode - if it fails, it's not valid base64
    atob(str)
    return true
  } catch {
    return false
  }
}
