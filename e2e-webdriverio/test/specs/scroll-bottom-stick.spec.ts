import { bootDemo, activateChat, scrollToBottom } from '../helpers/demoHelpers.js'

const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0'
const AVA = 'ava@fluux.chat'

describe('At-bottom stick (WebDriverIO)', () => {
  it('should boot the demo successfully', async () => {
    await bootDemo(DEMO_URL)

    // Verify the app shell loaded
    const nav = await $('[data-nav="messages"]')
    await expect(nav).toBeDisplayed()
  })

  it('should activate chat and scroll to bottom', async () => {
    await bootDemo(DEMO_URL)
    await activateChat(AVA)

    // Verify chat is active
    const hash = await browser.execute(() => window.location.hash)
    await expect(hash).toContain(encodeURIComponent(AVA))

    await scrollToBottom()

    // Verify scrolled to bottom
    const distFromBottom = await browser.execute(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return -1
      return s.scrollHeight - s.scrollTop - s.clientHeight
    })
    await expect(distFromBottom).toBeLessThan(5) // Should be at exact bottom
  })
})
