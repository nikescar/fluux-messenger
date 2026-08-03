import { bootDemo } from '../helpers/demoHelpers.js'

const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0'

describe('At-bottom stick (WebDriverIO)', () => {
  it('should boot the demo successfully', async () => {
    await bootDemo(DEMO_URL)

    // Verify the app shell loaded
    const nav = await $('[data-nav="messages"]')
    await expect(nav).toBeDisplayed()
  })
})
