import {
  bootDemo,
  activateChat,
  scrollToBottom,
  newMsgStuck,
  AT_BOTTOM_OK_PX,
} from '../helpers/demoHelpers.js'

const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0'
const AVA = 'ava@fluux.chat'

describe('At-bottom stick (WebDriverIO)', () => {
  it('plain: incoming message while at bottom stays visible', async () => {
    await bootDemo(DEMO_URL)
    await activateChat(AVA)
    await scrollToBottom()

    // Inject incoming message with same-day timestamp
    const id = `incoming-plain-${Date.now()}`
    await browser.execute(([jid, msgId]: [string, string]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore
      const st = cs.getState()
      const msgs = (st.messages.get(jid) ?? []).slice()
      msgs.push({
        type: 'chat',
        conversationId: jid,
        from: jid,
        to: 'me@fluux.chat',
        id: msgId,
        body: 'test incoming message',
        isOutgoing: false,
        timestamp: new Date(Date.now()),
      })
      const m = new Map(st.messages)
      m.set(jid, msgs)
      cs.setState({ messages: m })
    }, [AVA, id])

    // Wait for the message to appear in DOM
    const msgEl = await $(`[data-message-id="${id}"]`)
    await msgEl.waitForDisplayed({ timeout: 5000 })
    await browser.pause(400)

    // Verify message is visible and stuck to bottom
    const res = await newMsgStuck(id)
    await expect(res.visible).toBe(true)
    await expect(res.distFromBottom).toBeLessThan(AT_BOTTOM_OK_PX)
  })
})
