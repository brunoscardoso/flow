import { draftPageUrl } from '../../shared/ui-drafts'
import { attachDraftFramePicker, injectFramePicker, isCanvasScreenFrame, type InjectableFrame } from './draft-frame-inject'

const ROOT = '/Users/me/shop'
const canvasUrl = `${draftPageUrl({ kind: 'canvas', root: ROOT, canvas: 'pay' })}#view=1,0,0`
const framed = draftPageUrl({ kind: 'screen', root: ROOT, canvas: 'pay', screen: 'payment', mode: 'framed' }, 3)

function frame(url: string, parent: InjectableFrame | null, run: (code: string) => Promise<unknown> = async () => true): InjectableFrame {
  return { url, parent, executeJavaScript: jest.fn(run) }
}

describe('isCanvasScreenFrame', () => {
  const canvas = frame(canvasUrl, null)
  it('is a framed screen whose parent is the canvas of the same project and canvas', () => {
    expect(isCanvasScreenFrame(frame(framed, canvas))).toBe(true)
  })
  it('is not the canvas itself, a screen open alone, another canvas, or an ordinary page', () => {
    expect(isCanvasScreenFrame(canvas)).toBe(false)
    expect(isCanvasScreenFrame(frame(draftPageUrl({ kind: 'screen', root: ROOT, canvas: 'pay', screen: 'payment', mode: 'single' }), canvas))).toBe(false)
    const other = frame(draftPageUrl({ kind: 'canvas', root: ROOT, canvas: 'other' }), null)
    expect(isCanvasScreenFrame(frame(framed, other))).toBe(false)
    expect(isCanvasScreenFrame(frame('https://example.com/', canvas))).toBe(false)
    expect(isCanvasScreenFrame(frame(framed, null))).toBe(false)
  })
})

describe('injectFramePicker', () => {
  const canvas = frame(canvasUrl, null)
  it('runs the picker in a canvas screen frame', async () => {
    const target = frame(framed, canvas)
    await expect(injectFramePicker(target)).resolves.toBe(true)
    expect((target.executeJavaScript as jest.Mock).mock.calls[0][0]).toContain('__flowDraftPicker')
  })
  it('never runs it anywhere else', async () => {
    const target = frame('https://example.com/', canvas)
    await expect(injectFramePicker(target)).resolves.toBe(false)
    expect(target.executeJavaScript).not.toHaveBeenCalled()
  })
  it('is bounded: a frame that never answers does not hold the caller', async () => {
    const target = frame(framed, canvas, () => new Promise(() => undefined))
    await expect(injectFramePicker(target, 20)).resolves.toBe(true)
  })
  it('a failing frame is logged, not thrown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const target = frame(framed, canvas, () => Promise.reject(new Error('gone')))
    await expect(injectFramePicker(target)).resolves.toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('attachDraftFramePicker', () => {
  it('injects on each sub-frame load, never on the main frame', async () => {
    let listener: ((event: unknown, isMain: boolean, pid: number, rid: number) => void) | null = null
    const guest = { on: jest.fn((_name: string, fn: typeof listener) => { listener = fn }), isDestroyed: () => false }
    const target = frame(framed, frame(canvasUrl, null))
    const byId = jest.fn(() => target)
    attachDraftFramePicker(guest, byId)
    expect(guest.on).toHaveBeenCalledWith('did-frame-finish-load', expect.any(Function))
    listener!({}, true, 1, 1)
    expect(byId).not.toHaveBeenCalled()
    listener!({}, false, 4, 7)
    expect(byId).toHaveBeenCalledWith(4, 7)
    await Promise.resolve()
    expect(target.executeJavaScript).toHaveBeenCalledTimes(1)
  })
})
