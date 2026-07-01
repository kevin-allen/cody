#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { runCli } from "./cli.js";
import { loadConfig, modelDefForRole } from "./config.js";
import { getModel, assertToolCapable } from "./providers/factory.js";

/** Read the package version from the shipped package.json (next to dist/). */
function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "config") {
    const config = loadConfig({ cwd: process.cwd(), env: process.env, argv: argv.slice(1) });
    const agent = modelDefForRole(config, "agent");
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    process.stdout.write(`\nagent role -> ${agent.provider}:${agent.model}\n`);
    return;
  }

  if (command === "model") {
    const role = argv[1] ?? "agent";
    const config = loadConfig({ cwd: process.cwd(), env: process.env, argv: argv.slice(1) });
    const def = modelDefForRole(config, role);
    const model = getModel(config, role); // throws with a clear message if the API key is missing
    assertToolCapable(model, role);
    process.stdout.write(`${role} -> ${def.provider}:${def.model} (tool-calling: ok)\n`);
    return;
  }

  const result = runCli(argv, readVersion());
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}

try {
  main();
} catch (err) {
  process.stderr.write(`cody: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
