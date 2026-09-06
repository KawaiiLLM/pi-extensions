# Pi Sync Source Structure Plan

## Goal

Organize `packages/pi-sync/src/` by responsibility and split its mixed-responsibility modules without changing commands, settings, synchronization semantics, or lazy-loading behavior. Implementation was authorized by the user's end-to-end execution request.

## Context

The source currently contains about 15,600 lines in one flat directory. Existing filename groups already identify useful boundaries. The main decomposition targets are `config.ts` (925 lines), `manager-ui.ts` (861), `sync-extension.ts` (765), and `sync-operations.ts` (1,002).

`src/index.ts` already forwards directly to `sync-extension.ts`; `src/sync.ts` is a separate re-export facade used by tests. The published entry is the generated `dist/index.ts`, while the repository registers `src/index.ts`.

Path-sensitive consumers include `scripts/build-runtime.mjs`, `test/build-runtime.test.ts`, the compiled subprocess import in `test/settings-management.test.ts`, and root `test/settings-filesystem-conventions.test.ts`. Build guards currently name individual first-use source paths; moving those paths without updating and checking the inventory could silently weaken coverage.

Root scripts were inspected through `npm run` and `scripts/run-tests.mjs`. `npm test` builds workspaces and compiles test support before running Vitest; it does not forward arbitrary positional test filters. No build or test baseline has been run for this plan. The local Biome binary was absent during inspection.

## Non-Goals

Do not change dependencies, package versions, public routes, UI interactions, settings schema or paths, remote layouts, snapshot formats, concurrency rules, or migration behavior. Do not introduce a plugin registry, DI framework, new shared package, or generic utility layer. Keep active tests under `packages/pi-sync/test/`; do not reorganize unrelated packages or plans.

## Architecture

Use these ownership boundaries. Preserve descriptive filenames during the initial moves; rename only where extraction clarifies responsibility.

| Location | Responsibility and initial source groups |
| --- | --- |
| `src/index.ts` | Thin default-export forwarder; unchanged entry path |
| `src/sync-extension.ts` | Factory registration, session ownership, cancellation controllers, and lifecycle wiring |
| `src/commands/` | `command.ts`, extracted command execution and direct configuration reporting |
| `src/settings/` | `config*`, `settings-management.ts`; settings types, validation, resolution, and mutation APIs |
| `src/sync/` | `sync-operations`, `sync-policy`, `sync-decision`, `sync-state`, `sync-errors`, `remote-snapshot`, and `setup-switch`; synchronization decisions and workflows |
| `src/snapshot/` | `snapshot*`; collection, codec, apply plans, and transaction recovery |
| `src/backends/` | `sync-backend.ts`, `backend-factory.ts`, and transport-specific `git/`, `s3/`, `webdav/` modules |
| `src/state/` | `lock*`, `operation-availability`, `state-directory`, and extracted sync-state persistence |
| `src/ui/` | Manager, attention presentation, settings, selection, review, cancellable UI operations, and formatting |
| `src/ui/setup/` | Setup wizard, setup switching UI, setup actions, provider-specific setup and credential UI |

Keep backend transport implementations independent of TUI. Keep persistence and snapshot primitives independent of menus and command dispatch. Synchronization workflows may continue using Pi contexts and confirmations; extracting a new domain architecture is not required.

Keep domain state and persistence distinct: sync-state comparison belongs in `sync/`, while its filesystem storage belongs in `state/`. Give shared session-path logic an explicit owner after inspecting its callers. Move types alongside their owners only when doing so does not introduce cycles. Do not replace `types.ts` with one file per type or create directory-wide re-export barrels.

Retain `src/sync.ts` as a compatibility facade in this refactor, updating its exports without using it from the runtime entry graph. Do not infer that published deep imports are unused from repository searches alone; inventory existing references and record any additional compatibility decision before moving their targets.

### Required rules and verification

Apply `docs/extension-conventions.md`, `docs/extension-settings.md`, package `AGENTS.md`, and `docs/readme-conventions.md` to the touched areas.

