/**
 * THE ARTIFACT'S DRAFT SCREENS (discovery `ui_drafts`, FR-11/FR-12). A
 * walkthrough step names a draft screen with an empty
 * `<div data-flow-draft="<canvas>/<screen>"></div>`; when main serves the page
 * it replaces each one with a framed preview of that screen, loaded live from
 * the drafts host, with its title above it — and a small amber badge when the
 * screen is not the version the plan read.
 *
 * It is a SERVER-SIDE transform on purpose: the page runs sandboxed in an
 * opaque origin and cannot ask Flow anything, and the agent that writes a page
 * should only name a screen, never build a frame or an address (allowed-pattern
 * #14 — the address rule is `draftPageUrl`, the path rule is `resolveDraftPath`,
 * the hash is the CLI's own module).
 *
 * Everything is async and bounded (#19): the layout and each distinct screen are
 * read once per request, and the plan folder is listed only when a page has
 * slots. A slot that cannot be shown becomes a quiet box, never a thrown error.
 */
import { join } from 'path'

import { draftPageUrl, resolveDraftPath, type DraftLayout } from '../../shared/ui-drafts'
import { readDraftLayout } from './draft-store'
import {
  DRAFT_SLOT_ATTRIBUTE,
  findDraftSlots,
  newestPlanFor,
  parseDraftScreensBlock,
  screenChangedSincePlan,
  type DraftScreenRecord,
} from './draft-screens'

/** Said in the place of a screen that has no file (or a slot that names none). */
export const DRAFT_SCREEN_MISSING_TEXT = 'This screen is not drawn yet.'

/** The badge beside a title when the screen differs from the plan's record. */
export const DRAFT_SCREEN_CHANGED_TEXT = 'Changed since the plan'

export interface ArtifactSlotDeps {
  readFile: (absPath: string) => Promise<string>
  /** File names in a folder; absent or failing reads as an empty folder. */
  readDir?: (absPath: string) => Promise<string[]>
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const BOX_STYLE =
  'margin:12px 0;border:1px solid var(--border,rgba(128,128,128,.35));border-radius:10px;padding:10px;max-width:100%;overflow:hidden'
const TITLE_STYLE = 'font:600 13px system-ui,sans-serif;color:var(--text,inherit)'
const BADGE_STYLE =
  'margin-left:8px;padding:1px 8px;border-radius:999px;font:600 11px system-ui,sans-serif;background:rgba(245,158,11,.2);color:#b45309'
const QUIET_STYLE = 'font:13px system-ui,sans-serif;color:var(--muted,#888)'

function missingBox(): string {
  return `<div data-flow-draft-missing style="${BOX_STYLE};${QUIET_STYLE}">${DRAFT_SCREEN_MISSING_TEXT}</div>`
}

function screenBox(src: string, title: string, frame: { w: number; h: number }, changed: boolean): string {
  const safeTitle = escapeHtml(title)
  const badge = changed ? `<span data-flow-draft-changed style="${BADGE_STYLE}">${DRAFT_SCREEN_CHANGED_TEXT}</span>` : ''
  return (
    `<figure data-flow-draft-screen style="${BOX_STYLE};margin-inline:0">` +
    `<figcaption style="margin:0 0 8px">` +
    `<span style="${TITLE_STYLE}">${safeTitle}</span>${badge}</figcaption>` +
    `<iframe sandbox="allow-scripts" src="${escapeHtml(src)}" title="${safeTitle}" loading="lazy" ` +
    `style="display:block;border:0;background:#fff;width:${frame.w}px;max-width:100%;aspect-ratio:${frame.w} / ${frame.h}"></iframe>` +
    `</figure>`
  )
}

/** The plan folder an artifact page's plan lives in: plans for a live page, the archive for an archived one. */
function planFolderFor(pagePath: string): string {
  return pagePath.startsWith('flow/archive/') ? 'flow/archive' : 'flow/plans'
}

async function plannedScreens(root: string, pagePath: string, deps: ArtifactSlotDeps): Promise<DraftScreenRecord[]> {
  if (deps.readDir === undefined) return []
  const folder = planFolderFor(pagePath)
  const pageName = pagePath.slice(pagePath.lastIndexOf('/') + 1)
  let names: string[]
  try {
    names = await deps.readDir(join(root, folder))
  } catch {
    return []
  }
  const plan = newestPlanFor(pageName, names)
  if (plan === null) return []
  try {
    return parseDraftScreensBlock(await deps.readFile(join(root, folder, plan)))
  } catch {
    return []
  }
}

/**
 * Resolve every draft slot of a walkthrough page. A page with no slot is
 * returned untouched, without a single read.
 */
export async function resolveArtifactDraftSlots(
  html: string,
  root: string,
  pagePath: string,
  deps: ArtifactSlotDeps,
): Promise<string> {
  if (!html.includes(DRAFT_SLOT_ATTRIBUTE)) return html
  const slots = findDraftSlots(html)
  if (slots.length === 0) return html
  const records = await plannedScreens(root, pagePath, deps)
  const layouts = new Map<string, Promise<DraftLayout | null>>()
  const layoutOf = (canvas: string): Promise<DraftLayout | null> => {
    let hit = layouts.get(canvas)
    if (hit === undefined) {
      hit = readDraftLayout(deps.readFile, root, canvas).then((answer) => (answer.ok ? answer.layout : null))
      layouts.set(canvas, hit)
    }
    return hit
  }
  const boxes = await Promise.all(
    slots.map(async (slot): Promise<string> => {
      if (!slot.valid) return missingBox()
      const file = resolveDraftPath(root, slot.canvas, `${slot.screen}.html`)
      if (!file.ok || file.kind !== 'screen') return missingBox()
      let current: string
      try {
        current = await deps.readFile(join(root, file.relPath))
      } catch {
        return missingBox()
      }
      const layout = await layoutOf(slot.canvas)
      const ref = layout?.screens.find((screen) => screen.id === slot.screen)
      const frame = ref?.frame ?? { w: 390, h: 844 }
      const src = draftPageUrl({ kind: 'screen', root, canvas: slot.canvas, screen: slot.screen, mode: 'framed' })
      return screenBox(
        src,
        ref?.title ?? slot.screen,
        frame,
        screenChangedSincePlan(records, slot.canvas, slot.screen, current),
      )
    }),
  )
  // Replace from the end, so earlier offsets stay true.
  let out = html
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    const slot = slots[i]!
    out = out.slice(0, slot.index) + boxes[i]! + out.slice(slot.index + slot.raw.length)
  }
  return out
}

/**
 * The page as it is SHARED off this machine: every draft slot removed. A shared
 * copy is served by the share host, which has no drafts host to frame a screen
 * from, so a slot there could only ever be an empty box. Dropping it leaves the
 * step's own words and nothing broken. A page with no slot is returned as is.
 */
export function withoutDraftSlots(html: string): string {
  if (!html.includes(DRAFT_SLOT_ATTRIBUTE)) return html
  const slots = findDraftSlots(html)
  let out = html
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    const slot = slots[i]!
    out = out.slice(0, slot.index) + out.slice(slot.index + slot.raw.length)
  }
  return out
}
