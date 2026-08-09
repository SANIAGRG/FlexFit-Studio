# Documents index

Working notes for the FlexFit Studio refactor. Read in whatever order suits you; the table below says what each file is for.

| File | Purpose |
|---|---|
| [discovery-log.md](./discovery-log.md) | How current behavior was worked out — reading order, what surprised me, where source contradicted assumptions. |
| [behavior-spec.md](./behavior-spec.md) | Per-router contract: inputs, outputs, constants, error codes, exact message strings, edge cases. |
| [coverage-matrix.md](./coverage-matrix.md) | Every spec claim mapped to the test that proves it. |
| [architecture-decisions.md](./architecture-decisions.md) | What got consolidated, what deliberately didn't, and why. |
| [known-issues.md](./known-issues.md) | Pre-existing bugs found during discovery, with exact repro steps. |
| [decision-log.md](./decision-log.md) | Running log: decision chosen / alternative considered / why. |
| [ai-usage.md](./ai-usage.md) | Honest running log of AI tool use. |

Status as of 2026-08-09 (Aug 8 work session): test infrastructure built and green (`pnpm test`); `bookings` (22 tests), `corporate-bookings` (10 tests), and `reschedules` (15 tests) all have behavior specs and characterization tests, all passing against unrefactored code. `payments` not started. `architecture-decisions.md` has a first draft. No refactoring has started — per the working brief, all characterization tests must be green against unrefactored code first, which is the Aug 9 checkpoint before any extraction begins.
