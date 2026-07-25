import path from 'node:path';
import { config } from 'dotenv';
import { rootDir } from './paths.js';

// dotenv/config only checks process.cwd(). Load the CLI's own .env so the
// credentials are available even when `siys` is run from another directory.
config({ path: path.join(rootDir, '.env'), quiet: true });
