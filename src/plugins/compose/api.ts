/**
 * @file compose plugin — API factory (`app.compose.compose`).
 *
 * Orchestrates prompt -> promptGen.generate -> buildfile.compile (zod
 * validation) -> on failure, re-prompt with the validation issue, bounded by
 * `config.maxRepairAttempts` additional attempts -> emit. Reaches
 * prompt-gen exclusively through the `promptGen` facade — the audited
 * registry cast belongs to the task plugin, not compose (ratified
 * decision) — so `registry` is never `ctx.require`d here.
 */
import { buildfilePlugin } from "../buildfile";
import type { BuildfileApi, BuildSpec } from "../buildfile/types";
import { promptGenPlugin } from "../promptGen";
import type { PromptGenApi } from "../promptGen/types";
import { emitScript, emitYaml, schemaPathFromTemplate } from "./emit";
import type { ComposeApi, ComposeContext } from "./types";

const TASK_INPUT_DOCS = [
  'Per-task "input" documentation for the available M0 tasks (task -> required input fields):',
  "- voiceover: { text: string, voice: string }",
  "- translate: { text: string, targetLang: string }",
  "- prompt-gen: { prompt: string }"
].join("\n");

const FENCE_PATTERN = /^```(?:[A-Za-z]*)\n([\s\S]*?)\n?```$/;

/**
 * Strips a defensive markdown code fence (` ```yaml ... ``` ` or
 * ` ``` ... ``` `) from model output, so a fenced response still parses as
 * plain YAML.
 *
 * @param text - Raw model output, possibly fenced.
 * @returns `text` with a single wrapping fence removed, trimmed.
 * @example
 * ```ts
 * stripFences("```yaml\nversion: 1\n```"); // "version: 1"
 * ```
 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = FENCE_PATTERN.exec(trimmed);

  return fenced?.[1] ?? trimmed;
}

/**
 * Builds the system prompt every compose generation attempt sends: the JSON
 * Schema `buildfile.jsonSchema()` returns, plus per-task input
 * documentation, so the model has everything it needs to produce a valid
 * build file.
 *
 * @param schema - The JSON Schema from `buildfile.jsonSchema()`.
 * @returns The system prompt text.
 * @example
 * ```ts
 * buildSystemPrompt(buildfile.jsonSchema());
 * ```
 */
function buildSystemPrompt(schema: Record<string, unknown>): string {
  return [
    "You generate Moku build files: a YAML document describing AI-generation tasks to run.",
    "Respond with ONLY the YAML build file text - no prose, no markdown code fences.",
    "The build file MUST validate against this JSON Schema:",
    JSON.stringify(schema),
    TASK_INPUT_DOCS
  ].join("\n\n");
}

/**
 * Builds a re-prompt for a repair attempt: the original request, the
 * previous (invalid) output, and the validation issue it failed with.
 *
 * @param prompt - The caller's original natural-language prompt.
 * @param previousOutput - The previous attempt's fence-stripped output.
 * @param issue - The validation error message the previous output failed with.
 * @returns The repair prompt text.
 * @example
 * ```ts
 * buildRepairPrompt("a sunset build", "version: 2\n", 'version: Invalid literal value, expected 1');
 * ```
 */
function buildRepairPrompt(prompt: string, previousOutput: string, issue: string): string {
  return [
    `Original request: ${prompt}`,
    `Your previous YAML output:\n${previousOutput}`,
    `That output failed validation with:\n${issue}`,
    "Produce a corrected build file that fixes this issue and still satisfies the schema."
  ].join("\n\n");
}

/**
 * Builds the exact two-line "repair attempts exhausted" error.
 *
 * @param attempts - Total generation attempts made before giving up.
 * @returns The pinned two-line `Error`.
 * @example
 * ```ts
 * throw repairExhaustedError(3);
 * ```
 */
function repairExhaustedError(attempts: number): Error {
  return new Error(
    `[ai] Compose could not produce a valid build file after ${attempts} attempts.\n  Refine the prompt or write the build file manually with "moku new".`
  );
}

/**
 * Emits a validated spec as either YAML build-file text or a `defineBuild()`
 * TypeScript module, per `emit`.
 *
 * @param spec - The validated build spec.
 * @param emit - `"build"` for YAML text, `"script"` for a TS module.
 * @param buildfile - The `buildfile` API, used to derive the YAML modeline's schema path.
 * @returns The emitted text.
 * @example
 * ```ts
 * emitSpec(spec, "build", buildfile);
 * ```
 */
function emitSpec(spec: BuildSpec, emit: "build" | "script", buildfile: BuildfileApi): string {
  if (emit === "script") return emitScript(spec);

  const schemaPath = schemaPathFromTemplate(buildfile.template({ name: spec.name }));
  return emitYaml(spec, schemaPath);
}

/**
 * Builds the `promptGen.generate` options for one attempt: the configured
 * provider plus the caller's abort signal, omitted entirely (never set to
 * `undefined`) when absent, as required under `exactOptionalPropertyTypes`.
 *
 * @param provider - The provider to request generation from.
 * @param signal - The caller's abort signal, if any.
 * @returns The options object to forward to `PromptGenApi.generate`.
 * @example
 * ```ts
 * toGenerateOptions("openai", controller.signal);
 * ```
 */
