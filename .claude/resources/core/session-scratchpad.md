
# Session Scratchpad

## Purpose

The session scratchpad (`flow/.scratchpad.md`) is an ephemeral per-session file for raw notes, temporary analysis, and in-progress observations. It bridges the gap between transient session work and permanent artifacts (ledger, brain, memory).

**Core principle**: Write things down so they survive compaction; promote the valuable ones before session ends.

---

## Session Start Behavior

On session start:
1. If `flow/.scratchpad.md` exists and has content, read it silently
2. If entries look stale (from a previous session), scan for promotable items:
   - Learnings → promote to `flow/ledger.md`
   - Error patterns → promote to `flow/brain/errors/`
   - Feature context → promote to `flow/brain/features/`
   - User preferences → promote to `flow/ledger.md` (User Preferences section)
3. After promotion, clear the file (reset to empty template)
4. If the file is empty or doesn't exist, skip — no action needed

---

## Write Triggers

Write to the scratchpad when you encounter:

| Trigger | Example Entry |
|---------|---------------|
| **Non-obvious error resolution** | "Fixed ESM import issue — need `type: module` in package.json AND `moduleResolution: node16` in tsconfig" |
| **Architectural insight** | "This project uses barrel exports everywhere — new files need re-export in index.ts" |
| **Dead-end approach** | "Tried using `fs.watch` for file monitoring — unreliable on Linux, switched to chokidar" |
| **User preference discovered** | "User prefers terse responses, no trailing summaries" |
| **Open question** | "Need to verify: does the CI pipeline run on Node 18 or 20?" |
| **Mid-task context** | "Reviewing auth module — found 3 unused imports, will clean up after main task" |

### What NOT to Write

- Routine file reads or grep results (re-readable)
- Build/test output (captured in logs)
- Things already captured by brain-capture blocks
- Obvious facts derivable from the code
- Full code snippets (reference file:line instead)

---

## File Format

```markdown
# Session Scratchpad

## Notes

- [{timestamp}] {note}
- [{timestamp}] {note}

## Open Questions

- {question}

## Promote Before Session End

- [ ] {item to promote} → {target: ledger/brain/memory}
```

Keep under **50 lines**. When approaching the limit, promote older entries or discard low-value ones.

---

## Promotion Rules

Before session ends (or when the scratchpad is getting full):

1. **Scan each entry** and classify:
   - **Promote**: Valuable insight that should persist → move to appropriate target
   - **Discard**: Transient note, already acted on, or no future value → delete
2. **Promotion targets**:
   | Content Type | Target | Section |
   |-------------|--------|---------|
   | Project learning / workaround | `flow/ledger.md` | What Works / What Didn't Work |
   | User preference | `flow/ledger.md` | User Preferences |
   | Error pattern | `flow/brain/errors/{name}.md` | New or updated entry |
   | Feature context | `flow/brain/features/{name}.md` | Timeline update |
   | Reusable pattern | `flow/resources/pending-patterns.md` | Pattern capture buffer |
3. **After promotion**, clear the scratchpad (leave just the empty template headers)

---

## Compaction Integration

During `/compact`, the scratchpad is in the **preserve** list — its contents survive compaction summaries. This is critical because scratchpad notes often contain context that would otherwise be lost.

After compaction, the model should re-read `flow/.scratchpad.md` to restore any notes written before compaction.

---

## Rules

1. **Lightweight writes** — single-line entries, not paragraphs
2. **No duplication** — don't write what brain-capture already captures
3. **Self-manage size** — promote or discard when approaching 50 lines
4. **Promote before ending** — always scan for promotable items before session ends
5. **Not a task list** — use `flow/tasklist.md` for tasks, scratchpad is for observations
6. **Different from STATE.md** — `flow/STATE.md` tracks structured execution position (current skill, phase, status) for session resumability. The scratchpad tracks informal observations, insights, and open questions. They coexist and serve different purposes: STATE.md is machine-readable execution state, scratchpad is human-readable notes.
