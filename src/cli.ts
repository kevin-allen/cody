export interface CliResult {
  readonly output: string;
  readonly exitCode: number;
}

const HELP = `cody — a terminal-native, model-agnostic coding assistant.

Usage:
  cody [options]         Start the interactive session (REPL).
  cody run "<task>"      Run one agent turn headlessly and print the result.
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
scrollback and copy/paste preserved.`;

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
  // Fallback text; the entrypoint routes a bare invocation to the REPL instead.
  return {
    output: `cody ${version} — run \`cody\` to start the interactive session, or \`cody --help\` for usage.`,
    exitCode: 0,
  };
}
