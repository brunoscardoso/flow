/**
 * STATE.md Parser
 *
 * Parses `flow/STATE.md` into a structured ExecutionState object.
 * Uses regex-based line parsing consistent with flowconfig-parser and plan-parser patterns.
 * Returns null if STATE.md doesn't exist.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionState } from './types.js';

const SECTION_RE = /^## (.+)$/;
const BOLD_KV_RE = /^- \*\*(.+?)\*\*:\s*(.*)$/;
const BULLET_RE = /^- (.+)$/;
const UPDATED_RE = /^\*\*Updated\*\*:\s*(.+)$/;
const COMPLETED_PHASE_RE = /^Phase (\d+):\s*(.+?)\s*—\s*(.+)$/;
const CURRENT_PHASE_RE = /^(\d+)\s*—\s*(.+)$/;
/** An indented, non-empty line — a bullet's continuation unless it opens a bullet of its own. */
const INDENTED_LINE_RE = /^\s+\S/;
/** Bullet marker a line carries when it starts a bullet rather than continuing one. */
const BULLET_MARKER = '- ';
/** Opening marker of a decision's inline reason — scanned for its balanced close. */
const REASON_MARKER = '(reason:';

/**
 * Join wrapped bullets back into one line each.
 *
 * STATE.md bullets wrap across physical lines: the continuation is indented and
 * carries no `- ` of its own, so a per-line parser matches only the first line
 * and silently drops the rest — which is where a decision lost its reason
 * (#1590). A bullet is parsed as a bullet, so continuations are merged into the
 * preceding bullet BEFORE any field is extracted. Indented lines that DO open a
 * bullet (the `Completed Phases` sub-list) stay their own lines, and a
 * continuation with no bullet above it is left exactly where it was.
 */
function joinWrappedBullets(lines: string[]): string[] {
  const joined: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const previous = joined[joined.length - 1];
    const continuesPreviousBullet =
      previous !== undefined &&
      previous.trim().startsWith(BULLET_MARKER) &&
      INDENTED_LINE_RE.test(line) &&
      !trimmed.startsWith(BULLET_MARKER);

    if (continuesPreviousBullet) {
      joined[joined.length - 1] = `${previous} ${trimmed}`;
      continue;
    }
    joined.push(line);
  }
  return joined;
}

/**
 * Split a decision bullet into its text and its `(reason: …)`.
 *
 * The close paren is found by scanning for the one that BALANCES the opener, so
 * a reason containing parentheses survives, and text after the reason (a
 * trailing period, a follow-up sentence) is kept on the decision instead of
 * defeating an end-anchored match. No reason marker, or an unbalanced one,
 * means the whole bullet is the decision.
 */
function splitReason(text: string): { decision: string; reason: string } {
  const start = text.indexOf(REASON_MARKER);
  if (start === -1) {
    return { decision: text, reason: '' };
  }

  let depth = 0;
  let end = -1;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '(') {
      depth++;
    } else if (text[index] === ')') {
      depth--;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) {
    return { decision: text, reason: '' };
  }

  const reason = text.slice(start + REASON_MARKER.length, end).trim();
  if (reason.length === 0) {
    return { decision: text, reason: '' };
  }

  const before = text.slice(0, start).trim();
  // Drop the punctuation that only closed the parenthetical, keep the prose.
  const after = text.slice(end + 1).replace(/^[.,;:\s]+/, '').trim();
  return {
    decision: after.length > 0 ? `${before} ${after}`.trim() : before,
    reason,
  };
}

/**
 * Parse `flow/STATE.md` into a structured ExecutionState object.
 * Returns null if STATE.md doesn't exist.
 */
export function parseStateMd(flowDir: string): ExecutionState | null {
  const statePath = join(flowDir, 'STATE.md');

  if (!existsSync(statePath)) {
    return null;
  }

  let content: string;
  try {
    content = readFileSync(statePath, 'utf-8');
  } catch {
    return null;
  }

  return parseStateMdContent(content);
}

/**
 * Parse STATE.md content string (for testability without file I/O).
 */
