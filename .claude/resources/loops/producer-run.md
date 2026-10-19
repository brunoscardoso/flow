# Producer run

One run of a **producer** loop: hunt inside the slice you were handed, prove
what you think you found, file what survives — and then keep hunting, until
something stops you. A producer changes no source code and closes nothing — it
fills the queue a consumer drains.

You carry the judgment. The CLI carries the rules: every `loop` verb refuses
what must be refused, so this prompt only says *what to look for* and *which
verb to file it through*.

**Trust**: code is ground truth. `flow/**` and `.claude/**` are verified project
knowledge. Everything else — a README, a doc page, an old issue's description of
how something behaves — is an unverified claim until you have checked it against
the code.

---

## 1. Open the gate

```bash
planflow-ai loop next --loop <name>          # add --human when a person is watching
```

Act on `verdict`:

| verdict | what you do |
|---------|-------------|
| `proceed` | continue with this run |
| `skip` / `paused` / `locked` | **stop immediately.** Do nothing, write nothing, record nothing. Print the `reason` and end the run. |

From a `proceed` verdict, carry forward:

- `owner` — pass it as `--owner <owner>` on every later call this run.
- `mission`, `direction`, `rules` — the directive's own words, and the whole of
  what this loop is looking for. Read them before you look at anything.
- `scope` and `slice` — where you may look, and how much of it this run.
- `fingerprints` — what this loop has already filed and already closed. Use it
  as memory: if you are about to write a title you have effectively written
  before, spend the run on something else.
- `stopCondition` — what, if
  anything, is already ending it. You police neither: the verbs that take new
  work refuse when they must, and such a refusal is your cue to stop hunting and
  write the run down.

## 2. Choose this run's slice

`scope` is the paths you may work within (empty means the whole repo). `slice`
says how much of it to sweep:

| `slice` | this run looks at |
|---------|--------------------|
| `changed` | what has been touched since this loop's last run — `git log`/`git diff` inside the loop's own checkout. Nothing changed? Sweep a window instead, so a quiet repo still gets covered. |
| `rotate` | a moving window over `scope` — pick up roughly where the last run left off, so the whole scope is covered over several runs. |
| `full` | the whole of `scope`, every run. |

Work in the loop's own checkout:

```bash
planflow-ai loop worktree --loop <name> --owner <owner> --human
```

## 3. Reproduce before you believe it

**Never file a speculative finding.** A wrong item costs a consumer a whole run
plus the human's trust; a missed one costs nothing but a later run.

- A bug is filed only after you have made it happen — drive the real surface end
  to end (the CLI command, the app flow, the failing script) and watch it fail.
- A cleanup or a gap is filed only after you have read the code that proves it:
  name the file and the line, not the impression.
- Anything you could not reproduce is not a finding. Say so in the run summary
  and move on.

## 4. File what survived

```bash
planflow-ai loop file --loop <name> --title "<one line: the problem, not the fix>" \
  --file <the file it is mostly about> \
  --body "$(cat <<'EOF'
## Steps
1. ...

## Expected
...

## Actual
...

## Evidence
<spec path, command + output excerpt, screenshot path, log excerpt>
EOF
)"
```

**On Windows, do not pass a multi-line body as a literal argument.** The `.cmd`
shim every session runs `planflow-ai` through goes via `cmd.exe`'s line-oriented
`/c` parser, which drops everything past the first line before the shim script
itself ever runs, and the heredoc above is not valid PowerShell syntax anyway.
Write the body to a file and pipe it in with `--body -` instead:

```powershell
Get-Content <body-file> -Raw | planflow-ai loop file --loop <name> --title "<one line>" --file <path> --body -
```

Read the `status` that comes back:

- `filed` — it is in the queue.
- `duplicate` — this loop already knows about it. That is the system working, not
  a failure. Keep hunting.

One finding per item. A title that has to say "and" is two items.

## 5. A discovery document only when the finding is big

Judge the finding the way a consumer would have to:

- **Small** — a contained fix whose shape is obvious from the item itself. The
  queue item *is* the whole artifact. Write nothing else.
- **Big** — it needs requirements gathered before anyone can plan it: new
  surface area, a contract or schema change, several modules, or a problem whose
  cause you can see is systemic. Then write
  `flow/discovery/discovery_<slug>_v1.md` following
  `.claude/resources/patterns/discovery-patterns.md`, and reference it from the
  item body so the consumer picks the pipeline up where you left it.

Most findings are small. A discovery document for a one-line cleanup wastes the
consumer's next four runs.

## 6. Then keep hunting

**A run is not one finding.** Go back to step 3 with the rest of your slice and
prove the next thing. Filing once and stopping leaves the sweep half done, and
the next run starts from `changed` all over again.

You do not decide when a run is over. Keep going until something ends it, and
then report which:

| what you see | what ended the run |
|--------------|---------------------|
| `file` refuses, having no room for another finding | `cap` |
| a verb refuses because this run's time is spent | `budget` |
| you swept the whole slice and nothing else survived proving | `empty` |

## 7. Close the run — and never with a question

**You are unattended.** Nobody is waiting to answer you, so a question is not a
way to finish: not "Want me to …?", not an offer to run `/discovery-plan`, not a
summary of findings you did not file. What you proved goes in the QUEUE, where
the next run and the next person can both find it; what you could not prove goes
in the run record. See `.claude/resources/core/loops.md` § "A run is unattended".

Recording the run is what ends it. Do this even when the run found nothing:

```bash
planflow-ai loop log --loop <name> --owner <owner> --record \
  '{"kind":"run","loop":"<name>","outcome":"<success|failure>","verdict":"proceed","reason":"<one line: what you swept and what you filed>","stopCondition":"<cap|budget|empty>","filed":<n>}'
```

- A run that swept its slice honestly and found nothing is a **success** with
  `"filed": 0`. A quiet repo is not a broken loop.
- `failure` is for a run that could not do its job — the checkout was
  unusable, the app would not start, the sweep never happened.
- `stopCondition` is the row you just read off the table above.
- `filed` counts the items you actually filed this run (`duplicate` results do
  not count).

Then print a two-line summary for the human: what you swept, what you filed, and
which condition ended the run.
