/**
 * Producer instructions — `flow/loops/instructions.json`.
 *
 * The ONE new piece of state in the two-loop model, and it exists for exactly
 * one behaviour: a producer that keeps hunting the same instruction across runs.
 * "Keep looking until you have filed 20" cannot be answered by a run that starts
 * counting from zero, so the count has to outlive the run that made it.
 *
 * DELETED, NEVER ARCHIVED. An instruction that stopped, ran dry or hit its cap is
 * removed on the next write. This store answers "what is being hunted right
 * now"; a history of finished hunts is what the run log is for, and keeping both
 * would give two answers to the same question.
 *
 * TINY ON PURPOSE. Four fields and a status. Every temptation to grow it —
 * per-instruction scope, schedules, priorities — is a mission, and missions live
 * in the committed directive where the whole team can read them.
 *
 * PURE CORE, THIN I/O, mirroring `loop-state.ts`: the transforms take a store
 * value and return a new one, so the cap and the dry-detection are provable
 * without a filesystem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile } from '../utils/atomic-write.js';
import { LOOPS_DIRNAME } from './directive-parser.js';

/** Filename of the instruction store inside `<flowDir>/loops/`. */
export const INSTRUCTIONS_FILENAME = 'instructions.json';

/** Schema version, bumped only by a change readers must refuse. */
export const INSTRUCTIONS_VERSION = 1;

/** How many findings one instruction files before it stops and asks for a human. */
export const DEFAULT_INSTRUCTION_CAP = 20;

/**
 * How many consecutive runs must find nothing new before an instruction is dry.
 *
 * Two, not one. A single empty run is normal — a slice may genuinely hold
 * nothing this time — and calling that "dry" would end a hunt on its first quiet
 * pass. Two in a row is the cheapest evidence that the hunt is finished rather
 * than unlucky.
 */
export const DRY_RUNS = 2;

/**
 * Why an instruction is no longer running.
 *
 * Five different things, and they must not collapse into "inactive", because
 * each one answers "should I go and look?" differently: `stopped` is a person's
 * decision, `dry` is the hunt finding nothing left, `capped` is the backstop
 * firing while there may well be more, `elapsed` is the clock running out on a
 * hunt bounded by time, and `met` is the hunt's own written rule saying it is
 * finished.
 *
 * `elapsed` and `met` arrive with the stop rules below. They are NOT `stopped`:
 * a person did not decide either of them, and a surface offering "resume" wants
 * to say something different about a hunt whose two hours are up than about one
 * somebody switched off.
 */
export type InstructionStatus = 'active' | 'stopped' | 'dry' | 'capped' | 'elapsed' | 'met';

/** Every status, for validation and exhaustiveness. */
export const INSTRUCTION_STATUSES: readonly InstructionStatus[] = [
  'active',
  'stopped',
  'dry',
  'capped',
  'elapsed',
  'met',
];

/**
 * HOW A HUNT ENDS — the rule its author chose when they started it.
 *
 * A hunt has always had two ways to finish that nobody chooses: the backstop
 * (`cap`) and running out of things to find (`dry`). Neither is an answer to
 * "how long do you want this going for", so a hunt was in practice a thing you
 * started and then had to remember to stop. This is that missing answer, and it
 * is picked once, at the moment the hunt is created, beside the work that
 * prompted it.
 *
 * Three kinds, and no more, because they are the three shapes of the same
 * sentence — "keep looking until…":
 *
 *  - `findings` — …you have filed N. THE NUMBER IS `cap`. There is deliberately
 *    no second field here: a hunt that stops at 5 findings and a hunt capped at
 *    5 findings are the same hunt, and a second number meaning the same thing is
 *    how a store starts giving two answers to one question.
 *  - `duration` — …N hours have passed. `until` is computed ONCE, when the hunt
 *    starts, and stored: a window recomputed per run from `hours` would slide
 *    forward every time somebody restarted the loop and never expire.
 *  - `custom` — …this sentence is true. The CLI cannot evaluate it and does not
 *    try; it is carried into the run's instruction and the AGENT judges it,
 *    reporting the verdict back (`loop finish`). Judgment belongs to the agent,
 *    invariants belong to the CLI — the same split the guard classifier draws.
 *
 * The backstop survives all three. A `duration` or `custom` hunt still has a
 * `cap`, because "keep looking for 24 hours" is not consent to file two hundred
 * items, and the rule that fires first is the one that stops the hunt.
 */
