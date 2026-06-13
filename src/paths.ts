import path from 'node:path';

export const rootDir = process.cwd();
export const privateDir = path.join(rootDir, 'private');
export const capturesDir = path.join(privateDir, 'captures');
export const responsesDir = path.join(privateDir, 'responses');
export const storageStatePath = path.join(privateDir, 'storage-state.json');
export const endpointConfigPath = path.join(privateDir, 'endpoints.json');
export const inventoryPath = path.join(rootDir, 'artifacts', 'endpoint-inventory.json');
export const exportsDir = path.join(rootDir, 'exports');
