/**
 * @file compose plugin — type definitions.
 */
import type { BuildSpec } from "../buildfile/types";

/**
 *
 */
export type Config = {
  /** Provider passed to promptGen.generate. */
  provider: string;
  /** Max regeneration attempts when output fails IR validation. */
  maxRepairAttempts: number;
};

/**
 *
 */
export type ComposeResult = { spec: BuildSpec; text: string; costUsd: number };

/**
 *
 */
export type ComposeApi = {
  compose(opts: {
    prompt: string;
    emit: "build" | "script";
    name?: string;
    signal?: AbortSignal;
  }): Promise<ComposeResult>;
};