export type InstructionStop =
  | { kind: 'findings' }
  | { kind: 'duration'; hours: number; until: string }
  | { kind: 'custom'; rule: string };

/** Every stop kind, for validation and refusal messages. */
export const INSTRUCTION_STOP_KINDS = ['findings', 'duration', 'custom'] as const;

/** What a stop rule's `kind` may be. */
export type InstructionStopKind = (typeof INSTRUCTION_STOP_KINDS)[number];

/** Whether a value is a known stop kind. */
export function isInstructionStopKind(value: string): value is InstructionStopKind {
  return (INSTRUCTION_STOP_KINDS as readonly string[]).includes(value);
}

/**
 * The hour choices a surface offers for a `duration` hunt.
 *
 * A LIST, NOT A RANGE. The picker is a decision about how long to leave an agent
 * unattended, and a free number box invites `0.25` and `720` — neither of which
 * is a thing anybody means. Any positive number is still ACCEPTED by the parser
 * (a directive or a script may name one), bounded only by the ceiling below;
 * this is what the UI puts in front of a person.
 */
export const INSTRUCTION_STOP_HOURS = [1, 2, 3, 4, 8, 12, 24] as const;

/**
 * Longest a time-bounded hunt may be set to run.
 *
 * A week. Past that the honest answer is a standing loop with a mission in the
 * committed directive, not a hunt somebody started next to a task and forgot.
 */
export const MAX_INSTRUCTION_STOP_HOURS = 168;

/** Longest a custom stop rule may be — one sentence, not a mission. */
export const MAX_INSTRUCTION_STOP_RULE_LENGTH = 400;

/**
 * A stop rule as a CALLER states it — the same three kinds without `until`,
 * which is not a thing anybody types. `resolveInstructionStop` is the only
 * place that turns hours into an instant, so the window is stamped once.
 */
export type InstructionStopInput =
  | { kind: 'findings' }
  | { kind: 'duration'; hours: number }
  | { kind: 'custom'; rule: string };

/**
 * Stamp a stated stop rule against the clock, refusing what cannot be honoured.
 *
 * REFUSES RATHER THAN CLAMPS. A hunt asked to run for 500 hours is a typo or a
 * misunderstanding, and quietly rewriting it to 168 would tell the person their
 * number was accepted (allowed-pattern #22: validate what you were told).
 */
export function resolveInstructionStop(input: InstructionStopInput, now: string): InstructionStop {
  if (input.kind === 'findings') return { kind: 'findings' };
  if (input.kind === 'duration') {
    if (!Number.isFinite(input.hours) || input.hours <= 0) {
      throw new Error(`stop hours must be a positive number — got '${String(input.hours)}'`);
    }
    if (input.hours > MAX_INSTRUCTION_STOP_HOURS) {
      throw new Error(
        `stop hours must be at most ${String(MAX_INSTRUCTION_STOP_HOURS)} — got '${String(input.hours)}'`,
      );
    }
    const started = Date.parse(now);
    if (Number.isNaN(started)) throw new Error(`stop needs a readable clock — got '${now}'`);
    return {
      kind: 'duration',
      hours: input.hours,
      until: new Date(started + input.hours * 3_600_000).toISOString(),
    };
  }
  const rule = input.rule.replace(/\s+/g, ' ').trim();
  if (rule.length === 0) throw new Error('a custom stop rule needs a sentence — it will not guess one');
  if (rule.length > MAX_INSTRUCTION_STOP_RULE_LENGTH) {
    throw new Error(
      `a custom stop rule must be at most ${String(MAX_INSTRUCTION_STOP_RULE_LENGTH)} characters — got ${String(rule.length)}`,
    );
  }
  return { kind: 'custom', rule };
}

/**
 * Whether a hunt's own rule has ended it, and with which status.
 *
 * ONLY THE TWO THE CLI CAN DECIDE. `capped` and `elapsed` are arithmetic —
 * a count against a number, an instant against a clock — so they are settled
 * here, deterministically, by every reader that asks. `met` is a judgment about
 * a sentence and can only come from the agent, so this never returns it: a
 * `custom` hunt is `active` until something says otherwise.
 *
 * Null means nothing has ended it. The backstop is checked FIRST for every kind
 * because it outranks the chosen rule — "keep looking for 24 hours" is not
 * consent to file two hundred items.
 */
