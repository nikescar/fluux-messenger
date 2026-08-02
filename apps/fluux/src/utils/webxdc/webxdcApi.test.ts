import { describe, it, expect } from 'vitest'
import { generateWebxdcApiScript } from './webxdcApi'

describe('generateWebxdcApiScript', () => {
  it('generates script with instance ID', () => {
    const script = generateWebxdcApiScript(
      'chat@example.com:https://example.com/app.xdc',
      'user@example.com',
      'Alice'
    )
    expect(script).toContain('chat@example.com:https://example.com/app.xdc')
  })

  it('includes selfAddr and selfName', () => {
    const script = generateWebxdcApiScript(
      'test:url',
      'alice@example.com',
      'Alice Smith'
    )
    expect(script).toContain('alice@example.com')
    expect(script).toContain('Alice Smith')
  })

  it('defines window.webxdc object', () => {
    const script = generateWebxdcApiScript('test:url', 'user@ex.com', 'User')
    expect(script).toContain('window.webxdc')
    expect(script).toContain('sendUpdate')
    expect(script).toContain('setUpdateListener')
    expect(script).toContain('getAllUpdates')
  })

  it('validates payload is JSON-serializable', () => {
    const script = generateWebxdcApiScript('test:url', 'u@ex.com', 'U')
    expect(script).toContain('JSON.stringify')
  })

  it('uses __TAURI__.invoke for IPC', () => {
    const script = generateWebxdcApiScript('test:url', 'u@ex.com', 'U')
    expect(script).toContain('__TAURI__.invoke')
    expect(script).toContain('webxdc_send_update')
  })
})
