import { describe, it, expect, beforeEach, vi } from 'vitest'
import { importFiles } from './importFiles'

describe('importFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('basic file import', () => {
    it('imports single file', async () => {
      // Mock file picker to return a file
      const mockFile = new File(['test content'], 'test.txt', { type: 'text/plain' })

      const files = await importFiles({
        multiple: false
      }, [mockFile])

      expect(files).toHaveLength(1)
      expect(files[0].name).toBe('test.txt')
      expect(files[0].type).toBe('text/plain')
    })

    it('imports multiple files', async () => {
      const mockFiles = [
        new File(['test 1'], 'file1.txt', { type: 'text/plain' }),
        new File(['test 2'], 'file2.txt', { type: 'text/plain' })
      ]

      const files = await importFiles({
        multiple: true
      }, mockFiles)

      expect(files).toHaveLength(2)
      expect(files[0].name).toBe('file1.txt')
      expect(files[1].name).toBe('file2.txt')
    })

    it('returns empty array when user cancels', async () => {
      const files = await importFiles({
        multiple: false
      }, []) // Empty array simulates cancel

      expect(files).toHaveLength(0)
    })
  })

  describe('file type filtering', () => {
    it('filters by MIME type', async () => {
      const mockFiles = [
        new File(['image'], 'photo.jpg', { type: 'image/jpeg' })
      ]

      const files = await importFiles({
        mimeTypes: ['image/jpeg', 'image/png'],
        multiple: false
      }, mockFiles)

      expect(files).toHaveLength(1)
      expect(files[0].type).toBe('image/jpeg')
    })

    it('filters by extension', async () => {
      const mockFiles = [
        new File(['doc'], 'document.pdf', { type: 'application/pdf' })
      ]

      const files = await importFiles({
        extensions: ['.pdf', '.doc'],
        multiple: false
      }, mockFiles)

      expect(files).toHaveLength(1)
      expect(files[0].name).toBe('document.pdf')
    })

    it('combines MIME type and extension filters', async () => {
      const mockFiles = [
        new File(['image'], 'photo.png', { type: 'image/png' })
      ]

      const files = await importFiles({
        mimeTypes: ['image/png'],
        extensions: ['.png'],
        multiple: false
      }, mockFiles)

      expect(files).toHaveLength(1)
    })
  })

  describe('file reading', () => {
    it('reads file content as text', async () => {
      const content = 'Hello, WebXDC!'
      const mockFile = new File([content], 'hello.txt', { type: 'text/plain' })

      const files = await importFiles({
        multiple: false
      }, [mockFile])

      const text = await files[0].text()
      expect(text).toBe(content)
    })

    it('reads file content as ArrayBuffer', async () => {
      const content = new Uint8Array([1, 2, 3, 4, 5])
      const mockFile = new File([content], 'data.bin', { type: 'application/octet-stream' })

      const files = await importFiles({
        multiple: false
      }, [mockFile])

      const buffer = await files[0].arrayBuffer()
      const view = new Uint8Array(buffer)

      expect(view).toEqual(content)
    })

    it('provides file size', async () => {
      const content = 'X'.repeat(1000)
      const mockFile = new File([content], 'large.txt', { type: 'text/plain' })

      const files = await importFiles({
        multiple: false
      }, [mockFile])

      expect(files[0].size).toBe(1000)
    })
  })

  describe('error handling', () => {
    it('rejects invalid MIME type format', async () => {
      await expect(
        importFiles({
          mimeTypes: ['invalid_mime'],
          multiple: false
        }, [])
      ).rejects.toThrow('invalid MIME type format')
    })

    it('rejects invalid extension format', async () => {
      await expect(
        importFiles({
          extensions: ['txt'], // Missing dot
          multiple: false
        }, [])
      ).rejects.toThrow('extension must start with dot')
    })

    it('limits files to 1 when multiple is false', async () => {
      const mockFiles = [
        new File(['1'], 'file1.txt'),
        new File(['2'], 'file2.txt')
      ]

      const files = await importFiles({
        multiple: false
      }, mockFiles)

      expect(files).toHaveLength(1)
    })
  })

  describe('edge cases', () => {
    it('handles empty file', async () => {
      const mockFile = new File([], 'empty.txt', { type: 'text/plain' })

      const files = await importFiles({
        multiple: false
      }, [mockFile])

      expect(files).toHaveLength(1)
      expect(files[0].size).toBe(0)
    })

    it('handles file with special characters in name', async () => {
      const mockFile = new File(['test'], 'file with spaces & special.txt', { type: 'text/plain' })

      const files = await importFiles({
        multiple: false
      }, [mockFile])

      expect(files[0].name).toBe('file with spaces & special.txt')
    })

    it('handles empty filter arrays', async () => {
      const mockFile = new File(['test'], 'test.txt', { type: 'text/plain' })

      const files = await importFiles({
        mimeTypes: [],
        extensions: [],
        multiple: false
      }, [mockFile])

      expect(files).toHaveLength(1)
    })
  })
})
