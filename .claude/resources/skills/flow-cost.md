# Flow Cost: Token Usage Reporting

## Overview

The `/flow cost` subcommand reads `~/.claude/metrics/costs.jsonl` and displays token usage and estimated cost summaries. It supports time-based and project-based filtering.

## Usage

```
/flow cost                       Show last 7 days summary
/flow cost --today               Show today's usage
/flow cost --week                Show last 7 days (default)
/flow cost --month               Show last 30 days
/flow cost --project <name>      Filter by project name
/flow cost --session <id>        Show single session detail
/flow cost --detail              Include model breakdown
```

## Implementation

When the user runs `/flow cost`, follow these steps:

### Step 1: Read Metrics File

1. Read `~/.claude/metrics/costs.jsonl`
2. If the file doesn't exist, display: "No cost data found. Cost tracking hooks will start recording after your next Claude response."
3. Parse each line as JSON, skip malformed lines
4. Also read any rotated files (`costs.*.jsonl`) in the same directory if the time range extends beyond the current file

### Step 2: Filter Entries

Apply filters based on flags:

| Flag | Filter Logic |
|------|-------------|
| `--today` | Entries where `timestamp` is today (local date) |
| `--week` | Entries from the last 7 days (default) |
| `--month` | Entries from the last 30 days |
| `--project <name>` | Entries where `project` matches `<name>` |
| `--session <id>` | Entries where `session_id` matches `<id>` |

**Exclude** entries with `type: "session_summary"` from the main table — these are aggregated separately.

### Step 3: Aggregate Data

Group filtered entries by `project` and compute:

- **Sessions**: Count unique `session_id` values
- **Responses**: Count of entries (each entry = one response)
- **Input Tokens**: Sum of `input_tokens`
- **Output Tokens**: Sum of `output_tokens`
- **Cache Creation**: Sum of `cache_creation_tokens`
- **Cache Read**: Sum of `cache_read_tokens`
- **Cost**: Sum of `estimated_cost_usd`

### Step 4: Format Output

#### Default Summary

```markdown
**Cost Report** (last 7 days)

| Project    | Sessions | Responses | Input Tokens | Output Tokens | Cost     |
|------------|----------|-----------|--------------|---------------|----------|
| parcels    | 12       | 145       | 1.2M         | 320K          | $12.45   |
| plan-flow  | 8        | 92        | 890K         | 210K          | $8.72    |
| **Total**  | **20**   | **237**   | **2.1M**     | **530K**      | **$21.17** |
```

#### With `--detail` (model breakdown)

```markdown
**Cost Report** (last 7 days)

| Project    | Model            | Responses | Input     | Output    | Cache Read | Cost    |
|------------|------------------|-----------|-----------|-----------|------------|---------|
| parcels    | claude-opus-5-5  | 45        | 520K      | 180K      | 1.2M       | $9.30   |
| parcels    | claude-sonnet-5-5| 100       | 680K      | 140K      | 890K       | $3.15   |
| plan-flow  | claude-opus-5-5  | 32        | 410K      | 120K      | 780K       | $6.20   |
| plan-flow  | claude-sonnet-5-5| 60        | 480K      | 90K       | 560K       | $2.52   |
| **Total**  |                  | **237**   | **2.1M**  | **530K**  | **3.4M**   | **$21.17** |
```

#### Session Detail (`--session <id>`)

```markdown
**Session Detail**: abc-123

| # | Timestamp | Model | Input | Output | Cache | Cost |
|---|-----------|-------|-------|--------|-------|------|
| 1 | 10:23:15  | opus  | 12K   | 3.2K   | 45K   | $0.24 |
| 2 | 10:25:42  | opus  | 18K   | 5.1K   | 52K   | $0.38 |
| ...| ...      | ...   | ...   | ...    | ...   | ...  |

**Session Total**: 23 responses, $4.82, 45 minutes
```

### Step 5: Token Formatting

Format large numbers for readability:

| Range | Format | Example |
|-------|--------|---------|
| < 1,000 | Raw number | 847 |
| 1,000 - 999,999 | K with 1 decimal | 12.5K |
| >= 1,000,000 | M with 1 decimal | 2.1M |

Cost formatting: Always show 2 decimal places with `$` prefix (e.g., `$12.45`).

## JSONL Entry Schema

Each line in `costs.jsonl` has this structure:

```json
{
  "timestamp": "2026-03-09T14:30:00.000Z",
  "session_id": "abc-123-def",
  "project": "plan-flow",
  "model": "claude-opus-5-5",
  "input_tokens": 12500,
  "output_tokens": 3200,
  "cache_creation_tokens": 9821,
  "cache_read_tokens": 45000,
  "estimated_cost_usd": 0.000243,
  "hook_version": "1.0.0"
}
```

Session summary entries (appended by SessionEnd hook):

```json
{
  "type": "session_summary",
  "timestamp": "2026-03-09T15:00:00.000Z",
  "session_id": "abc-123-def",
  "project": "plan-flow",
  "models": ["claude-opus-5-5"],
  "response_count": 23,
  "total_input_tokens": 287500,
  "total_output_tokens": 73600,
  "total_cache_creation_tokens": 225883,
  "total_cache_read_tokens": 1035000,
  "total_cost_usd": 4.823456,
  "duration_minutes": 45,
  "hook_version": "1.0.0"
}
```

## Error Handling

- If `~/.claude/metrics/costs.jsonl` doesn't exist: Show friendly message, no error
- If file is empty or all lines malformed: Show "No valid cost data found"
- If no entries match filter: Show "No entries found for the selected filter"
