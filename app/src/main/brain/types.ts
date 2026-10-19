// Brain knowledge store — main-process types.
//
// The "brain" is the single knowledge store the agent reads/writes (issue #52).
// Semantics (feature memory, decisions, errors) are canonical Obsidian-readable
// markdown; structure is derived and rebuilt; the sqlite index is derived.
//
// A feature's "working set" is the set of files the agent touched while working
// a thread/task — captured automatically, promoted into a feature memory by the
// compaction pass. Read `flow/plans/plan_brain_consolidation_v1.md` for the model.

/** How a file was touched during a thread. `Edit`/`Write` → edited; `Read`/`Grep` → read. */
export type WorkingSetRole = 'read' | 'edited'

/** One file in a thread's working set. */
export interface WorkingSetFile {
  /** Root-relative POSIX path. */
  path: string
  role: WorkingSetRole
}

/**
 * Raw, un-promoted capture written to `flow/brain/.raw/` at thread close. This
 * tier is NEVER trusted/indexed until the compaction pass promotes it.
 */
export interface RawWorkingSet {
  threadId: string
  /** Thread/task title — becomes the feature title on promotion. */
  title: string
  files: WorkingSetFile[]
  /** ISO-8601 capture time (passed in — the store never reads the clock itself). */
  capturedAt: string
}

/**
 * A promoted, trusted feature memory — rendered to `flow/brain/features/<slug>.md`
 * by the compaction pass. This is the queryable unit that saves re-scanning.
 */
export interface FeatureMemory {
  /** Kebab-case slug — the markdown filename stem. */
  feature: string
  title: string
  files: WorkingSetFile[]
  summary: string
  decisions: string[]
  provenance: {
    threadId: string
    runId?: string
    capturedAt: string
  }
}
