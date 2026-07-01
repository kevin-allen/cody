#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runCli } from "./cli.js";

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

const result = runCli(process.argv.slice(2), readVersion());
process.stdout.write(`${result.output}\n`);
process.exitCode = result.exitCode;
