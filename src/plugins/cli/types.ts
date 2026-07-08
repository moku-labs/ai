/**
 * @file cli plugin — type definitions.
 */
export type Config = {
  /** Disable ANSI color/spinners (auto-disabled when !TTY or NO_COLOR). */
  plain: boolean;
};

/**
 *
 */
export type CommandTree = {
  name: string;
  description: string;
  commands: Array<{ name: string; description: string; flags: Record<string, string> }>;
};

/**
 *
 */
export type CliApi = {
  dispatch(argv: string[]): Promise<number>;
  commands(): CommandTree;
};
