import { isSessionPlanFile } from './path-containment'

const CONFIG = '/Users/me/.flow/accounts/7d24'

describe('isSessionPlanFile — plan mode may write its own plan, nothing else', () => {
  it('allows a Markdown file directly in the config dir plans folder', () => {
    expect(isSessionPlanFile(`${CONFIG}/plans/fancy-noodling-leaf.md`, CONFIG, 'darwin')).toBe(true)
  })

  it.each([
    ['another file type', `${CONFIG}/plans/run.sh`],
    ['a subfolder', `${CONFIG}/plans/deep/x.md`],
    ['a climb out', `${CONFIG}/plans/../settings.md`],
    ['the config dir itself', `${CONFIG}/settings.md`],
    ['a look-alike folder', `${CONFIG}/plans-evil/x.md`],
    ['a relative path', 'plans/x.md'],
    ['another account', '/Users/me/.flow/accounts/other/plans/x.md'],
  ])('refuses %s', (_label, path) => {
    expect(isSessionPlanFile(path, CONFIG, 'darwin')).toBe(false)
  })

  it('refuses a missing path', () => {
    expect(isSessionPlanFile(null, CONFIG, 'darwin')).toBe(false)
  })

  it('matches case-insensitively on Windows only', () => {
    expect(isSessionPlanFile('C:\\Users\\me\\.claude\\PLANS\\a.md', 'C:\\Users\\me\\.claude', 'win32')).toBe(true)
    expect(isSessionPlanFile(`${CONFIG}/PLANS/a.md`, CONFIG, 'darwin')).toBe(false)
  })
})