function toGenerateOptions(
  provider: string,
  signal: AbortSignal | undefined
): { provider: string; signal?: AbortSignal } {
  return signal === undefined ? { provider } : { provider, signal };
}

/** The outcome of one generate -> compile attempt. */
type AttemptOutcome =
  | { ok: true; spec: BuildSpec; costUsd: number }
  | { ok: false; output: string; issue: string; costUsd: number };

/**
 * Runs one generate -> compile attempt, returning either the validated spec
 * or the fence-stripped output plus the validation issue it failed with, so
 * the caller can build a repair prompt for the next attempt. Either way,
 * this attempt's `costUsd` is reported so the caller can accumulate it.
 *
 * @param promptGen - The `promptGen` API.
 * @param buildfile - The `buildfile` API.
 * @param promptText - The prompt to send this attempt.
 * @param system - The system prompt (JSON Schema + task docs).
 * @param provider - The configured/requested provider.
 * @param signal - The caller's abort signal, if any.
 * @returns The validated spec, or the failed output and its issue — either way, this attempt's cost.
 * @example
 * ```ts
 * const outcome = await runAttempt(promptGen, buildfile, prompt, system, "openai", undefined);
 * ```
 */
async function runAttempt(
  promptGen: PromptGenApi,
  buildfile: BuildfileApi,
  promptText: string,
  system: string,
  provider: string,
  signal: AbortSignal | undefined
): Promise<AttemptOutcome> {
  const generated = await promptGen.generate(
    { prompt: promptText, system },
    toGenerateOptions(provider, signal)
  );
  const output = stripFences(generated.text);

  try {
    const compiled = await buildfile.compile({ text: output, lang: "yaml" });
    return { ok: true, spec: compiled.spec, costUsd: generated.costUsd };
  } catch (error) {
    const issue = error instanceof Error ? error.message : String(error);
    return { ok: false, output, issue, costUsd: generated.costUsd };
  }
}

/**
 * Applies `opts.name`'s override onto a validated spec, if given. A plain
 * string override never invalidates an already-validated spec, so no
 * re-compile is needed.
 *
 * @param spec - The compiled, validated spec.
 * @param name - An explicit `name` override, if given.
 * @returns `spec`, with `name` replaced when `name` is given.
 * @example
 * ```ts
 * applyNameOverride(spec, "custom-name");
 * ```
 */
function applyNameOverride(spec: BuildSpec, name: string | undefined): BuildSpec {
  return name === undefined ? spec : { ...spec, name };
}

/**
 * Creates the compose API surface (`app.compose.compose`).
 *
 * @param ctx - Plugin context: config plus `require` narrowed to buildfile/promptGen.
 * @returns The `app.compose` API.
 * @example
 * ```ts
 * const api = createComposeApi(ctx);
 * const { spec, text } = await api.compose({ prompt: "...", emit: "build" });
 * ```
 */
export function createComposeApi(ctx: ComposeContext): ComposeApi {
  return {
    /**
     * Generates a build file from a natural-language prompt, validating
     * every candidate through `buildfile.compile` and re-prompting on
     * failure (bounded by `config.maxRepairAttempts` additional attempts).
     *
     * @param opts - Compose options.
     * @param opts.prompt - The natural-language build description.
     * @param opts.emit - `"build"` for YAML text, `"script"` for a `defineBuild()` TS module.
     * @param opts.name - Overrides the generated spec's `name` field.
     * @param opts.signal - Optional abort signal forwarded to every `promptGen.generate` call.
     * @returns The validated spec, its emitted text, and the total generation cost.
     * @throws {Error} The pinned two-line error when every attempt fails IR validation.
     * @example
     * ```ts
     * await app.compose.compose({ prompt: "narrate a greeting", emit: "build" });
     * ```
     */
    compose: async opts => {
      // Resolve dependencies once and build the system prompt every attempt reuses.
      const buildfile = ctx.require(buildfilePlugin);
      const promptGen = ctx.require(promptGenPlugin);
      const system = buildSystemPrompt(buildfile.jsonSchema());
      const totalAttempts = ctx.config.maxRepairAttempts + 1;

      // Attempt generation, re-prompting with the previous validation issue on failure.
      let costUsd = 0;
      let previousOutput = "";
      let previousIssue = "";

      for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        const promptText =
          attempt === 1
            ? opts.prompt
            : buildRepairPrompt(opts.prompt, previousOutput, previousIssue);
        const outcome = await runAttempt(
          promptGen,
          buildfile,
          promptText,
          system,
          ctx.config.provider,
          opts.signal
        );
        costUsd += outcome.costUsd;

        if (outcome.ok) {
          const spec = applyNameOverride(outcome.spec, opts.name);
          return { spec, text: emitSpec(spec, opts.emit, buildfile), costUsd };
        }

        previousOutput = outcome.output;
        previousIssue = outcome.issue;
      }

      // Every attempt failed IR validation — give up with the pinned two-line error.
      throw repairExhaustedError(totalAttempts);
    }
  };
}
