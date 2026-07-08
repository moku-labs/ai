# @moku-labs/ai

A build system for AI-generated assets — declarative build files in, artifacts out. Any task × any provider × any account pool. Resumable always, incremental by default, never loses a byte of progress. Built on @moku-labs/core.

## Package Manager

Use `bun` exclusively — never npm, yarn, or pnpm.

## Scripts

- `bun run build` — Build with tsdown
- `bun run lint` — Biome check + ESLint
- `bun run lint:fix` — Auto-fix lint issues
- `bun run format` — Format with Biome
- `bun run test` — Run all tests (vitest)
- `bun run test:unit` — Unit tests only
- `bun run test:integration` — Integration tests only
- `bun run test:coverage` — Tests with coverage

## Code Style

- **Formatter:** Biome (2-space indent, double quotes, semicolons, no trailing commas)
- **Linter:** ESLint 9 flat config + Biome (`eslint-config-biome` must be LAST)
- **TypeScript:** Strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- **Imports:** Use `import type` enforced via `@typescript-eslint/consistent-type-imports`
- **JSDoc:** Required on all source exports with descriptions, params, returns, and examples

## Architecture

Three-layer Moku model:
1. `src/config.ts` — `createCoreConfig` (Layer 1: config + events)
2. `src/index.ts` — `createCore` (Layer 2: framework + plugins)
3. Consumer apps use `createApp` (Layer 3)

Plugins go in `src/plugins/`.

The framework registers `logPlugin` + `envPlugin` from `@moku-labs/common` in `createCoreConfig`, so
every plugin's `ctx` is injected with `ctx.log` (structured logging) and `ctx.env` (validated
environment access). Consumer apps inherit both — they do NOT register them.

## Family Conventions (@moku-labs/common)

Plugin/CLI/script source MUST follow the family conventions (enforced by the `validate-common-usage`
hook + `moku-common-validator`). Emit compliant code on the first try:

- **MC1 — branded CLI.** Render any CLI surface (a `cli` plugin, `scripts/*.ts`, a `bin`) through
  `@moku-labs/common/cli` (`createBrandConsole`, `box`, `spinnerFrameAt`, styled `confirm`/`select`).
  No hand-rolled ANSI escapes, box-drawing, or spinner animations.
- **MC2 — `ctx.log`, not `console.*`.** Log diagnostics/events via `ctx.log.info/warn/error/debug`.
- **MC3 — `ctx.env`, not `process.env`.** Read env via `ctx.env.require("NAME")` / `ctx.env.get("NAME")`.

See the **moku-common** skill for full rules, examples, and the allowed exceptions.

## Testing

- Vitest with unit + integration projects
- Framework-level tests: `tests/unit/` and `tests/integration/` (cross-plugin scenarios, `createApp` validation)
- Plugin-specific tests: `src/plugins/[name]/__tests__/unit/` and `__tests__/integration/` (colocated inside each plugin)
- 90% coverage threshold
- Never put plugin-specific tests in root `tests/` — root tests are for framework-level integration only

## Moku Development Toolkit

This project uses the **moku** Claude Code plugin for development workflows. Below are the available commands, skills, and agents.

### Commands (slash commands)

**Planning:**
- `/moku:brainstorm [create|resume] [framework|app] "description"` — Explore architecture decisions via a Present→Challenge→Decide debate loop before planning. Optional; recommended for novel or complex domains.
- `/moku:plan [create|update|add|migrate|resume] [type] [args]` — 3-stage gated workflow to plan a framework, consumer app, or plugin. Type synonyms: tool/engine/library → framework, application/service/server/game → app. Output goes to `.planning/specs/` (framework/plugin) or `.planning/app-spec.md` (app).

**Building:**
- `/moku:build [framework|app|plugin] [spec-or-name]` — Build from specifications. Auto-detects what to build, resumes if partially built. Supports `/moku:build plugin #3` for individual plugins.

**Setup:**
- `/moku:init` — Initialize a new Moku project with full tooling (used to create this project).

### Skills (automatic context)

Skills load automatically when relevant. You can also reference them explicitly:

- **moku-core** — Architecture rules, factory chain, lifecycle, event system, context tiers. Use when working with `createCoreConfig`, `createCore`, `createApp`, or the three-layer model.
- **moku-plugin** — Plugin structure, complexity tiers (Nano → VeryComplex), file organization, wiring harness pattern. Use when creating or reviewing plugin code.
- **moku-common** — `@moku-labs/common`: the branded CLI renderer, `logPlugin`/`ctx.log`, and `envPlugin`/`ctx.env`. Use when wiring shared CLI/log/env infrastructure.
- **moku-readable-code** — Function-body readability style (stanzas, guard clauses, named predicates). Use when writing or reviewing function bodies.
- **moku-testing** — TDD protocol for build waves, mock context factories, integration scaffolds, type-level tests.

### Agents (validation)

Agents run autonomously to validate code. Build commands call them automatically, but they can also be triggered manually:

- **moku-spec-validator** — Moku Core spec compliance: three-layer separation, factory chain, config, lifecycle, events, error formats.
- **moku-plugin-spec-validator** — Plugin structure: correct tier, file organization, JSDoc coverage, test existence, no anti-patterns.
- **moku-jsdoc-validator** — JSDoc completeness: all exports have descriptions, `@param`, `@returns`, `@example`.
- **moku-common-validator** — Family conventions MC1–MC3 (branded CLI, `ctx.log`, `ctx.env`).
- **moku-type-validator** / **moku-test-validator** / **moku-verifier** — Type correctness, test quality, and artifact verification.

### Typical Workflows

**New framework from scratch:**
1. (Optional) `/moku:brainstorm create framework "..."` — explore architecture decisions
2. `/moku:plan create framework "..."` — design plugins and structure (approval gates)
3. `/moku:build framework` — implement everything from specs; validators run automatically

**Add a single plugin:**
1. `/moku:plan add plugin <name> "..."` — create plugin spec
2. `/moku:build add <name>` — build, wire, and verify the planned plugin

**Update an existing plugin:**
1. `/moku:plan update plugin <name> "..."` — produces updated spec
2. `/moku:build plugin <name>` — implement changes from updated spec

**Manual validation:**
- Ask Claude to "run the spec validator" or "validate JSDoc" on specific files

## Specification

For questions about how things should be implemented, refer to the [Moku Core specification](https://github.com/moku-labs/core/tree/main/specification).
