import { errorText, redoFailedToast, sendFailedToast } from './redo-feedback'

describe('errorText', () => {
  it('reads an Error message, and degrades unknown throws gracefully', () => {
    expect(errorText(new Error('session not ready'))).toBe('session not ready')
    expect(errorText('boom')).toBe('boom')
    expect(errorText({})).toBe('Unknown error') // avoids "[object Object]"
  })
})

describe('redoFailedToast (#180)', () => {
  it('names the file and carries the error at error level', () => {
    expect(redoFailedToast('src/app.ts', new Error('thread busy'))).toEqual({
      title: "Couldn't send redo request",
      body: "The agent didn't receive your redo of src/app.ts — thread busy. Try again.",
      level: 'error',
    })
  })
})

describe('sendFailedToast (#279)', () => {
  it('says the message was not delivered and carries the error at error level', () => {
    expect(sendFailedToast(new Error('session not ready'))).toEqual({
      title: "Couldn't send message",
      body: "session not ready — your message wasn't delivered. Try again.",
      level: 'error',
    })
  })
})
