# Shared Context System

## COR-SC-1: Purpose

Inter-agent communication during parallel wave execution via a shared JSONL context file. When multiple phases run in parallel (wave execution), each sub-agent may produce contracts, decisions, or progress updates that sibling agents need. The shared context file acts as the coordination bus.

## COR-SC-2: Context Entry Types

Each entry in the context file is a JSON object with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Phase identifier (e.g., `"phase-3"`) |
| `type` | `'contract' \| 'decision' \| 'progress'` | Entry category |
| `timestamp` | string | ISO-8601 timestamp |
| `data` | object | Type-specific payload (see below) |

### Contract Entries (`type: 'contract'`)

Declare API shapes, interfaces, function signatures, or type definitions that other phases may depend on.

```json
{
  "agent": "phase-2",
  "type": "contract",
  "timestamp": "2026-03-24T10:00:00.000Z",
  "data": {
    "name": "UserService.getById",
    "kind": "function",
    "signature": "(id: string) => Promise<User>",
    "fields": ["id", "name", "email"]
  }
}
```

`data` fields for contracts:
- `name` (required): Unique identifier for the contract
- `kind` (required): One of `endpoint`, `interface`, `function`, `type`
- `signature` (required): The type signature or shape
- `fields` (optional): Array of field/property names

### Decision Entries (`type: 'decision'`)

Record architecture or implementation choices made during execution.

```json
{
  "agent": "phase-3",
  "type": "decision",
  "timestamp": "2026-03-24T10:01:00.000Z",
  "data": {
    "choice": "Use Redis for session storage",
    "reason": "Faster than DB lookups for frequent reads"
  }
}
```

### Progress Entries (`type: 'progress'`)

Report task status within a phase using the unified status contract signals (see `.claude/resources/core/status-contract.md`):

`status: working | needs-decision | blocked | done | failed`

```json
{
  "agent": "phase-2",
  "type": "progress",
  "timestamp": "2026-03-24T10:02:00.000Z",
  "data": {
    "task": 1,
    "status": "done",
    "summary": "Created UserService with CRUD operations"
  }
}
```

```json
{
  "agent": "phase-3",
  "type": "progress",
  "timestamp": "2026-03-24T10:03:00.000Z",
  "data": {
    "task": 2,
    "status": "blocked",
    "summary": "Waiting on phase-2 UserService.getById contract before wiring the route"
  }
}
```

**Backward compatibility**: earlier entries used the bare value `complete`. Readers MUST treat legacy `complete` as `done`. Writers always use the five-signal vocabulary.

## COR-SC-3: File Format and Lifecycle

**File**: `.wave-context.jsonl` inside the `flow/` directory. Append-only JSONL — one JSON object per line.

**Lifecycle**:

1. **Created** — at the start of the first wave, an empty `.wave-context.jsonl` is created
2. **Injected** — before spawning sub-agents (Step 4b), existing entries are read and passed as context
3. **Appended** — sub-agents append entries during execution via atomic write (read, append, write-to-temp, rename)
4. **Collected** — after sub-agents return (Step 4c), all entries are read and checked for conflicts
5. **Retained** — the file accumulates across waves; later waves receive earlier waves' entries as injected context
6. **Deleted** — only after plan execution completes, the file is removed

## COR-SC-4: Contract Conflict Detection

A conflict exists when two or more entries share the same `name` but have different `signature` or `fields` values.

**Detection rules**:
- Filter entries to `type === 'contract'`
- Group by `data.name`
- For each group with 2+ entries: compare `signature` and `fields` (order-insensitive for fields)
- If any pair within a group differs: flag as conflict

**Resolution**: Present both conflicting versions to the user with the originating agent names. The user decides which version to keep or how to reconcile.

## COR-SC-5: Integration Points and Backward Compatibility

**Integration points**:
- **Step 4b (inject)**: Read `.wave-context.jsonl`, pass entries array to sub-agent prompt
- **Step 4c (collect)**: Parse `context_entries` from sub-agent return JSON, append to file, run conflict detection

**Backward compatibility**:
- Single-phase waves: context injection is skipped (no sibling data to share)
- Sequential mode (`wave_execution: false`): shared context system is not used
- `context_entries` field is optional in sub-agent return JSON — absence means no entries to contribute
- Existing plans without wave execution are completely unaffected
- Progress entries with the legacy status `complete` are read as `done` (see `.claude/resources/core/status-contract.md`)
