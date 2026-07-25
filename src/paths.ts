import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve private/configuration paths from the installed CLI, not from the
// directory where the user happened to invoke `siys`.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(moduleDir, '..');
export const privateDir = path.join(rootDir, 'private');
export const capturesDir = path.join(privateDir, 'captures');
export const responsesDir = path.join(privateDir, 'responses');
export const storageStatePath = path.join(privateDir, 'storage-state.json');
export const endpointConfigPath = path.join(privateDir, 'endpoints.json');
export const inventoryPath = path.join(rootDir, 'artifacts', 'endpoint-inventory.json');
// Keep generated exports relative to the caller's working directory unless
// the command receives an explicit --out-dir/--output.
export const exportsDir = path.join(process.cwd(), 'exports');
