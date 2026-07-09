/**
 * Nano tier — dumb task→provider→handler transport (registry).
 *
 * PERMANENT CONSTRAINT: must NEVER become a core plugin — providers register
 * from onInit via `ctx.require(registryPlugin)`, and `require`/`depends` are
 * structurally unavailable in core-plugin context (spec/11 §1.15–1.16). The
 * registry itself never inspects, wraps, or types what it transports.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";

/**
 * registry — Nano plugin. Dumb task→provider→handler transport; resolve()
 * returns unknown, narrowed by each task plugin at its own audited cast site.
 *
 * @see README.md
 */
export const registryPlugin = createPlugin("registry", {
  /**
   * Creates the registry state (task → provider → handler map).
   *
   * @returns Initial registry state.
   * @example
   * ```ts
   * const state = createState();
   * ```
   */
  createState: (): { handlers: Map<string, Map<string, unknown>> } => ({ handlers: new Map() }),
  /**
   * Builds the registry API surface.
   *
   * @param ctx - Plugin context; only `ctx.state` is read/mutated.
   * @returns Registry API methods.
   * @example
   * ```ts
   * const providers = app.registry.providers("voiceover");
   * ```
   */
  api: ctx => ({
    /**
     * Registers a handler for (task, provider). Throws on duplicates.
     *
     * @param task - Task key, e.g. "voiceover".
     * @param provider - Provider name, e.g. "elevenlabs".
     * @param handler - Opaque handler (narrowed by the owning task plugin).
     * @throws {Error} When (task, provider) is already registered.
     * @example
     * ```ts
     * ctx.require(registryPlugin).register("voiceover", "elevenlabs", handler);
     * ```
     */
    register(task: string, provider: string, handler: unknown): void {
      const taskProviders = ctx.state.handlers.get(task) ?? new Map<string, unknown>();
      if (taskProviders.has(provider)) {
        throw new Error(
          `[ai] Provider "${provider}" is already registered for task "${task}".\n  Register each task/provider pair exactly once.`
        );
      }
      taskProviders.set(provider, handler);
      ctx.state.handlers.set(task, taskProviders);
    },
    /**
     * Resolves a registered handler or undefined.
     *
     * @param task - Task key.
     * @param provider - Provider name.
     * @returns The registered handler, or undefined when unregistered.
     * @example
     * ```ts
     * const handler = registry.resolve("voiceover", "elevenlabs");
     * ```
     */
    resolve(task: string, provider: string): unknown {
      return ctx.state.handlers.get(task)?.get(provider);
    },
    /**
     * Provider names registered for a task, in registration order.
     *
     * @param task - Task key.
     * @returns Provider names, first-registered first (the task default).
     * @example
     * ```ts
     * registry.providers("voiceover");
     * ```
     */
    providers(task: string): string[] {
      return [...(ctx.state.handlers.get(task)?.keys() ?? [])];
    },
    /**
     * All registered task names.
     *
     * @returns Task names in registration order.
     * @example
     * ```ts
     * registry.tasks();
     * ```
     */
    tasks(): string[] {
      return [...ctx.state.handlers.keys()];
    }
  })
});