| Touched area | Applicable MUST rules and safety invariants | Named verification |
| --- | --- | --- |
| Source and generated entry graph | Keep the thin source forwarder and one declared package entry; keep generated output self-contained, package imports external, and intentional dynamic imports lazy; resolve every emitted relative import to its exact file | **Validator:** `npm run check:boundaries`; **Test:** `build-runtime.test.ts`, `startup-imports.test.ts`; **Review:** source and generated import inventories; **Smoke:** built package through Pi |
| Lifecycle and command dispatch | No factory-owned background work; release owned resources on shutdown and replacement; reject stale continuations after awaits; preserve routes, completion, observable mode behavior, and status-key cleanup | **Test:** `startup-imports`, `backend-lifecycle`, `custom-lifecycle`, `sync`, and backend route tests; **Review:** cancellation, disposal, replacement, reload, shutdown, and status ownership |
| Settings and state persistence | Preserve mutation order and one cross-process lock across read-modify-write, validation, and atomic same-directory publication; preserve unknown fields, private permissions, invalid-file protection, failure recovery, and current migration behavior | **Test:** `settings-management`, `config-filename`, `v3-schema`, `state-directory`, and root `settings-filesystem-conventions`; **Review:** all reader/writer ordering and lock boundaries |
| UI decomposition | Preserve TUI-only custom flows, supported RPC behavior, keybindings, cancellation, disposal, credential masking, and terminal-input sanitization | **Test:** `custom-lifecycle`, `setup-review`, `setup-name-ui`, `secret-input`, `remote-selection-ui`, and provider UI suites; **Review:** every moved asynchronous UI flow |
| Sync and snapshots | Keep snapshot content IDs, backend references, and opaque revisions distinct; preserve force reread/republication, commit boundaries, recovery, and partial-failure reporting | **Test:** backend contract suites, `backend-orchestration`, `publication`, `sync-snapshot`, `sync-storage`, and `sync-state-revision`; **Review:** push/pull/rollback ordering and recovery paths |
| Documentation and delivery | Keep package layout accurate, preserve required README sections and warnings, run both repository gates, and verify changed publication/loading paths | **Review:** README guide and final diff; **Validator:** `npm run check`; **Test:** `npm test`; **Smoke:** pack inspection and Pi loading |

Test names in this table refer to files under `packages/pi-sync/test/` unless marked root. Review remains required even when tests pass. Before changing code that models Pi runtime behavior, read the installed Pi docs and relevant implementation; this structural refactor does not authorize changing that behavior.

## Plan

### 1. Establish the baseline and migration map

Execution branch: `narumi/refactor/pi-sync-source-structure`, based on `origin/main` at `2311e35b` (no divergence). The only initial change was this untracked plan. `npm install` changed no tracked dependency files. Baseline `npm run check` passed; baseline `npm test` passed 362 files / 3,928 tests. Logs are `/tmp/pi-sync-baseline-{check,test}.log`.

Baseline loader measurements (three separate processes, ms): source `517, 148, 149`; generated `296, 25, 23`. Core imports complete before a readiness handshake starts the load timer. `/tmp/pi-sync-baseline-graph.json` records complete esbuild static/dynamic imports, emitted chunks, and eager inputs. The existing eager graph already includes snapshot collection and sync-state code via shared imports; preserve rather than misrepresent these existing boundaries.

Initial move map below is exhaustive for the 59 existing source files; names are unchanged within each destination. Root `paths.ts` remains a cohesive filesystem/object-key primitive shared by snapshots and backends. The published entry, `sync-extension.ts` dependency-injection surface, `sync.ts` facade, and `types.ts` facade stay compatible. Other flat source paths are implementation modules, not documented package APIs; this approved path migration updates all known repository consumers without adding 54 speculative shims.

