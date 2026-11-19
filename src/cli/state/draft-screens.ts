/**
 * DRAFT SCREENS IN A PLAN — what a plan records about the draft screens its
 * discovery's artifact showed, and how a screen is told to have changed since.
 *
 * ONE MODULE, TWO READERS (allowed-pattern #14). `plan screens` (the one writer
 * of the block) and the app (which badges a screen "Changed since the plan")
 * both import this file, so the strip, the hash and the block's shape cannot
 * disagree. The app re-exports it from `app/src/main/drafts/draft-screens.ts`,
 * the precedent being `understood.ts`. Pure over its inputs: no filesystem.
 *
 *   artifact page:  <div data-flow-draft="<canvas>/<screen>"></div>
 *   plan block:     ## Draft screens
 *                   - <canvas>/<screen> · sha256:<hex>
 *
 * The hash is taken over the screen's HTML with every `data-flow-id` attribute
 * removed: Flow stamps those ids onto a screen, and stamping is not a change a
 * person made. The block is written once, when the plan is created; the plan's
 * own hash covers the plan's content, so a screen changing later never moves it.
 */
import { createHash } from 'node:crypto';

/** The attribute a walkthrough step names a draft screen with. */
export const DRAFT_SLOT_ATTRIBUTE = 'data-flow-draft';

/** The heading of the plan block. */
export const DRAFT_SCREENS_HEADING = '## Draft screens';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Whether `value` is a canvas or screen slug (the same rule the drafts store uses). */
export function isDraftScreenSlug(value: string): boolean {
  return SLUG.test(value);
}

/** One screen a walkthrough step names. */
export interface DraftSlot {
  canvas: string;
  screen: string;
  /** The whole element as written — what a server replaces. */
  raw: string;
  /** Where it starts in the page. */
  index: number;
}

const SLOT_ELEMENT = /<div\b[^>]*?\sdata-flow-draft\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>\s*<\/div>/gi;

/** `canvas/screen` as a pair, or null when it is not two slugs. */
export function parseSlotTarget(value: string): { canvas: string; screen: string } | null {
  const parts = value.trim().split('/');
  if (parts.length !== 2) return null;
  const [canvas, screen] = parts as [string, string];
  return isDraftScreenSlug(canvas) && isDraftScreenSlug(screen) ? { canvas, screen } : null;
}

/**
 * Every slot of a page, in order. A slot whose value is not `canvas/screen` is
 * returned with `canvas`/`screen` empty and `valid: false` so a server can show
 * its quiet box instead of leaving the element bare.
 */
export function findDraftSlots(html: string): Array<DraftSlot & { valid: boolean }> {
  const slots: Array<DraftSlot & { valid: boolean }> = [];
  for (const match of html.matchAll(SLOT_ELEMENT)) {
    const target = parseSlotTarget(match[1] ?? match[2] ?? '');
    slots.push({
      canvas: target?.canvas ?? '',
      screen: target?.screen ?? '',
      raw: match[0],
      index: match.index ?? 0,
      valid: target !== null,
    });
  }
  return slots;
}

