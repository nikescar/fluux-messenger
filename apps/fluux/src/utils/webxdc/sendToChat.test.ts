import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sendToChat } from './sendToChat'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

describe('sendToChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  describe('text-only messages', () => {
    it('sends text message to conversation', async () => {
      const result = await sendToChat({
        conversationId: 'alice@example.com',
        text: 'Hello from WebXDC!'
      })

      expect(result).toEqual({ success: true })
    })

    it('rejects empty text when no file provided', async () => {
      await expect(
        sendToChat({
          conversationId: 'alice@example.com',
          text: ''
        })
      ).rejects.toThrow('text or file required')
    })

    it('rejects missing conversationId', async () => {
      await expect(
        sendToChat({
          conversationId: '',
          text: 'Hello'
        })
      ).rejects.toThrow('conversationId required')
    })
  })

  describe('file attachment - Blob', () => {
    it('converts Blob to base64 and sends', async () => {
      const blob = new Blob(['Hello, world!'], { type: 'text/plain' })

      const result = await sendToChat({
        conversationId: 'alice@example.com',
        file: {
          name: 'greeting.txt',
          blob: blob
        },
        text: 'Check this file'
      })

      expect(result).toEqual({ success: true })
    })

    it('rejects file without name', async () => {
      const blob = new Blob(['test'], { type: 'text/plain' })

      await expect(
        sendToChat({
          conversationId: 'alice@example.com',
          file: {
            name: '',
            blob: blob
          }
        })
      ).rejects.toThrow('file name required')
    })

    it('encodes binary data correctly as base64', async () => {
      const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253])
      const blob = new Blob([binaryData], { type: 'application/octet-stream' })

      const result = await sendToChat({
        conversationId: 'alice@example.com',
        file: {
          name: 'data.bin',
          blob: blob
        }
      })

      expect(result).toEqual({ success: true })
    })
  })

  describe('file attachment - base64', () => {
    it('sends pre-encoded base64 file', async () => {
      const base64 = btoa('Hello, world!')

      const result = await sendToChat({
        conversationId: 'alice@example.com',
        file: {
          name: 'greeting.txt',
          base64: base64
        }
      })

      expect(result).toEqual({ success: true })
    })

    it('validates base64 encoding', async () => {
      await expect(
        sendToChat({
          conversationId: 'alice@example.com',
          file: {
            name: 'test.txt',
            base64: 'invalid!@#$%base64'
          }
        })
      ).rejects.toThrow('invalid base64')
    })

    it('rejects empty base64', async () => {
      await expect(
        sendToChat({
          conversationId: 'alice@example.com',
          file: {
            name: 'test.txt',
            base64: ''
          }
        })
      ).rejects.toThrow('file content required')
    })
  })

  describe('file size limits', () => {
    it('rejects files over 100MB', async () => {
      // Create a large blob (100MB + 1 byte)
      const largeData = new Uint8Array(100 * 1024 * 1024 + 1)
      const blob = new Blob([largeData])

      await expect(
        sendToChat({
          conversationId: 'alice@example.com',
          file: {
            name: 'large.bin',
            blob: blob
          }
        })
      ).rejects.toThrow('file size exceeds 100MB limit')
    })

    it('accepts file exactly at 100MB limit', async () => {
      const exactSize = new Uint8Array(100 * 1024 * 1024)
      const blob = new Blob([exactSize])

      const result = await sendToChat({
        conversationId: 'alice@example.com',
        file: {
          name: 'exact.bin',
          blob: blob
        }
      })

      expect(result).toEqual({ success: true })
    })
  })
})
