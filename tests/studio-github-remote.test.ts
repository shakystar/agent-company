import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { studioRemoteProofSchema, verifyStudioGitHubRemote } from '../scripts/verify-studio-github-remote.ts';
import type { GitHubTransport } from '../server/github-transport.ts';

const mainSha = 'a'.repeat(40), headSha = 'b'.repeat(40), blobSha = 'c'.repeat(40);
const runId = '9908cb6c-7705-4ba5-bc81-4357d666c127', operationId = 'formnest-source-publication-v1';
const branch = `agent-company/${runId}/${operationId}`, content = '\uFEFFFormnest\r\n한글 🎨\n';
const expected = () => ({ version: 1 as const, runId, operationId, mainSha,
  publication: { branch, headSha }, retryPublication: { branch, headSha },
  pullRequest: { number: 1, headSha }, retryPullRequest: { number: 1, headSha },
  files: [{ path: 'site/index.html', sha256: createHash('sha256').update(content, 'utf8').digest('hex') }],
});

function fixture() {
  const calls: Array<{ method: string; ref?: string; path?: string }> = [];
  const pr = { number: 1, url: 'https://github.com/formnest-studio/studio-site/pull/1', head: branch,
    base: 'main', headSha, baseSha: mainSha, state: 'open' as const, merged: false, existing: true,
    title: 'THIS_BODY_MUST_NOT_BE_OUTPUT', body: 'SECRETISH_BODY_MUST_NOT_BE_OUTPUT' };
  const transport: Pick<GitHubTransport, 'inspect' | 'listFiles' | 'readFile' | 'getPullRequest'> = {
    async inspect() { calls.push({ method: 'inspect' }); return { id: 1362601656, fullName: 'formnest-studio/studio-site', defaultBranch: 'main', private: true }; },
    async listFiles(_repo, ref) {
      calls.push({ method: 'listFiles', ref });
      return { ref, headSha: ref === 'main' ? mainSha : headSha, truncated: false, omittedFiles: 0,
        files: ref === 'main' ? [] : [{ path: 'site/index.html', sha: blobSha, size: Buffer.byteLength(content) }] };
    },
    async getPullRequest() { calls.push({ method: 'getPullRequest' }); return { ...pr }; },
    async readFile(_repo, path, ref) { calls.push({ method: 'readFile', path, ref }); return { path, ref, headSha, sha: blobSha, content, encoding: 'utf-8' }; },
  };
  return { transport, calls, pr };
}

test('read-only observer pins UTF8 content to receipt SHA and reports only hashes/metadata with honest enumeration limits', async () => {
  const { transport, calls } = fixture();
  const proof = expected(), before = JSON.stringify(proof);
  const report = await verifyStudioGitHubRemote(transport, proof);
  assert.equal(report.main.unchanged, true);
  assert.equal(report.publication.files[0].sha256, proof.files[0].sha256);
  assert.equal(report.publication.files[0].bytes, Buffer.byteLength(content));
  assert.deepEqual(report.publication.changedFiles, ['site/index.html']);
  assert.equal(report.replay.publicationReceiptMatches, true);
  assert.equal(report.replay.pullRequestReceiptMatches, true);
  assert.equal(report.limits.entireRemotePullRequestCountVerified, false);
  assert.equal(report.limits.entireRemoteCommitHistoryVerified, false);
  assert.equal(report.remoteRepositoryWrites, 0);
  assert.equal(JSON.stringify(proof), before);
  assert.ok(!JSON.stringify(report).includes('MUST_NOT_BE_OUTPUT'));
  assert.ok(!JSON.stringify(report).includes(content));
  assert.deepEqual(calls.filter(call => call.method === 'readFile'), [{ method: 'readFile', path: 'site/index.html', ref: headSha }]);
  assert.ok(calls.every(call => ['inspect', 'listFiles', 'readFile', 'getPullRequest'].includes(call.method)));
});

