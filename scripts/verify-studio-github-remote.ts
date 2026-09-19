import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { GitHubAppAuth, readGitHubConfig } from '../server/github-auth.ts';
import { githubFilePath, GitHubTransport } from '../server/github-transport.ts';

// This observer never opens the operating database/journal or calls a mutation.
// Expected hashes/receipts are supplied by the operator; they are not a claim
// that this process independently audited the operation journal or model trace.
const repository = 'formnest-studio/studio-site';
const repositoryId = 1362601656;
const base = 'main';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const publication = z.object({ branch: z.string().max(200), headSha: sha }).strict();
const pullRequest = z.object({ number: z.number().int().positive().safe(), headSha: sha }).strict();
export const studioRemoteProofSchema = z.object({
  version: z.literal(1), runId: z.uuid(), operationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  mainSha: sha, publication, retryPublication: publication.optional(),
  pullRequest, retryPullRequest: pullRequest.optional(),
  files: z.array(z.object({ path: z.string().max(500).refine(path => {
    try { return githubFilePath(path) === path; } catch { return false; }
  }), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(100),
  // These documents were generated during publication, not preserved as source
  // artifacts. Their remote hashes must never become expected source hashes.
  unverifiedAncillaryFiles: z.array(z.enum(['publication/README.md', 'publication/source-manifest.json'])).max(2).optional(),
}).strict().superRefine((value, ctx) => {
  const branch = `agent-company/${value.runId}/${value.operationId}`;
  if (value.publication.branch !== branch || value.retryPublication && value.retryPublication.branch !== branch)
    ctx.addIssue({ code: 'custom', message: 'Run branch mismatch.' });
  const paths = [...value.files.map(file => file.path), ...value.unverifiedAncillaryFiles ?? []];
  if (new Set(paths).size !== paths.length || paths.length > 100)
    ctx.addIssue({ code: 'custom', message: 'Duplicate expected file.' });
  if (value.publication.headSha === value.mainSha || value.pullRequest.headSha !== value.publication.headSha
    || value.retryPublication && value.retryPublication.headSha !== value.publication.headSha
    || value.retryPullRequest && (value.retryPullRequest.headSha !== value.publication.headSha || value.retryPullRequest.number !== value.pullRequest.number))
    ctx.addIssue({ code: 'custom', message: 'Receipt mismatch.' });
});
type Proof = z.infer<typeof studioRemoteProofSchema>;
type ReadTransport = Pick<GitHubTransport, 'inspect' | 'listFiles' | 'readFile' | 'getPullRequest'>;
class VerificationError extends Error {
  constructor(readonly code: string) { super(code); }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new VerificationError(code);
}
function parseProof(value: unknown): Proof {
  const result = studioRemoteProofSchema.safeParse(value);
  check(result.success, 'EXPECTED_EVIDENCE_INVALID');
  return result.data;
}

/** Public read API only. Tests inject this narrow interface, never live auth. */
export async function verifyStudioGitHubRemote(transport: ReadTransport, input: unknown, signal?: AbortSignal) {
  const proof = parseProof(input), startedAt = new Date().toISOString();
  const info = await transport.inspect(repository, signal);
  check(info.id === repositoryId && info.fullName === repository && info.defaultBranch === base && info.private, 'REPOSITORY_IDENTITY_CHANGED');
  const initialMain = await transport.listFiles(repository, base, signal);
  check(initialMain.headSha === proof.mainSha, 'MAIN_CHANGED');
  const pr = await transport.getPullRequest(repository, proof.pullRequest.number, signal);
  check(pr.number === proof.pullRequest.number && pr.url === `https://github.com/${repository}/pull/${pr.number}`
    && pr.head === proof.publication.branch && pr.base === base && pr.headSha === proof.publication.headSha
    && pr.baseSha === proof.mainSha && pr.state === 'open' && pr.merged === false, 'PULL_REQUEST_MISMATCH');
  const head = await transport.listFiles(repository, proof.publication.branch, signal);
  check(head.headSha === proof.publication.headSha, 'PUBLICATION_HEAD_CHANGED');
  check(!initialMain.truncated && !head.truncated && initialMain.omittedFiles === 0 && head.omittedFiles === 0, 'INCOMPLETE_FILE_LIST');
  const baseFiles = new Map(initialMain.files.map(file => [file.path, file]));
  const headFiles = new Map(head.files.map(file => [file.path, file]));
  const ancillaryPaths = proof.unverifiedAncillaryFiles ?? [];
  const expected = new Set([...proof.files.map(file => file.path), ...ancillaryPaths]);
  check(baseFiles.size === initialMain.files.length && headFiles.size === head.files.length, 'DUPLICATE_FILE_PATH');
  check([...baseFiles.keys()].every(path => headFiles.has(path)), 'UNEXPECTED_DELETION');
  const changedFiles = head.files.filter(file => baseFiles.get(file.path)?.sha !== file.sha).map(file => file.path).sort();
  check(changedFiles.length > 0 && changedFiles.every(path => expected.has(path)), 'UNEXPECTED_CHANGED_FILES');
  const verifiedFiles: Array<{ path: string; bytes: number; gitBlobSha: string; sha256: string; sourceMatched: true }> = [];
  for (const expectedFile of [...proof.files].sort((a, b) => a.path.localeCompare(b.path))) {
    signal?.throwIfAborted();
    check(headFiles.has(expectedFile.path), 'EXPECTED_FILE_MISSING');
    // Pin every file read to the receipt commit, never to a mutable branch.
    const file = await transport.readFile(repository, expectedFile.path, proof.publication.headSha, signal);
    check(file.path === expectedFile.path && file.ref === proof.publication.headSha && file.headSha === proof.publication.headSha
      && file.sha === headFiles.get(expectedFile.path)?.sha && file.encoding === 'utf-8', 'FILE_IDENTITY_MISMATCH');
    const contentSha256 = createHash('sha256').update(file.content, 'utf8').digest('hex');
    check(contentSha256 === expectedFile.sha256, 'FILE_CONTENT_MISMATCH');
    verifiedFiles.push({ path: file.path, bytes: Buffer.byteLength(file.content, 'utf8'), gitBlobSha: file.sha, sha256: contentSha256, sourceMatched: true });
  }
  const unverifiedAncillaryFiles: Array<{ path: string; bytes: number; gitBlobSha: string; contentSha256: string; sourceMatched: false }> = [];
  for (const path of [...ancillaryPaths].sort()) {
    signal?.throwIfAborted();
    check(headFiles.has(path), 'ANCILLARY_FILE_MISSING');
    const file = await transport.readFile(repository, path, proof.publication.headSha, signal);
    check(file.path === path && file.ref === proof.publication.headSha && file.headSha === proof.publication.headSha
      && file.sha === headFiles.get(path)?.sha && file.encoding === 'utf-8', 'FILE_IDENTITY_MISMATCH');
    unverifiedAncillaryFiles.push({ path, bytes: Buffer.byteLength(file.content, 'utf8'), gitBlobSha: file.sha,
      contentSha256: createHash('sha256').update(file.content, 'utf8').digest('hex'), sourceMatched: false });
  }
  // Close the observation window: reject a concurrent main/branch/PR movement.
  const finalMain = await transport.listFiles(repository, base, signal);
  const finalHead = await transport.listFiles(repository, proof.publication.branch, signal);
  const finalPr = await transport.getPullRequest(repository, proof.pullRequest.number, signal);
  check(finalMain.headSha === proof.mainSha, 'MAIN_CHANGED');
  check(finalHead.headSha === proof.publication.headSha, 'PUBLICATION_HEAD_CHANGED');
  check(finalPr.number === pr.number && finalPr.head === pr.head && finalPr.base === pr.base && finalPr.url === pr.url
    && finalPr.headSha === pr.headSha && finalPr.baseSha === pr.baseSha && finalPr.state === 'open' && finalPr.merged === false, 'PULL_REQUEST_CHANGED');
  return {
    version: 1, status: 'verified-with-explicit-limits', startedAt, completedAt: new Date().toISOString(),
    repository: { fullName: repository, id: repositoryId, private: true }, runId: proof.runId, operationId: proof.operationId,
    main: { branch: base, expectedSha: proof.mainSha, beforeSha: initialMain.headSha, afterSha: finalMain.headSha, unchanged: true },
    publication: { branch: head.ref, headSha: head.headSha, changedFiles, files: verifiedFiles, unverifiedAncillaryFiles,
      sourceComparison: { expectedSourceFileCount: proof.files.length, matchedSourceFileCount: verifiedFiles.length,
        unverifiedAncillaryFileCount: unverifiedAncillaryFiles.length, allPublicationFilesSourceMatched: unverifiedAncillaryFiles.length === 0,
        ancillaryEvidence: 'Remote bytes were read and hashed only; no prior source hash exists. Ancillary files are excluded from source-match claims.' },
      completeHeadFileList: head.files.map(file => ({ path: file.path, gitBlobSha: file.sha, bytes: file.size })) },
    pullRequest: { number: pr.number, url: pr.url, head: pr.head, base: pr.base, headSha: pr.headSha, baseSha: pr.baseSha, state: pr.state, merged: pr.merged },
    replay: { evidenceSource: 'operator-supplied-receipts', publicationReceiptMatches: proof.retryPublication ? true : null,
      pullRequestReceiptMatches: proof.retryPullRequest ? true : null },
    limits: { entireRemoteCommitHistoryVerified: false, entireRemotePullRequestCountVerified: false,
      reason: 'The existing public read transport does not expose commit ancestry or complete PR enumeration; matching receipts and the observed remote HEAD do not prove global duplicate absence.' },
    remoteRepositoryWrites: 0, operatingDatabaseAccess: false,
  };
}

async function readProof(path: string) {
  const original = await lstat(path);
  check(original.isFile() && !original.isSymbolicLink() && original.nlink === 1 && original.size > 0 && original.size <= 65_536, 'EXPECTED_EVIDENCE_FILE_INVALID');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const actual = await file.stat();
    check(actual.isFile() && actual.nlink === 1 && actual.size === original.size && actual.dev === original.dev && actual.ino === original.ino, 'EXPECTED_EVIDENCE_FILE_CHANGED');
    const bytes = Buffer.alloc(65_537); let size = 0;
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    check(size === original.size && size <= 65_536, 'EXPECTED_EVIDENCE_FILE_CHANGED');
    return parseProof(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))));
  } finally { await file.close(); }
}

