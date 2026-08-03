import fs from 'node:fs';

interface PackageMetadata { version?: unknown }

const metadata = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata;
if (typeof metadata.version !== 'string' || !metadata.version) throw new Error('package.json no contiene una versión válida.');

export const packageVersion = metadata.version;
