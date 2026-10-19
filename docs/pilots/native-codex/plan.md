# Plan: Native Codex pilot

## Intent
Goal: a reproducible CLI smoke fixture and integration limits document.
Constraints: no global setup, no provider/account changes, no shared stores.
Ruled Out: business features, installer rewrite and app Autopilot parity.
Discovery: flow/discovery/discovery_native_codex_pilot_v1.md

### Phase 1: CLI smoke fixture
**Complexity**: 2/10
**Dependencies**: none

- [x] Add scripts/native-codex-smoke.mjs using Node built-ins and a disposable target.
  <verify>node scripts/native-codex-smoke.mjs</verify>

### Phase 2: Document and review
**Complexity**: 1/10
**Dependencies**: Phase 1

- [x] Document observed native integration limits, commands and results.
  <verify>git diff --check</verify>

### Phase 3: Native instruction and skill entry points
**Complexity**: 2/10
**Dependencies**: Phase 2

- [x] Add root AGENTS.md and a repository-local PlanFlow skill linking to existing command bodies.
- [x] Validate discovery metadata and local reference integrity.
  <verify>node --test scripts/native-codex-entrypoints.test.mjs</verify>
- [x] Diagnose standalone CLI failure without modifying global settings; record its external-CLI scope separately from native validation.

- [x] Record fresh native-task evidence: automatic AGENTS.md, linked skill access and passing native fixture/tests; retain the catalog-registration and Autopilot limits.
