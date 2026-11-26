#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runCli } from './node/run.js';

const code = await runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cwd: process.cwd(),
  isTTY: Boolean(process.stdout.isTTY),
  env: process.env,
  readStdin: () => readFileSync(0, 'utf8'),
});
process.exitCode = code;
