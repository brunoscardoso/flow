/**
 * Interactive prompts using Node.js readline/promises
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Platform, ShareMode } from '../types.js';

/**
 * Ask a question, and treat EOF as the empty answer every caller already
 * handles.
 *
 * `rl.question()` on a stdin that has ended NEVER SETTLES. The awaited promise
 * stays pending, node's event loop drains with nothing left to wait for, and
 * the process exits 0 — mid-install, having printed the prompt and nothing
 * after it. That is how `init --all </dev/null` came to report success over a
 * project where nothing was installed, and `echo 1 | init --all` over one with
 * `.claude` but no `flow/`, no `CLAUDE.md` and no `loops/` (#1795). Both are
 * the form the README and CLAUDE.md document, so a CI step or an agent
 * following this project's own instructions got exit 0 and an unprovisioned
 * repo.
 *
 * The interface's `close` event is what EOF actually raises, so racing it
 * against the question turns a hang into an answer. `''` is deliberate rather
 * than a per-call default: every caller already coalesces the empty string to
 * its own documented default (`answer.trim() || '1'`, `=== '2' ? … : 'local'`),
 * so EOF lands exactly where the doc comments already say it does — and a
 * default stays written once, next to the prompt that owns it.
 *
 * A PIPED ANSWER STILL WINS. `close` arrives after the line, not instead of it,
 * so `echo 2 | …` still reads as an explicit 2.
 */
async function ask(rl: Interface, query: string): Promise<string> {
  // ALREADY OVER BEFORE THIS INTERFACE EXISTED. Each prompt builds its own
  // `createInterface`, and stdin only ends once — so the second prompt of a run
  // gets no `close` event to race against, because the first one consumed it.
  // That is why fixing only the race left `init </dev/null` still stopping, one
  // prompt later than before. The stream's own state is the thing that outlives
  // an interface, so it is what gets asked.
  if (stdin.readableEnded) {
    // Printed anyway: a transcript that ends mid-line at "Enter your choice
    // (1-3) [1]: " is how this was invisible for so long. Saying the prompt and
    // then answering it leaves a log a reader can follow.
    stdout.write(`${query}\n`);
    return '';
  }

  let closed = false;
  rl.once('close', () => {
    closed = true;
  });
  const atEof = new Promise<null>((resolve) => {
    if (closed) resolve(null);
    else rl.once('close', () => resolve(null));
  });
  return (await Promise.race([rl.question(query), atEof])) ?? '';
}

/**
 * Asks the user what to do with custom (non-plan-flow) files found in a
 * legacy .claude/rules/ subdirectory during v1 → v2 migration.
 */
export async function askLegacyFilesAction(
  subdir: string,
  files: string[]
): Promise<'keep' | 'move' | 'remove'> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log(
      `\nFound ${files.length} custom file(s) in .claude/rules/${subdir}/:`
    );
    for (const f of files) {
      console.log(`  - ${f}`);
    }
    console.log(
      '\nThese files were not installed by plan-flow. What would you like to do?\n'
    );
    console.log(
      '  1. Keep in current location (still auto-loaded by Claude Code) [default]'
    );
    console.log(
      `  2. Move to .claude/resources/${subdir}/ (loaded on-demand only)`
    );
    console.log('  3. Remove them');
    console.log('');

    const answer = await ask(rl, 'Enter your choice (1-3) [1]: ');
    const choice = answer.trim() || '1';

    switch (choice) {
      case '2':
        return 'move';
      case '3':
        return 'remove';
      default:
        return 'keep';
    }
  } finally {
    rl.close();
  }
}

/**
 * Asks the user 3 questions to build a business context document.
 * Accepts an optional readmeHint to pre-fill the "What does this project do?" question.
 */
export async function askBusinessContext(readmeHint?: string): Promise<{
  whatItDoes: string;
  targetAudience: string;
  problemItSolves: string;
}> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log('\n📋 Business Context\n');

    if (readmeHint) {
      console.log(`  (from README: "${readmeHint}")\n`);
    }

    const defaultHint = readmeHint ? ` [${readmeHint}]` : '';
    const whatItDoes =
      (await ask(rl, `  What does this project do?${defaultHint} `)).trim() ||
      readmeHint ||
      '';

    const targetAudience =
      (await ask(rl, '  Who is the target audience? ')).trim() || '';

    const problemItSolves =
      (await ask(rl, '  What problem does it solve? ')).trim() || '';

    return { whatItDoes, targetAudience, problemItSolves };
  } finally {
    rl.close();
  }
}

/**
 * Asks whether this project's plan-flow knowledge is shared with the team or
 * kept local.
 *
 * The default is LOCAL, and it is the default for a reason: answering "shared"
 * commits the project's brain alongside the code, which publishes work that may
 * not be the answerer's to publish. Anything other than an explicit "2" — an
 * empty answer, a stray word, EOF on a piped stdin — reads as local.
 */
export async function askShareMode(): Promise<ShareMode> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log('\n🧠 Project knowledge\n');
    console.log(
      '  plan-flow builds a brain for this project — features, decisions, errors.'
    );
    console.log('  Should it travel with the code, or stay on this machine?\n');
    console.log('  1. Keep it local — flow/ stays out of git [default]');
    console.log('  2. Share it with the team — the knowledge markdown is committed');
    console.log('');

    const answer = await ask(rl, 'Enter your choice (1-2) [1]: ');
    return answer.trim() === '2' ? 'shared' : 'local';
  } finally {
    rl.close();
  }
}

/**
 * Claude Code is the only supported platform (multi-IDE support removed
 * 2026-07-22) — kept as a function so callers/tests keep a stable seam.
 */
export async function selectPlatforms(): Promise<Platform[]> {
  return ['claude'];
}
