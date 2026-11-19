import { draftPageUrl } from '../../shared/ui-drafts'
import { draftPanelTarget, inspectRoute } from './draft-inspect-model'

const ROOT = '/Users/me/shop'
const canvas = `${draftPageUrl({ kind: 'canvas', root: ROOT, canvas: 'pay' })}#view=1,0,0`
const single = draftPageUrl({ kind: 'screen', root: ROOT, canvas: 'pay', screen: 'payment', mode: 'single' })

describe('inspectRoute', () => {
  it('sends the toggle to the canvas on a canvas page, to the stock picker elsewhere', () => {
    expect(inspectRoute(canvas)).toBe('canvas')
    expect(inspectRoute(single)).toBe('page')
    expect(inspectRoute('http://localhost:3000/')).toBe('page')
    expect(inspectRoute(null)).toBe('page')
  })
})

describe('draftPanelTarget', () => {
  it('takes the project and canvas from the address, the screen from the canvas', () => {
    expect(draftPanelTarget(canvas, 'payment')).toEqual({ rootPath: ROOT, canvas: 'pay', screen: 'payment', view: 'canvas' })
  })
  it('in the single view, only the screen the address names', () => {
    expect(draftPanelTarget(single, 'payment')).toEqual({ rootPath: ROOT, canvas: 'pay', screen: 'payment', view: 'single' })
    expect(draftPanelTarget(single, 'home')).toBeNull()
  })
  it('nothing on a page that is not a draft', () => {
    expect(draftPanelTarget('http://localhost:3000/', 'payment')).toBeNull()
    expect(draftPanelTarget(null, 'payment')).toBeNull()
  })
})
