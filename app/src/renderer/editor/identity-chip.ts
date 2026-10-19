/**
 * Identity chip (conflict-UX Phase 4) — the DOM adapter for a compact, truthful
 * label of ONE side of a merge conflict.
 *
 * `buildIdentityChip` renders a small chip: a primary label (branch / ref /
 * short hash / fallback), the author, and a relative time, tinted with the
 * side-A or side-B two-side accent from the theme tokens. When the side's author
 * is the repo's current user the author reads "you".
 *
 * All label logic lives in the DOM-free `identity-chip-parts` module (so it
 * unit-tests without a DOM); this file is the thin renderer reused by the inline
 * resolver's per-hunk header and, later, the confirm step. The label rule never
 * emits ours / theirs / current / incoming — see identity-chip-parts.
 */
import { identityChipParts, type IdentityChipOptions } from './identity-chip-parts'
import type { SideIdentity } from '../../shared/side-identity'

export {
  identityChipParts,
  relativeTimeFrom,
  sideDisplayLabel,
  type ConflictSide,
  type IdentityChipOptions,
  type IdentityChipParts,
} from './identity-chip-parts'

const CHIP_CLASS = 'fl-identity-chip'
const CHIP_DOT_CLASS = 'fl-identity-chip-dot'
const CHIP_PRIMARY_CLASS = 'fl-identity-chip-primary'
const CHIP_META_CLASS = 'fl-identity-chip-meta'

/**
 * Build a compact chip element for one conflict side. The side accent tints the
 * leading dot and the primary label; author + relative time render as muted
 * meta. Reused by the inline resolver's per-hunk header and the confirm step.
 */
export function buildIdentityChip(
  identity: SideIdentity | undefined,
  options: IdentityChipOptions,
): HTMLElement {
  injectChipStyles()
  const parts = identityChipParts(identity, options)

  const chip = document.createElement('span')
  chip.className = CHIP_CLASS
  chip.dataset.side = options.side

  const dot = document.createElement('span')
  dot.className = CHIP_DOT_CLASS
  chip.appendChild(dot)

  const primary = document.createElement('span')
  primary.className = CHIP_PRIMARY_CLASS
  primary.textContent = parts.primary
  chip.appendChild(primary)

  const metaText = [parts.author, parts.relativeTime].filter(Boolean).join(' · ')
  if (metaText) {
    const meta = document.createElement('span')
    meta.className = CHIP_META_CLASS
    meta.textContent = metaText
    chip.appendChild(meta)
  }

  return chip
}

let chipStylesInjected = false

/** Inject the chip styles once. Both accents come from the theme tokens so the
 *  chip and the editor decorations share one two-side scheme. */
function injectChipStyles(): void {
  if (chipStylesInjected) return
  chipStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .${CHIP_CLASS} {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      max-width: 100%;
      padding: 2px var(--fl-space-sm);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
    }
    .${CHIP_CLASS}[data-side='a'] { background: var(--fl-color-conflict-side-a-bg); }
    .${CHIP_CLASS}[data-side='b'] { background: var(--fl-color-conflict-side-b-bg); }
    .${CHIP_DOT_CLASS} {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .${CHIP_CLASS}[data-side='a'] .${CHIP_DOT_CLASS} { background: var(--fl-color-conflict-side-a); }
    .${CHIP_CLASS}[data-side='b'] .${CHIP_DOT_CLASS} { background: var(--fl-color-conflict-side-b); }
    .${CHIP_PRIMARY_CLASS} {
      font-weight: var(--fl-text-ui-weight-medium);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${CHIP_CLASS}[data-side='a'] .${CHIP_PRIMARY_CLASS} { color: var(--fl-color-conflict-side-a); }
    .${CHIP_CLASS}[data-side='b'] .${CHIP_PRIMARY_CLASS} { color: var(--fl-color-conflict-side-b); }
    .${CHIP_META_CLASS} { color: var(--fl-color-text-secondary); }
  `
  document.head.appendChild(style)
}