| Destination under `src/` | Existing filenames moved there |
| --- | --- |
| unchanged root | `index.ts`, `sync-extension.ts`, `sync.ts`, `types.ts`, `paths.ts` |
| `commands/` | `command.ts` |
| `settings/` | `config.ts`, `config-file.ts`, `config-errors.ts`, `settings-management.ts` |
| `backends/` | `backend-factory.ts`, `sync-backend.ts` |
| `backends/git/` | `git-backend.ts`, `git-config.ts`, `git-runner.ts`, `git-storage.ts` |
| `backends/s3/` | `s3-backend.ts`, `s3-client.ts` |
| `backends/webdav/` | `webdav-backend.ts`, `webdav-client.ts`, `webdav-config.ts` |
| `snapshot/` | `snapshot.ts`, `snapshot-apply.ts`, `snapshot-codec.ts`, `snapshot-paths.ts`, `snapshot-transaction.ts` |
| `state/` | `lock.ts`, `lock-policy.ts`, `lockfile-fs.ts`, `operation-availability.ts`, `state-directory.ts` |
| `sync/` | `remote-snapshot.ts`, `setup-switch.ts`, `sync-decision.ts`, `sync-errors.ts`, `sync-operations.ts`, `sync-policy.ts`, `sync-state.ts` |
| `ui/setup/` | `git-ui.ts`, `webdav-ui.ts`, `s3-credentials-ui.ts`, `setup-location-ui.ts`, `setup-name-ui.ts` |
| `ui/` | `cancellable-operation.ts`, `file-selection.ts`, `manager-attention.ts`, `manager-helpers.ts`, `manager-recovery.ts`, `manager-result-dispatcher.ts`, `manager-state.ts`, `manager-ui.ts`, `remote-selection-ui.ts`, `secret-input.ts`, `settings-ui.ts`, `storage-connections-ui.ts`, `sync-attention.ts`, `sync-format.ts`, `sync-resolution-ui.ts`, `sync-setups-ui.ts` |

All path-sensitive tests and build guards named in Context are included in the move, including relative type queries and the cross-process compiled settings import. Later extractions will update this map with final owners and follow implementation modules in the lazy inventory.

- [x] Prepare dependencies with root `npm install` if needed, then run `npm run check` and `npm test` sequentially; record baseline results and distinguish pre-existing failures before editing source.
- [x] Inventory static imports, dynamic imports, re-exports, source-reading tests, subprocess paths, and published compatibility surfaces; record an old-to-new path map here covering every existing source file and resolve ambiguous owners before moving files.
- [x] Record the baseline eager/lazy source and generated graphs and separate-process package-load samples; verify the inventory includes actual first-use implementation files, not only facade names, and use it for final comparison without a timing threshold.

### 2. Move existing modules without changing logic

Backend/snapshot move evidence: after import organization, `npm run check` and `npm test` passed (362 files / 3,928 tests); `/tmp/pi-sync-move-backends-{check,test}.log`. No algorithm changes.

- [x] Relocate backend and snapshot groups according to the map, preserving internal algorithms and import kinds; update their consumers and build/test path inventories in the same change and verify backend contract, snapshot, and generated-runtime tests through `npm test`.
Remaining move evidence: corrected two over-broad root-test path replacements caught by compilation/full tests; final root-test diff changes only pi-sync paths. `npm run check` and `npm test` passed (362 files / 3,928 tests), `/tmp/pi-sync-move-{check,test}.log`.

- [x] Relocate settings, state, sync, command, and UI groups according to the map, preserving `src/index.ts`, `src/sync-extension.ts`, and the `src/sync.ts` facade; update imports, source-reading assertions, subprocess paths, and build inventories in the same change, then verify `npm run check` and `npm test`.
- [ ] Strengthen the moved lazy-input inventory so each protected path must exist in the build inputs and remain absent from the eager graph; add negative coverage for an absent protected path and a deliberately eager first-use implementation, and verify `build-runtime.test.ts` through `npm test`.

### 3. Extract cohesive responsibilities

- [ ] Extract sync-state persistence and session-path handling from the moved `config.ts` into explicit modules, retaining exact state keys and path semantics; verify state-directory, revision, session, snapshot, and storage tests through `npm test` and audit imports for cycles.
- [ ] Separate the remaining settings validation, resolved configuration, and mutation responsibilities into focused modules; keep the existing `config-file.ts` publication protocol intact and verify schema, cross-process serialization, migration, invalid-file, permission, and unknown-field tests through `npm test`.
- [ ] Extract wizard, switcher, and setup actions from `ui/manager-ui.ts`, placing S3 setup UI beside Git and WebDAV setup UI; leave manager navigation in its original owner and verify setup, manager, provider UI, RPC, and custom lifecycle tests through `npm test`.
- [ ] Extract command execution and automatic-sync workflows from `sync-extension.ts`, keeping cancellation-controller ownership and hook wiring together; preserve lazy loaders, retry behavior, and post-await checks, then verify startup-import, command, attention, and lifecycle tests through `npm test`.
- [ ] Split `sync/sync-operations.ts` into query and mutation responsibilities, keeping each push/pull/rollback transaction readable end to end; keep a small lazy operation facade only if required by loaders, and verify orchestration, forced publication, partial failure, recovery, and backend contracts through `npm test`.
- [ ] Move settings, snapshot, and command types to their owning modules and replace mixed manager helpers with cohesive input/display/data helpers only where callers justify it; verify workspace typechecks and `npm test`, and review for cycles, duplicate implementations, and unnecessary forwarding modules.

