import { describe, it, expect } from 'vitest'
import { getInstanceId } from './instanceId'

describe('getInstanceId', () => {
  it('generates instance ID from conversation ID and attachment URL', () => {
    const result = getInstanceId(
      'user@example.com',
      'https://example.com/files/game.xdc'
    )
    expect(result).toBe('user@example.com:https://example.com/files/game.xdc')
  })

  it('handles room JID for group chats', () => {
    const result = getInstanceId(
      'room@conference.example.com',
      'https://example.com/files/poll.xdc'
    )
    expect(result).toBe('room@conference.example.com:https://example.com/files/poll.xdc')
  })

  it('produces unique IDs for same file in different conversations', () => {
    const url = 'https://example.com/files/app.xdc'
    const id1 = getInstanceId('chat1@example.com', url)
    const id2 = getInstanceId('chat2@example.com', url)
    expect(id1).not.toBe(id2)
  })
})