export function instructionStopReached(
  instruction: Instruction,
  now: string,
): 'capped' | 'elapsed' | null {
  if (instruction.filed >= instruction.cap) return 'capped';
  const stop = instruction.stop;
  if (stop?.kind !== 'duration') return null;
  const until = Date.parse(stop.until);
  const at = Date.parse(now);
  if (Number.isNaN(until) || Number.isNaN(at)) return null;
  return at >= until ? 'elapsed' : null;
}

/**
 * One line saying how this hunt ends, for a run's instruction and for a card.
 *
 * The `custom` case is the reason this returns prose rather than a shape: the
 * rule is a sentence the AGENT has to read and judge, so it has to reach the
 * run as a sentence.
 */
export function describeInstructionStop(instruction: Instruction): string {
  const stop = instruction.stop;
  if (stop === undefined) return `stop at ${String(instruction.cap)} findings`;
  if (stop.kind === 'findings') return `stop after ${String(instruction.cap)} findings`;
  if (stop.kind === 'duration') {
    const unit = stop.hours === 1 ? 'hour' : 'hours';
    return `stop after ${String(stop.hours)} ${unit} (at ${stop.until}), or at ${String(instruction.cap)} findings`;
  }
  return `stop when this is true: ${stop.rule} — or at ${String(instruction.cap)} findings`;
}

/** One standing instruction. */
export interface Instruction {
  /** The sentence a person typed. Its identity — retyping it resumes the hunt. */
  text: string;
  /**
   * The feature or area its findings are tagged with, when one was chosen.
   *
   * NO FILED ITEM POINTS BACK AT AN INSTRUCTION, and this is the field that
   * would have carried the link if one existed. Checked at the source rather
   * than assumed (Task 2.4): `file()` in `queue-backend.ts` writes a `<!-- loop:
   * <name> -->` marker, a fingerprint over `{loop, title, primaryFile}` and
   * labels made of the directive's `label:`, the directive's `topic:` and the
   * approval gate — the instruction's text appears in none of them. `tag` itself
   * is only ever PRESERVED here (`startInstruction` copies it, `readInstructions`
   * parses it); no caller in the CLI has ever written one, because `loop file`
   * takes its topic from the directive and never from the hunt.
   *
   * So the lineage does not exist and must not be invented. The one honest
   * link is per-RUN, not per-item: a run lock carries the `focus` it was aimed
   * at (`loop-state.ts`), which is why `loop status` reports `locks` beside the
   * instructions. Anything that wants "the items THIS hunt filed" — Phase 7's
   * filed-count filter — has to fall back to the loop's topic and say plainly
   * that the filter is approximate.
   */
  tag?: string;
  /** How many findings it has filed, across every run. */
  filed: number;
  /** The guard rail. */
  cap: number;
  /** Consecutive runs that found nothing new — `DRY_RUNS` of them means dry. */
  quietRuns: number;
  status: InstructionStatus;
  /** ISO instant it was first typed. */
  since: string;
  /**
   * How this hunt ends, when its author chose a rule.
   *
   * ABSENT IS A REAL ANSWER and it is the historical one: every hunt written
   * before stop rules existed has no `stop`, and behaves exactly as it did —
   * bounded by the backstop and by running dry. Absent is never rewritten to a
   * default, because "nobody said" and "somebody chose findings" are different
   * facts and only the second is a decision.
   */
  stop?: InstructionStop;
}

/** The whole store. */
export interface InstructionStore {
  version: number;
  instructions: Instruction[];
}

/** Absolute path of the instruction store for a flow directory. */
export function instructionsPath(flowDir: string): string {
  return join(flowDir, LOOPS_DIRNAME, INSTRUCTIONS_FILENAME);
}

/** A store with nothing being hunted. */
export function emptyInstructions(): InstructionStore {
  return { version: INSTRUCTIONS_VERSION, instructions: [] };
}