/** The distinct valid screens a page names, in first-seen order. */
export function draftScreensOf(html: string): Array<{ canvas: string; screen: string }> {
  const seen = new Set<string>();
  const out: Array<{ canvas: string; screen: string }> = [];
  for (const slot of findDraftSlots(html)) {
    if (!slot.valid) continue;
    const key = `${slot.canvas}/${slot.screen}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ canvas: slot.canvas, screen: slot.screen });
  }
  return out;
}

const ID_ATTRIBUTE = /\sdata-flow-id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/** A screen's HTML without Flow's stamped ids. */
export function stripDraftIds(html: string): string {
  return html.replace(ID_ATTRIBUTE, '');
}

/** `sha256:<hex>` over a screen's stripped content. */
export function hashDraftScreen(html: string): string {
  return `sha256:${createHash('sha256').update(stripDraftIds(html), 'utf8').digest('hex')}`;
}

// ── The plan's block ─────────────────────────────────────────────────────

export interface DraftScreenRecord {
  canvas: string;
  screen: string;
  hash: string;
}

const RECORD_LINE = /^-\s+([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\s+·\s+(sha256:[0-9a-f]{64})\s*$/;

/** Text of the block for these records. */
export function renderDraftScreensBlock(records: readonly DraftScreenRecord[]): string {
  const lines = records.map((record) => `- ${record.canvas}/${record.screen} · ${record.hash}`);
  return `${DRAFT_SCREENS_HEADING}\n${lines.join('\n')}\n`;
}

/** The records a plan holds, or an empty list when it has no block. */
export function parseDraftScreensBlock(planText: string): DraftScreenRecord[] {
  const lines = planText.split('\n');
  const start = lines.findIndex((line) => line.trim() === DRAFT_SCREENS_HEADING);
  if (start < 0) return [];
  const records: DraftScreenRecord[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line) || line.trim() === '---') break;
    const match = RECORD_LINE.exec(line.trim());
    if (match !== null) records.push({ canvas: match[1] as string, screen: match[2] as string, hash: match[3] as string });
  }
  return records;
}

/** Where the block goes: before the first line after `## Intent` that ends it. */
function insertionLine(lines: readonly string[]): number {
  const intent = lines.findIndex((line) => /^##\s+Intent\s*$/.test(line));
  const from = intent < 0 ? 0 : intent + 1;
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '---' || /^#{1,6}\s/.test(line)) return i;
  }
  return lines.length;
}

/**
 * The plan with its `## Draft screens` block written or replaced, placed after
 * `## Intent`. Replacing removes the old block only (its heading to the next
 * heading or rule) and leaves every other byte alone. No records removes the
 * block.
 */
export function upsertDraftScreensBlock(planText: string, records: readonly DraftScreenRecord[]): string {
  let lines = planText.split('\n');
  const old = lines.findIndex((line) => line.trim() === DRAFT_SCREENS_HEADING);
  if (old >= 0) {
    let end = old + 1;
    while (end < lines.length) {
      const line = lines[end] as string;
      if (/^#{1,6}\s/.test(line) || line.trim() === '---') break;
      end += 1;
    }
    lines = [...lines.slice(0, old), ...lines.slice(end)];
  }
  if (records.length === 0) return lines.join('\n');
  const at = insertionLine(lines);
  // Keep a blank line before the block and one after it.
  let before = lines.slice(0, at);
  while (before.length > 0 && (before[before.length - 1] as string).trim() === '') before = before.slice(0, -1);
  const block = renderDraftScreensBlock(records).trimEnd().split('\n');
  const after = lines.slice(at);
  const joined = [...before, ...(before.length > 0 ? [''] : []), ...block, '', ...after];
  return joined.join('\n');
}

// ── Which plan belongs to a page ─────────────────────────────────────────

const PAGE_NAME = /^discovery_(.+?)(?:_v(\d+))?\.walkthrough\.html$/;
const PLAN_NAME = /^plan_(.+?)(?:_v(\d+))?\.md$/;

/**
 * The newest plan written from the discovery whose artifact is `pageName`: the
 * same feature, a version not older than the discovery's — the same rule the
 * artifact card uses (`planWrittenFromDocument`), over file names.
 */
export function newestPlanFor(pageName: string, planNames: readonly string[]): string | null {
  const page = PAGE_NAME.exec(pageName);
  if (page === null) return null;
  const feature = page[1] as string;
  const pageVersion = page[2] === undefined ? 1 : Number(page[2]);
  let best: { name: string; version: number } | null = null;
  for (const name of planNames) {
    const plan = PLAN_NAME.exec(name);
    if (plan === null || plan[1] !== feature) continue;
    const version = plan[2] === undefined ? 1 : Number(plan[2]);
    if (version < pageVersion) continue;
    if (best === null || version > best.version) best = { name, version };
  }
  return best === null ? null : best.name;
}

/** Whether a screen differs from what the plan recorded for it. Not recorded: false. */
export function screenChangedSincePlan(
  records: readonly DraftScreenRecord[],
  canvas: string,
  screen: string,
  currentHtml: string,
): boolean {
  const record = records.find((entry) => entry.canvas === canvas && entry.screen === screen);
  return record !== undefined && record.hash !== hashDraftScreen(currentHtml);
}
