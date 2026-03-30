// Legacy alias retained for older notes/docs.
// Canonical path is now: npm run migrate
import { runMigrations } from './lib/migrationRunner.js';

console.log('[legacy alias] add-first-message-at -> running canonical migrations');
await runMigrations({ logger: console });
