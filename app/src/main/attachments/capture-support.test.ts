import { isCaptureSupported } from './capture-support'

describe('isCaptureSupported (#456)', () => {
  it('is available on macOS only', () => {
    expect(isCaptureSupported('darwin')).toBe(true)
    expect(isCaptureSupported('win32')).toBe(false)
    expect(isCaptureSupported('linux')).toBe(false)
  })
})