test('receipt mismatch, unsafe scope/path and duplicate paths fail before any remote call', async () => {
  const mutations = [
    (proof: ReturnType<typeof expected>) => { proof.retryPublication.headSha = 'd'.repeat(40); },
    (proof: ReturnType<typeof expected>) => { proof.retryPullRequest.number = 2; },
    (proof: ReturnType<typeof expected>) => { proof.publication.branch = 'main'; },
    (proof: ReturnType<typeof expected>) => { proof.files[0].path = '.env'; },
    (proof: ReturnType<typeof expected>) => { proof.files.push(proof.files[0]); },
  ];
  for (const mutate of mutations) {
    const { transport, calls } = fixture(), proof = expected(); mutate(proof);
    await assert.rejects(verifyStudioGitHubRemote(transport, proof), /EXPECTED_EVIDENCE_INVALID/);
    assert.equal(calls.length, 0);
  }
  assert.equal(studioRemoteProofSchema.safeParse({ ...expected(), token: 'not-allowed' }).success, false);
});

test('observed main movement, PR mismatch, omitted entries, extra changes and bad content fail closed', async () => {
  for (const scenario of ['main', 'pr', 'omitted', 'extra', 'content', 'final-main', 'final-head', 'final-pr']) {
    const { transport, pr } = fixture();
    const list = transport.listFiles, read = transport.readFile;
    let mainReads = 0, headReads = 0, prReads = 0;
    transport.listFiles = async (...args) => {
      const result = await list(...args);
      if (args[1] === 'main') { mainReads++; if (scenario === 'main' || scenario === 'final-main' && mainReads === 2) result.headSha = 'd'.repeat(40); }
      else { headReads++; if (scenario === 'final-head' && headReads === 2) result.headSha = 'd'.repeat(40); }
      if (scenario === 'omitted') result.omittedFiles = 1;
      if (scenario === 'extra' && args[1] !== 'main') result.files.push({ path: 'unexpected.txt', sha: 'e'.repeat(40), size: 1 });
      return result;
    };
    transport.getPullRequest = async () => { prReads++; return { ...pr, base: scenario === 'pr' || scenario === 'final-pr' && prReads === 2 ? 'other' : 'main' }; };
    transport.readFile = async (...args) => ({ ...await read(...args), ...(scenario === 'content' ? { content: 'changed' } : {}) });
    await assert.rejects(verifyStudioGitHubRemote(transport, expected()), /MAIN_CHANGED|PULL_REQUEST_MISMATCH|INCOMPLETE_FILE_LIST|UNEXPECTED_CHANGED_FILES|FILE_CONTENT_MISMATCH|PUBLICATION_HEAD_CHANGED|PULL_REQUEST_CHANGED/);
  }
});

test('missing retry evidence is explicitly unknown, not successful idempotency verification', async () => {
  const { transport } = fixture();
  const { retryPublication: _publication, retryPullRequest: _pr, ...proof } = expected();
  const report = await verifyStudioGitHubRemote(transport, proof);
  assert.equal(report.replay.publicationReceiptMatches, null);
  assert.equal(report.replay.pullRequestReceiptMatches, null);
});

function ancillaryFixture() {
  const { transport, calls } = fixture();
  const sources = Array.from({ length: 11 }, (_, index) => ({ path: `site/source-${index}.txt`, content: `Preserved source ${index}\n한글` }));
  const ancillary = [
    { path: 'publication/README.md', content: 'DYNAMIC_README_NOT_A_PRESERVED_SOURCE' },
    { path: 'publication/source-manifest.json', content: '{"generated":"DYNAMIC_MANIFEST_NOT_A_PRESERVED_SOURCE"}' },
  ];
  const files = [...sources, ...ancillary].map(file => ({ ...file, sha: createHash('sha1').update(`blob ${Buffer.byteLength(file.content)}\0${file.content}`).digest('hex') }));
  transport.listFiles = async (_repo, ref) => {
    calls.push({ method: 'listFiles', ref });
    return { ref, headSha: ref === 'main' ? mainSha : headSha, truncated: false, omittedFiles: 0,
      files: ref === 'main' ? [] : files.map(file => ({ path: file.path, sha: file.sha, size: Buffer.byteLength(file.content) })) };
  };
  transport.readFile = async (_repo, path, ref) => {
    calls.push({ method: 'readFile', ref, path });
    const file = files.find(file => file.path === path)!;
    assert.ok(file);
    return { path, ref, headSha, sha: file.sha, content: file.content, encoding: 'utf-8' };
  };
  const proof = { ...expected(), files: sources.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.content).digest('hex') })),
    unverifiedAncillaryFiles: ancillary.map(file => file.path) };
  return { transport, calls, files, proof };
}