Keep pure moves separate from extractions in reviewable changes. Reconcile the lazy-input inventory after every extraction so checks follow implementations rather than obsolete paths. Run builds and tests sequentially; do not run a root gate concurrently with a Kit build/check. Keep every Vitest test within its existing 5,000 ms hard limit. Start subprocess operation/timing deadlines after a readiness handshake and set `PI_CODING_AGENT_DIR` before extension imports in lifecycle tests.

### 4. Verify structure, packaging, and behavior preservation

- [ ] Update only the relevant package-layout guidance in `packages/pi-sync/README.md`; verify maintained directories and entrypoints against the final tree, preserve warnings and required sections, and perform the README guide's fenced-code-aware heading audit.
- [ ] Audit the complete diff against the rules table and import map; verify no backend imports UI, no unintended eager imports or cycles were introduced, settings queues and locks retain one owner, and every source file over 1,000 lines is split by responsibility or has a documented reason to remain intact.
- [ ] Extend generated-runtime verification where needed to inventory every static and dynamic relative import and resolve its exact emitted target; verify generated registration, representative lazy execution, startup, and shutdown through Pi's `DefaultResourceLoader`, not only test-runner imports.
- [ ] Run final `npm run check` and `npm test` sequentially with no affected-test selection override; record results, then compare final eager/lazy graphs and separate-process load samples with the baseline and investigate any new eager dependency.
- [ ] Build with `npm --workspace @narumitw/pi-sync run build --if-present`, run `npm run package:pack -- sync`, and inspect the resulting tarball; verify the declared entry and all relative runtime targets exist and generated code does not import back into source.
- [ ] Smoke the built package in isolated temporary agent/workspace directories through non-interactive Pi RPC with an absolute package path derived from `packages/pi-sync`; verify command registration, a safe lazy manager/setup boundary without saving, and shutdown, then remove temporary resources. Read the installed Pi CLI/RPC documentation before selecting flags. Record any unavailable interactive TUI or provider path explicitly; never sync real user data or run an interactive TUI from the harness.

## Risks

Path-only edits can disable string-based guards without breaking compilation. Import inventories must prove paths exist as well as prove laziness. Extracting settings code can duplicate module-owned queues or alter await ordering. Extracting lifecycle code can detach cancellation from session ownership. Moving snapshot or backend code must not change transaction ordering or recovery behavior.

`src` is published, so external deep-import compatibility cannot be proven by local search. Preserve known facades and document the decision for any additional known supported import before changing it. If a behavior change or breaking compatibility issue becomes necessary, stop and obtain approval rather than including it in structural work.

## Rollback / Recovery

Use Git-based recovery to reverse only the failing structural change while preserving unrelated work. Rebuild generated output from the restored source rather than repairing chunks manually. This plan must not mutate real settings, local sync state, or remote storage, so no user-data migration or rollback is required.

## Completion Checklist

- [ ] All plan tasks have acceptance evidence; unavailable checks remain open until resolved or explicitly accepted by the user with the unverified scope recorded.
- [ ] The final tree matches the recorded ownership map, required facades and entrypoints remain intact, and old paths remain only where intentionally documented for compatibility.
- [ ] Final semantic audits, full repository gates, pack inspection, generated loader tests, and available Pi smokes have recorded results; no claim of live-provider or interactive TUI verification exceeds the evidence.
- [ ] Release scope is confirmed as behavior-preserving: omit a Changeset for pure path/refactor work only when the audit supports it; obtain approval and add a Changeset if published behavior must change. Do not publish, tag, or dispatch release workflows.
- [ ] Handoff names guides, audits, checks, smokes, deviations, and explicitly accepted unverified paths, and reports remaining worktree changes.
- [ ] After every preceding task and completion check is satisfied, delete this completed plan and report `docs/plans/2026-09-06_pi-sync-source-structure-plan.md` as deleted; retain it while any evidence is missing.
