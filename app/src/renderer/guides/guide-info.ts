/**
 * THE (i) BESIDE A FEATURE — how a person asks for a tour (user, 2026-11-23:
 * "the user is focused on the input, he will not click on that icon … we can
 * have some like (i) icon on main features").
 *
 * A toolbar "?" asks the person to leave what they are looking at. The (i)
 * sits ON the thing, where their eyes already are. Pressing it runs that
 * feature's tour, with tips on or off.
 *
 * `ids` lists the tours this spot can mean, most specific first: on the
 * Blueprint the same (i) explains an open block, a feature's diagram, or the
 * map, depending on what is on screen when it is pressed.
 */
import { pickGuide, tourById, type GuideId } from '../../shared/guides'
import { firstOnScreen } from './guide-dom'

const STYLE_ID = 'fl-guide-info-styles'
const CSS = `
.fl-guide-info {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0; margin: 0 2px; border: none; border-radius: 50%;
  background: transparent; color: var(--fl-color-text-secondary); cursor: pointer; opacity: 0.75;
  vertical-align: middle;
}
.fl-guide-info:hover { opacity: 1; color: var(--fl-color-accent); background: var(--fl-color-accent-soft); }
.fl-guide-info:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; opacity: 1; }
.fl-guide-info svg { display: block; }
`

const SVG_NS = 'http://www.w3.org/2000/svg'

function infoIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  const circle = document.createElementNS(SVG_NS, 'circle')
  circle.setAttribute('cx', '8')
  circle.setAttribute('cy', '8')
  circle.setAttribute('r', '6.5')
  circle.setAttribute('fill', 'none')
  circle.setAttribute('stroke', 'currentColor')
  circle.setAttribute('stroke-width', '1.3')
  const stem = document.createElementNS(SVG_NS, 'path')
  stem.setAttribute('d', 'M8 7.2v4')
  stem.setAttribute('stroke', 'currentColor')
  stem.setAttribute('stroke-width', '1.5')
  stem.setAttribute('stroke-linecap', 'round')
  const dot = document.createElementNS(SVG_NS, 'circle')
  dot.setAttribute('cx', '8')
  dot.setAttribute('cy', '4.9')
  dot.setAttribute('r', '0.95')
  dot.setAttribute('fill', 'currentColor')
  svg.append(circle, stem, dot)
  return svg
}

export function guideInfoButton(ids: GuideId | readonly GuideId[], what: string): HTMLButtonElement {
  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }
  const list = typeof ids === 'string' ? [ids] : ids
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'fl-guide-info'
  button.dataset['guideInfo'] = list.join(' ')
  button.title = `How ${what} works`
  button.setAttribute('aria-label', `How ${what} works`)
  button.appendChild(infoIcon())
  // A press must not reach what the (i) sits on: a header that collapses, a
  // field that would take focus, a panel that closes on an outside press.
  button.addEventListener('mousedown', (event) => event.stopPropagation())
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const id = pickGuide(list, (candidate) => firstOnScreen(tourById(candidate).trigger) !== null)
    if (id !== null) document.dispatchEvent(new CustomEvent('flow:guide-replay', { detail: { id } }))
  })
  return button
}