const usage = `Read-only Formnest GitHub publication verification.
Usage: npx tsx scripts/verify-studio-github-remote.ts --proof <expected-evidence.json>
Required proof: {version:1,runId,operationId,mainSha,publication:{branch,headSha},pullRequest:{number,headSha},files:[{path,sha256}]}
Optional proof: retryPublication:{branch,headSha}, retryPullRequest:{number,headSha}.
Optional unverifiedAncillaryFiles: ['publication/README.md','publication/source-manifest.json'].
Ancillary remote hashes are recorded separately with sourceMatched:false; they are never source-match evidence.
Only hashes and remote metadata are printed. No files, receipts, database, or repository are changed.
Environment is loaded internally using the project's standard Node loadEnvFile('.env').
Authentication issues an installation token with read-only repository permissions; it does not publish.
No PR/commit enumeration exists in the public read transport, so global duplicate absence is not claimed.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(`${usage}\n`); return; }
  check(args.length === 2 && args[0] === '--proof' && args[1].length > 0, 'ARGUMENTS_INVALID');
  const proof = await readProof(resolve(args[1]));
  loadEnvFile('.env');
  const config = readGitHubConfig();
  check(config.repositories.length === 1 && config.repositories[0] === repository, 'REPOSITORY_CONFIG_MISMATCH');
  const auth = new GitHubAppAuth(config);
  check(auth.status().configured, 'AUTH_NOT_CONFIGURED');
  const transport = new GitHubTransport({
    token: (repo, access, signal) => {
      check(repo === repository && access === 'read', 'WRITE_OR_SCOPE_REJECTED');
      return auth.token(repo, 'read', signal, repositoryId);
    },
    fetch: (input, init) => {
      check(typeof input === 'string' && new URL(input).origin === 'https://api.github.com'
        && init?.method === 'GET' && init.body === undefined && init.redirect === 'error', 'WRITE_OR_ORIGIN_REJECTED');
      return globalThis.fetch(input, init);
    },
  });
  const report = await verifyStudioGitHubRemote(transport, proof, AbortSignal.timeout(180_000));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Do not print arbitrary auth, filesystem, schema, HTTP or response errors.
    process.stderr.write(`${JSON.stringify({ status: 'failed', code: error instanceof VerificationError ? error.code : 'READ_ONLY_VERIFICATION_FAILED' })}\n`);
    process.exitCode = 1;
  });
}
