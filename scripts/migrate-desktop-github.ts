import { inspectOperatingGitHub, migrateOperatingGitHub } from '../server/desktop-github.ts';
const args = process.argv.slice(2);
try {
  if (args.length === 2 && args[0] === '--inspect') {
    const snapshot = await inspectOperatingGitHub(args[1]);
    process.stdout.write(JSON.stringify({ sha256: snapshot.sha256, ownerKey: snapshot.anchor.ownerKey,
      journalIdentity: snapshot.anchor.journalIdentity, records: snapshot.files.length - 2 }) + '\n');
  } else {
    const names: Record<string, string> = { '--source-root': 'sourceRoot', '--app-data-root': 'appDataRoot', '--resources-root': 'resourceRoot',
      '--config': 'configPath', '--config-sha256': 'configSha256', '--source-sha256': 'sourceSha256' };
    const options: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      const name = names[args[i]], value = args[i + 1]; if (!name || !value || options[name]) throw new Error(); options[name] = value;
    }
    if (Object.keys(options).length !== 6) throw new Error();
    process.stdout.write(JSON.stringify(await migrateOperatingGitHub(options as Parameters<typeof migrateOperatingGitHub>[0])) + '\n');
  }
} catch { process.stderr.write('DESKTOP_GITHUB_MIGRATION_INVALID\n'); process.exitCode = 1; }
