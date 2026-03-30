// Legacy alias retained for older notes/docs.
// Canonical path is now: npm run migrate
import { runMigrations } from './lib/migrationRunner.js';

console.log('[legacy alias] add-group-permissions -> running canonical migrations');
await runMigrations({ logger: console });
