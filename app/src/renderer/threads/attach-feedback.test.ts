import { attachedWhileHiddenToast } from './attach-feedback'

describe('attachedWhileHiddenToast (#366)', () => {
  it('names the attached reference and explains when it will appear, at info level', () => {
    const toast = attachedWhileHiddenToast('src')
    expect(toast.title).toBe('Attached to chat')
    expect(toast.body).toContain('src')
    expect(toast.body).toMatch(/open or start a chat/i)
    expect(toast.level).toBe('info')
  })
})