/**
 * The identity of an instruction — its text, normalized.
 *
 * Whitespace and case are not meaningful: a person retyping a sentence to resume
 * a hunt will not reproduce their own spacing, and treating "Find UI gaps" and
 * "find ui gaps" as two hunts would silently double every cap.
 */
export function instructionKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Find an instruction by its text, however it was spaced or capitalized. */
export function findInstruction(
  store: InstructionStore,
  text: string,
): Instruction | undefined {
  const key = instructionKey(text);
  return store.instructions.find((entry) => instructionKey(entry.text) === key);
}

/**
 * Start a hunt, or resume the one this sentence already names.
 *
 * RESUMING IS THE DEFAULT, and it is why identity is the text: a person who
 * types the same instruction tomorrow means "carry on", not "start again at
 * zero". Only an instruction that has STOPPED restarts, because re-typing one
 * that a person stopped is the clearest possible statement that they want it
 * running again.
 */
export function startInstruction(
  store: InstructionStore,
  text: string,
  now: string,
  cap: number = DEFAULT_INSTRUCTION_CAP,
  stop?: InstructionStop,
): { store: InstructionStore; instruction: Instruction } {
  const existing = findInstruction(store, text);
  // A HUNT THAT IS STILL RUNNING, OR THAT IS WAITING FOR A PERSON, IS RETURNED
  // AS IT STANDS (#1578). Only `stopped` restarts below — which is what the
  // docstring above always said, and what the code did not do: it restarted
  // anything non-active, so `capped` and `dry` were zeroed by the mere act of
  // retyping the sentence. Nothing in that path checks that a person looked,
  // and the automatic re-invocations type the same focus every run — so the cap
  // held for exactly one refused `loop file` and was gone by the next `loop
  // next`. A cap that any caller can clear by repeating itself is not a rail.
  //
  // Resuming a capped hunt is therefore an explicit act: stop it (which is a
  // person's decision, and the only status that restarts at zero) and type it
  // again.
  if (existing !== undefined && existing.status !== 'stopped') {
    return { store, instruction: existing };
  }
  const instruction: Instruction = {
    text: text.replace(/\s+/g, ' ').trim(),
    // THE COUNT RESTARTS. Retyping an instruction a person STOPPED is the
    // clearest statement that they want it running again, and the cap has
    // already done its job of making them look. Carrying the old count forward
    // would leave a capped hunt at 20/20: it would halt on its first check and
    // read as broken.
    filed: 0,
    cap,
    quietRuns: 0,
    status: 'active',
    since: existing?.since ?? now,
  };
  if (existing?.tag !== undefined) instruction.tag = existing.tag;
  // THE RULE IS RE-STAMPED, NOT INHERITED. A restart hands `stop` in freshly
  // resolved, so a `duration` hunt started again gets its hours measured from
  // now — carrying the old `until` forward would restart a hunt that expires
  // the instant it begins. A caller that names none leaves the hunt on the
  // backstop, which is what every hunt written before stop rules has.
  if (stop !== undefined) instruction.stop = stop;
  return { store: withInstruction(store, instruction), instruction };
}

/** Replace (or add) one instruction, dropping anything already finished. */
function withInstruction(store: InstructionStore, instruction: Instruction): InstructionStore {
  const key = instructionKey(instruction.text);
  const kept = store.instructions.filter(
    (entry) => instructionKey(entry.text) !== key && entry.status === 'active',
  );
  return { version: INSTRUCTIONS_VERSION, instructions: [...kept, instruction] };
}

/**
 * Record what one run of a hunt did.
 *
 * `filedNow` counts only what was NEW — a re-found item is not a finding, it is
 * evidence that this instruction is running out. That is what makes "dry" an
 * observation rather than the agent's opinion of its own thoroughness.
 */
export function recordInstructionRun(
  store: InstructionStore,
  text: string,
  filedNow: number,
  now: string,
  tag?: string,
): InstructionStore {
  const existing = findInstruction(store, text);
  if (existing === undefined) return store;

  const filed = existing.filed + filedNow;
  const quietRuns = filedNow === 0 ? existing.quietRuns + 1 : 0;
  const next: Instruction = { ...existing, filed, quietRuns };
  if (tag !== undefined) next.tag = tag;

  // ONE LADDER, IN THE ORDER A READER WOULD WANT TO BE TOLD. The backstop and
  // the clock are asked through `instructionStopReached`, so the arithmetic
  // that ends a hunt lives in one place rather than being restated here and at
  // the gate (allowed-pattern #14). Both outrank `dry`: a hunt that filed its
  // last finding and hit the number is capped, not finished, and the difference
  // decides whether a person should go and look.
  const reached = instructionStopReached(next, now);
  if (reached !== null) next.status = reached;
  else if (quietRuns >= DRY_RUNS) next.status = 'dry';

  return withInstruction(store, next);
}

