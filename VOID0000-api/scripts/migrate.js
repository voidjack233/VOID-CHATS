#!/usr/bin/env node
import { runMigrations } from './lib/migrationRunner.js';

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');

try {
  await runMigrations({ statusOnly, logger: console });
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
