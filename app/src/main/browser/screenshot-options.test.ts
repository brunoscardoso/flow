jest.mock('electron', () => ({}))
import { screenshotOptions } from './screenshot'

describe('screenshotOptions', () => {
  it('keeps a box (whole pixels, never above the page) and a one-line name', () => {
    expect(screenshotOptions({ rect: { x: -4.5, y: 10.2, width: 100.4, height: 50 }, fileName: 'Picture of\nPayment' })).toEqual({
      rect: { x: 0, y: 10, width: 96, height: 51 },
      fileName: 'Picture of Payment',
    })
  })
  it('drops what is not readable', () => {
    expect(screenshotOptions({})).toEqual({})
    expect(screenshotOptions(null)).toEqual({})
    expect(screenshotOptions({ rect: { x: 0, y: 0, width: Number.NaN, height: 1 }, fileName: '' })).toEqual({})
    expect(screenshotOptions({ rect: { x: 0, y: 0, width: 0, height: 10 } })).toEqual({})
    expect(screenshotOptions({ fileName: 'x'.repeat(200) })).toEqual({})
  })
})