/**
 * End a hunt because its own written rule came true — the agent's verdict.
 *
 * SEPARATE FROM `stopInstruction` because the two are different facts and a
 * surface says different things about them: `stopped` is a person switching a
 * hunt off, `met` is the sentence they wrote turning out to be true. Only a
 * `custom` hunt can reach it; asking it of any other is a no-op rather than a
 * refusal, so a run reporting on the wrong hunt cannot mislabel it.
 */
export function meetInstruction(store: InstructionStore, text: string): InstructionStore {
  const existing = findInstruction(store, text);
  if (existing === undefined || existing.stop?.kind !== 'custom') return store;
  return withInstruction(store, { ...existing, status: 'met' });
}

/** Stop a hunt because a person said so. */
export function stopInstruction(store: InstructionStore, text: string): InstructionStore {
  const existing = findInstruction(store, text);
  if (existing === undefined) return store;
  return withInstruction(store, { ...existing, status: 'stopped' });
}

/**
 * Forget one hunt, or every hunt.
 *
 * REMOVED, NOT STOPPED, and the difference is the whole reason this exists
 * beside `stopInstruction`. A stopped instruction is still a hunt — it keeps its
 * count, it is still reported by `loop status`, and every surface that draws
 * hunts still draws it, offering to resume it. That is right for "I have looked
 * at what this found, carry on", and wrong for "this hunt is over": a person
 * clearing a loop out expects the hunt to be GONE, not sitting there at 0/20.
 *
 * The store's own rule (see the module header) is that it answers "what is being
 * hunted right now" and keeps no history — the run log is the history. Removal
 * is what that rule looks like as a function.
 *
 * `text` UNDEFINED MEANS ALL, deliberately spelled as one function: a caller
 * clearing a loop must not have to enumerate the store to empty it, and the two
 * cases differ by one filter.
 */
export function forgetInstruction(store: InstructionStore, text?: string): InstructionStore {
  if (text === undefined) {
    return { version: INSTRUCTIONS_VERSION, instructions: [] };
  }
  const key = instructionKey(text);
  return {
    version: INSTRUCTIONS_VERSION,
    instructions: store.instructions.filter((entry) => instructionKey(entry.text) !== key),
  };
}

/** How much room this instruction has left before its cap. */
export function instructionRoom(instruction: Instruction): number {
  return Math.max(0, instruction.cap - instruction.filed);
}

/** Serialize deterministically — same store, byte-identical output. */
export function serializeInstructions(store: InstructionStore): string {
  const instructions = [...store.instructions]
    .sort((a, b) => instructionKey(a.text).localeCompare(instructionKey(b.text)))
    .map((entry) => {
      const ordered: Record<string, unknown> = { text: entry.text };
      if (entry.tag !== undefined) ordered.tag = entry.tag;
      ordered.filed = entry.filed;
      ordered.cap = entry.cap;
      ordered.quietRuns = entry.quietRuns;
      ordered.status = entry.status;
      ordered.since = entry.since;
      if (entry.stop !== undefined) ordered.stop = entry.stop;
      return ordered;
    });
  return `${JSON.stringify({ version: INSTRUCTIONS_VERSION, instructions }, null, 2)}\n`;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a stored `status` is one this version knows. */
function isInstructionStatus(value: unknown): value is InstructionStatus {
  return typeof value === 'string' && (INSTRUCTION_STATUSES as readonly string[]).includes(value);
}

/** Read a stored stop rule, or null when there is none that can be trusted. */
function parseStop(raw: unknown): InstructionStop | null {
  if (!isRecordObject(raw)) return null;
  if (raw.kind === 'findings') return { kind: 'findings' };
  if (raw.kind === 'duration') {
    const hours = raw.hours;
    const until = raw.until;
    // `until` is what actually ends the hunt, so an unreadable one is the whole
    // rule gone — a duration rule without a deadline would never expire.
    if (typeof hours !== 'number' || hours <= 0) return null;
    if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) return null;
    return { kind: 'duration', hours, until };
  }
  if (raw.kind === 'custom') {
    const rule = raw.rule;
    if (typeof rule !== 'string' || rule.trim().length === 0) return null;
    return { kind: 'custom', rule: rule.trim() };
  }
  return null;
}