test('eleven preserved sources match while two ancillary remote hashes remain explicitly source-unverified', async () => {
  const { transport, calls, files, proof } = ancillaryFixture(), before = JSON.stringify(proof);
  const report = await verifyStudioGitHubRemote(transport, proof);
  assert.equal(report.publication.files.length, 11);
  assert.ok(report.publication.files.every(file => file.sourceMatched === true));
  assert.equal(report.publication.changedFiles.length, 13);
  assert.equal(report.publication.sourceComparison.matchedSourceFileCount, 11);
  assert.equal(report.publication.sourceComparison.unverifiedAncillaryFileCount, 2);
  assert.equal(report.publication.sourceComparison.allPublicationFilesSourceMatched, false);
  assert.equal(report.publication.unverifiedAncillaryFiles.length, 2);
  for (const ancillary of report.publication.unverifiedAncillaryFiles) {
    const remote = files.find(file => file.path === ancillary.path)!;
    assert.equal(ancillary.sourceMatched, false);
    assert.equal(ancillary.contentSha256, createHash('sha256').update(remote.content).digest('hex'));
    assert.equal(ancillary.gitBlobSha, remote.sha);
    assert.equal(ancillary.bytes, Buffer.byteLength(remote.content));
    assert.ok(!JSON.stringify(report).includes(remote.content));
  }
  assert.equal(JSON.stringify(proof), before);
  const reads = calls.filter(call => call.method === 'readFile');
  assert.equal(reads.length, 13);
  assert.ok(reads.every(call => call.ref === headSha));
});

test('ancillary allowance is limited to two exact paths and cannot duplicate or replace expected source evidence', async () => {
  const invalid = [
    { ...expected(), unverifiedAncillaryFiles: ['site/index.html'] },
    { ...expected(), unverifiedAncillaryFiles: ['publication/README.md', 'publication/README.md'] },
    { ...expected(), unverifiedAncillaryFiles: ['publication/README.md'], files: [{ ...expected().files[0], path: 'publication/README.md' }] },
    { ...expected(), unverifiedAncillaryFiles: [{ path: 'publication/README.md', sourceMatched: true }] },
  ];
  for (const proof of invalid) {
    const { transport, calls } = fixture();
    await assert.rejects(verifyStudioGitHubRemote(transport, proof), /EXPECTED_EVIDENCE_INVALID/);
    assert.equal(calls.length, 0);
  }
});

test('ancillary classification never masks omitted paths, unexpected files or a bad preserved-source hash', async () => {
  for (const scenario of ['missing-ancillary', 'missing-source', 'extra-file', 'undeclared-ancillary', 'bad-source-hash']) {
    const { transport, files, proof } = ancillaryFixture();
    if (scenario === 'missing-ancillary') files.splice(files.findIndex(file => file.path === 'publication/README.md'), 1);
    if (scenario === 'missing-source') files.splice(0, 1);
    if (scenario === 'extra-file') files.push({ path: 'publication/extra.md', content: 'unexpected', sha: 'e'.repeat(40) });
    if (scenario === 'undeclared-ancillary') proof.unverifiedAncillaryFiles.pop();
    if (scenario === 'bad-source-hash') proof.files[0].sha256 = 'f'.repeat(64);
    await assert.rejects(verifyStudioGitHubRemote(transport, proof), /ANCILLARY_FILE_MISSING|EXPECTED_FILE_MISSING|UNEXPECTED_CHANGED_FILES|FILE_CONTENT_MISMATCH/);
  }
});
