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

Status as of 2026-08-09 (Aug 9 work session): all four priority routers (`bookings`, `corporate-bookings`, `reschedules`, `payments`) have behavior specs and characterization tests — 64 tests, `pnpm test` green and stable across repeated runs. The Aug 9 refactor has landed: `hoursUntil`, the four time/credit constants, the reschedule validation ladder, and capacity counting are all extracted into `src/server/booking/`, each step verified with a full suite run and a clean `npx tsc --noEmit` before moving to the next. `architecture-decisions.md` reflects what was actually built, including one plan revision made mid-extraction (see its `capacity.ts` section). No router's public procedure signature, and no file under `src/app/` or `src/components/`, changed at all — only what was inside procedure bodies moved.
