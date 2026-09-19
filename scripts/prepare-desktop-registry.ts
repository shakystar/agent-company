import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { prepareDesktopRegistryPackage } from './desktop-registry-package.ts';

const [source, destination, namespace, referencesFile, ...extra] = process.argv.slice(2);
if (!source || !destination || !namespace || !referencesFile || extra.length) throw new Error('Usage: prepare-desktop-registry <source-resources> <new-package-directory> <Docker-Hub-namespace> <published-digests.json>');
const references = JSON.parse((await readFile(referencesFile, 'utf8')).replace(/^\uFEFF/, ''));
const result = await prepareDesktopRegistryPackage({ source: resolve(source), destination: resolve(destination), namespace, references });
console.log(JSON.stringify(result));
