export interface CliResult {
  readonly output: string;
  readonly exitCode: number;
}

const HELP = `cody — a terminal-native, model-agnostic coding assistant.

Usage:
  cody [options]
  cody config            Print the resolved configuration and exit.
  cody model [role]      Show the model a role resolves to (default: agent).
  cody tools             List the tools and their permission policy.

Options:
  -h, --help             Show this help and exit.
  -v, --version          Show the version and exit.
  --model <name>         Use catalog model <name> for the agent role.
  --mode <mode>          Permission mode: supervised | auto | readonly.
  --auto                 Shortcut for --mode auto (unsupervised).
  --readonly             Shortcut for --mode readonly.

cody stays cooperative with your terminal: no full-screen takeover, native
scrollback and copy/paste preserved. The interactive REPL arrives in a later
milestone.`;

/**
 * Pure CLI dispatch: given the argv slice and the resolved version, return the
 * text to print and the process exit code. Kept side-effect free so it can be
 * unit-tested without touching process/stdout.
 */
export function runCli(argv: readonly string[], version: string): CliResult {
  if (argv.includes("-h") || argv.includes("--help")) {
    return { output: HELP, exitCode: 0 };
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    return { output: version, exitCode: 0 };
  }
  // Interactive REPL is not implemented yet (milestone 5).
  return {
    output: `cody ${version}\nInteractive mode is not implemented yet. Run \`cody --help\`.`,
    exitCode: 0,
  };
}