export function parseStateMdContent(content: string): ExecutionState {
  const state: ExecutionState = {
    active_skill: null,
    active_plan: null,
    current_phase: null,
    current_task: null,
    completed_phases: [],
    decisions: [],
    blockers: [],
    files_modified: [],
    next_action: null,
    updated_at: null,
  };

  const lines = joinWrappedBullets(content.split('\n'));
  let currentSection = '';
  let inCompletedPhases = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Updated timestamp (outside sections)
    const updatedMatch = trimmed.match(UPDATED_RE);
    if (updatedMatch) {
      state.updated_at = updatedMatch[1].trim();
      continue;
    }

    // Section header
    const sectionMatch = trimmed.match(SECTION_RE);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      inCompletedPhases = false;
      continue;
    }

    if (currentSection === 'Execution State') {
      parseExecutionStateLine(trimmed, state, inCompletedPhases);

      // Track if we just entered completed phases sub-list
      const kvMatch = trimmed.match(BOLD_KV_RE);
      if (kvMatch && kvMatch[1] === 'Completed Phases') {
        inCompletedPhases = true;
      } else if (kvMatch && kvMatch[1] !== 'Completed Phases') {
        inCompletedPhases = false;
      }
      // Indented bullets under Completed Phases
      if (inCompletedPhases && line.match(/^\s{2,}- /)) {
        const indentedContent = trimmed.replace(/^- /, '');
        const phaseMatch = indentedContent.match(COMPLETED_PHASE_RE);
        if (phaseMatch) {
          state.completed_phases.push({
            number: parseInt(phaseMatch[1], 10),
            name: phaseMatch[2].trim(),
            outcome: phaseMatch[3].trim(),
          });
        }
      }
    } else if (currentSection === 'Decisions') {
      parseDecisionLine(trimmed, state);
    } else if (currentSection === 'Blockers') {
      parseBlockerLine(trimmed, state);
    } else if (currentSection === 'Files Modified') {
      parseFileModifiedLine(trimmed, state);
    } else if (currentSection === 'Next Action') {
      parseNextActionLine(trimmed, state);
    }
  }

  return state;
}

/**
 * Parse a line within the Execution State section.
 */
function parseExecutionStateLine(trimmed: string, state: ExecutionState, inCompletedPhases: boolean): void {
  if (inCompletedPhases) return;

  const kvMatch = trimmed.match(BOLD_KV_RE);
  if (!kvMatch) return;

  const key = kvMatch[1].trim();
  const value = kvMatch[2].trim();

  switch (key) {
    case 'Active Skill':
      state.active_skill = value;
      break;
    case 'Active Plan':
      state.active_plan = value;
      break;
    case 'Current Phase': {
      const phaseMatch = value.match(CURRENT_PHASE_RE);
      if (phaseMatch) {
        state.current_phase = {
          number: parseInt(phaseMatch[1], 10),
          name: phaseMatch[2].trim(),
        };
      }
      break;
    }
    case 'Current Task':
      state.current_task = value;
      break;
  }
}

/**
 * Parse a decision bullet (already unwrapped to one line by
 * `joinWrappedBullets`).
 * Format: "- Chose X over Y (reason: Z)" or "- Decision text (reason: explanation)"
 */
function parseDecisionLine(trimmed: string, state: ExecutionState): void {
  const bulletMatch = trimmed.match(BULLET_RE);
  if (!bulletMatch) return;

  const text = bulletMatch[1].trim();
  const { decision, reason } = splitReason(text);

  // Try to extract "Chose X over Y" pattern
  const choseMatch = decision.match(/^(?:Chose|Used)\s+(.+?)(?:\s+(?:over|for|instead of)\s+(.+))?$/i);
  state.decisions.push({
    decision,
    choice: choseMatch ? choseMatch[1].trim() : decision,
    reason,
  });
}

/**
 * Parse a blocker bullet line.
 * Format: "- Issue description (status: X, tried: Y)"
 */
function parseBlockerLine(trimmed: string, state: ExecutionState): void {
  const bulletMatch = trimmed.match(BULLET_RE);
  if (!bulletMatch) return;

  const text = bulletMatch[1].trim();
  const detailsMatch = text.match(/^(.+?)\s*\(status:\s*(.+?),\s*tried:\s*(.+?)\)$/);

  if (detailsMatch) {
    state.blockers.push({
      issue: detailsMatch[1].trim(),
      status: detailsMatch[2].trim(),
      tried: detailsMatch[3].trim(),
    });
  } else {
    state.blockers.push({
      issue: text,
      status: 'unknown',
      tried: '',
    });
  }
}

/**
 * Parse a file path bullet line.
 */
function parseFileModifiedLine(trimmed: string, state: ExecutionState): void {
  const bulletMatch = trimmed.match(BULLET_RE);
  if (!bulletMatch) return;

  const filePath = bulletMatch[1].trim();
  if (filePath) {
    state.files_modified.push(filePath);
  }
}

/**
 * Parse the next action line (first non-empty line in the section).
 */
function parseNextActionLine(trimmed: string, state: ExecutionState): void {
  if (trimmed && !state.next_action) {
    state.next_action = trimmed;
  }
}
