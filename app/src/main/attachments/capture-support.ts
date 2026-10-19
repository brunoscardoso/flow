// Screenshot-capture platform gate (#456). Native interactive region capture uses
// macOS `screencapture -i`, which is darwin-only; other platforms keep paste /
// drag-drop / file-picker. Pure so the renderer can hide the affordance and the
// handler can refuse off-platform without touching `process` in a test.

/** Whether native screenshot region capture is available on this platform. */
export function isCaptureSupported(platform: NodeJS.Platform | string): boolean {
  return platform === 'darwin'
}
