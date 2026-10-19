// Discover repository script regressions without relying on shell glob expansion.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = new URL('./', import.meta.url);
const tests = readdirSync(directory).filter((name) => name.endsWith('.test.mjs')).sort();
if (tests.length === 0) throw new Error('No instruction regression tests found');
const result = spawnSync(process.execPath, ['--test', ...tests.map((name) => fileURLToPath(new URL(name, directory)))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
