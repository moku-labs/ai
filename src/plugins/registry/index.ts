/**
 * Nano tier — dumb task→provider→handler transport (registry).
 *
 * CONSTRAINT: must NEVER become a core plugin — providers register from
 * onInit via ctx.require(registryPlugin), which core-plugin context cannot
 * provide (spec/11 §1.15–1.16).
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
   * @param _ctx - Plugin context (unused in skeleton).
   * @returns Registry API methods.
   * @example
   * ```ts
   * const providers = app.registry.providers("voiceover");
   * ```
   */
  api: _ctx => ({
    /**
     * Registers a handler for (task, provider). Throws on duplicates.
     *
     * @param _task - Task key, e.g. "voiceover".
     * @param _provider - Provider name, e.g. "elevenlabs".
     * @param _handler - Opaque handler (narrowed by the owning task plugin).
     * @example
     * ```ts
     * ctx.require(registryPlugin).register("voiceover", "elevenlabs", handler);
     * ```
     */
    register(_task: string, _provider: string, _handler: unknown): void {
      throw new Error("not implemented");
    },
    /**
     * Resolves a registered handler or undefined.
     *
     * @param _task - Task key.
     * @param _provider - Provider name.
     * @example
     * ```ts
     * const handler = registry.resolve("voiceover", "elevenlabs");
     * ```
     */
    resolve(_task: string, _provider: string): unknown {
      throw new Error("not implemented");
    },
    /**
     * Provider names registered for a task, in registration order.
     *
     * @param _task - Task key.
     * @example
     * ```ts
     * registry.providers("voiceover");
     * ```
     */
    providers(_task: string): string[] {
      throw new Error("not implemented");
    },
    /**
     * All registered task names.
     *
     * @example
     * ```ts
     * registry.tasks();
     * ```
     */
    tasks(): string[] {
      throw new Error("not implemented");
    }
  })
});