/**
 * What one read of the store found: the store, or why there is none.
 *
 * TWO ANSWERS, NEVER ONE. `readInstructions` collapses them on purpose — a
 * producer whose count is unreadable starts the hunt over rather than refusing
 * to run — but a REPORT must not: an empty store says "nothing is being
 * hunted", and a file nobody could parse has said nothing at all. `loop status`
 * reads through here so a card can render "unreadable" instead of "0 hunts".
 */
export type InstructionsRead =
  | { store: InstructionStore; error?: undefined }
  | { store: null; error: string };

/**
 * Read the store, saying WHY when it could not be read.
 *
 * THE ONE READER — `readInstructions` is this function with the failure thrown
 * away, so there is exactly one place that decides what "unreadable" means
 * (allowed-pattern #14). A MISSING file is not a failure: never having typed an
 * instruction is a perfectly good answer, and it is the empty store. A single
 * malformed ENTRY is not a failure either — it is skipped, as it always was,
 * because one bad line must not take the other hunts' counts with it.
 */
export function readInstructionsResult(flowDir: string): InstructionsRead {
  const filePath = instructionsPath(flowDir);
  if (!existsSync(filePath)) return { store: emptyInstructions() };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return { store: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (!isRecordObject(raw) || !Array.isArray(raw.instructions)) {
    return { store: null, error: `malformed ${INSTRUCTIONS_FILENAME} — expected { instructions: [] }` };
  }

  const instructions: Instruction[] = [];
  for (const entry of raw.instructions) {
    if (!isRecordObject(entry)) continue;
    if (typeof entry.text !== 'string' || entry.text.trim().length === 0) continue;
    const status = entry.status;
    if (!isInstructionStatus(status)) continue;
    const instruction: Instruction = {
      text: entry.text,
      filed: typeof entry.filed === 'number' && entry.filed >= 0 ? entry.filed : 0,
      cap: typeof entry.cap === 'number' && entry.cap > 0 ? entry.cap : DEFAULT_INSTRUCTION_CAP,
      quietRuns: typeof entry.quietRuns === 'number' && entry.quietRuns >= 0 ? entry.quietRuns : 0,
      status,
      since: typeof entry.since === 'string' ? entry.since : '',
    };
    if (typeof entry.tag === 'string' && entry.tag.length > 0) instruction.tag = entry.tag;
    // A STOP RULE THAT DOES NOT PARSE IS DROPPED, NOT THE HUNT. The same rule
    // the surrounding loop already follows for a malformed entry, one field
    // down: losing a hunt's count because somebody hand-edited its rule badly
    // would be a worse outcome than losing the rule, and a hunt without one is
    // a valid hunt on the backstop.
    const stop = parseStop(entry.stop);
    if (stop !== null) instruction.stop = stop;
    instructions.push(instruction);
  }
  return { store: { version: INSTRUCTIONS_VERSION, instructions } };
}

/**
 * Read the store, fail-soft.
 *
 * FAIL-SOFT, unlike `loop-state.ts`, and the asymmetry is deliberate: a corrupt
 * lock file must stop a loop, because the alternative is two runs believing they
 * hold the same lock. A corrupt instruction file costs a count. Refusing to run
 * the producer at all because a progress number is unreadable would be a much
 * worse trade than starting the hunt over.
 *
 * A reader that must TELL the two apart calls `readInstructionsResult`.
 */
export function readInstructions(flowDir: string): InstructionStore {
  return readInstructionsResult(flowDir).store ?? emptyInstructions();
}

/** Write the store atomically — the one shared implementation. */
export function writeInstructions(flowDir: string, store: InstructionStore): void {
  atomicWriteFile(instructionsPath(flowDir), serializeInstructions(store));
}
