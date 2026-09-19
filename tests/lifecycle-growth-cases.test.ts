import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { CommandObservation } from '../shared/telemetry.ts';
import {
  assertExpectedOutput, assertFixtureCandidate, assertObservedCommandProof, assertObservedOutput, baselineSkill, candidateFixture,
  clarifiedRegressionPrompt,
  expectedOutput, extractReferencePython, fixtureSkillName, introductionCases, introductionPrompt,
  regressionCases, regressionPrompt, type LifecycleCase, type LifecycleOutput,
} from '../scripts/lifecycle-growth-cases.ts';

const observations = (cases: readonly LifecycleCase[], convert: (row: LifecycleCase) => number | null): LifecycleOutput => {
  const expected = expectedOutput(cases);
  const rows = cases.map(row => ({ id: row.id, actual: convert(row) }));
  return { rows, passed: rows.filter((row, index) => row.actual === expected.rows[index].actual).length, total: rows.length };
};

test('the supplied skills differ only in the controlled reference function', () => {
  assert.equal(baselineSkill.name, fixtureSkillName);
  assert.equal(candidateFixture.name, fixtureSkillName);
  assert.equal(baselineSkill.description, candidateFixture.description);
  assert.equal(extractReferencePython(baselineSkill), 'def convert(row):\n    return row.get("value")');
  assert.equal(extractReferencePython(candidateFixture), 'def convert(row):\n    return row.get("value") or row.get("amount")');
  assertFixtureCandidate(structuredClone(candidateFixture));
  assertFixtureCandidate({ ...candidateFixture, id: 'persisted-revision-id', comparison: { verified: false } });
  assert.throws(() => assertFixtureCandidate(baselineSkill));
  assert.throws(() => extractReferencePython({ content: `${baselineSkill.content}\n${baselineSkill.content}` }));
  assert.ok(Object.isFrozen(baselineSkill) && Object.isFrozen(candidateFixture));
  assert.ok(Object.isFrozen(introductionCases) && introductionCases.every(Object.isFrozen));
  assert.ok(Object.isFrozen(regressionCases) && regressionCases.every(Object.isFrozen));
});

test('the oracle preserves zero, prefers a present value, and does not mutate its inputs', () => {
  const cases = [{ id: 'zero', value: 0, amount: 99 }, { id: 'negative', amount: -5 }];
  const before = structuredClone(cases);
  assert.deepEqual(expectedOutput(cases), { rows: [{ id: 'zero', actual: 0 }, { id: 'negative', actual: -5 }], passed: 2, total: 2 });
  assert.deepEqual(cases, before);
  assert.throws(() => expectedOutput([{ id: 'missing' }]));
  assert.throws(() => expectedOutput([{ id: 'infinite', value: Infinity }]));
  assert.throws(() => expectedOutput([{ id: 'same', value: 1 }, { id: 'same', value: 2 }]));
});

test('observed failures remain valid reports without being mistaken for semantic success', () => {
  const baseline = observations(regressionCases, row => row.value ?? null);
  const candidate = observations(regressionCases, row => (row.value || row.amount) ?? null);
  assert.equal(baseline.passed, 5);
  assert.equal(candidate.passed, 2);
  assertObservedOutput(baseline, regressionCases);
  assertObservedOutput(candidate, regressionCases);
  assert.throws(() => assertExpectedOutput(baseline, regressionCases));
  assert.throws(() => assertExpectedOutput(candidate, regressionCases));
  assertExpectedOutput(expectedOutput(regressionCases), regressionCases);
});

test('proof checking rejects dishonest counts, missing/reordered rows, and non-JSON numeric values', () => {
  const modifications: Array<(value: LifecycleOutput) => void> = [
    value => { value.passed--; },
    value => { value.total--; },
    value => { value.rows.pop(); },
    value => { value.rows.reverse(); },
    value => { value.rows[0].id = value.rows[1].id; },
    value => { value.rows[0].actual = null; },
    value => { value.rows[0].actual = NaN; },
    value => { value.rows[0].actual = Infinity; },
  ];
  for (const modify of modifications) {
    const proof = expectedOutput(regressionCases); modify(proof);
    assert.throws(() => assertObservedOutput(proof, regressionCases));
  }
  assert.throws(() => assertObservedOutput({ ...expectedOutput(regressionCases), verdict: 'improved' }, regressionCases));
  assert.throws(() => assertObservedOutput('6/6', regressionCases));
});

const commandObservation = (outputExcerpt: string, patch: Partial<CommandObservation> = {}): CommandObservation => ({
  id: 'controlled-command', kind: 'command_execution', command: 'python3 reference-check.py',
  status: 'completed', exitCode: 0, outputExcerpt, ...patch,
});

test('command proof checks accept exact, pretty, and separate JSON log blocks without requiring successful conversion', () => {
  const proof = observations(regressionCases, row => (row.value || row.amount) ?? null);
  const before = structuredClone(proof);
  for (const output of [JSON.stringify(proof), `  ${JSON.stringify(proof, null, 2)}\n`,
    `checking input\n${JSON.stringify(proof, null, 2)}\nfinished`,
    `{"event":"started"}\n${JSON.stringify(proof)}\n{"event":"finished"}`,
    `["unrelated",{"ok":true}]\n${JSON.stringify(proof)}\n`]) {
    assertObservedCommandProof([commandObservation(output)], proof, regressionCases);
  }
  assert.equal(proof.passed, 2);
  assert.deepEqual(proof, before);
});

test('command proof checks preserve quoted braces and escaped strings inside case ids', () => {
  const cases = [{ id: 'quoted-"brace-{]-and-\\-slash', value: 0 }];
  const proof = expectedOutput(cases);
  assertObservedCommandProof([commandObservation(`started\n${JSON.stringify(proof, null, 2)}\nfinished`)], proof, cases);
});

test('command proof checks reject missing, failed, fabricated, mismatched, and truncated observations', () => {
  const proof = expectedOutput(regressionCases), json = JSON.stringify(proof);
  const rejected = [
    commandObservation(''),
    commandObservation('No command output was recorded.', { command: `echo '${json}'` }),
    commandObservation(json, { status: 'failed', exitCode: 1 }),
    commandObservation(json, { status: 'failed', exitCode: 0 }),
    commandObservation(json, { status: 'unknown', exitCode: 0 }),
    commandObservation(json, { exitCode: null }),
    commandObservation(json, { exitCode: 2 }),
    commandObservation(json, { command: '' }),
    commandObservation(JSON.stringify(expectedOutput(introductionCases))),
    commandObservation(JSON.stringify({ ...proof, passed: 2 })),
    commandObservation(json.slice(0, -1)),
    commandObservation(JSON.stringify(json)),
    commandObservation(JSON.stringify({ proof })),
    commandObservation(JSON.stringify([proof])),
    commandObservation(`started\n${JSON.stringify({ proof }, null, 2)}\nfinished`),
    commandObservation(`started\n${JSON.stringify([proof], null, 2)}\nfinished`),
    commandObservation(`{"unfinished":\n${JSON.stringify(proof, null, 2)}`),
    commandObservation(`${json} invalid trailing text`),
  ];
  assert.throws(() => assertObservedCommandProof([], proof, regressionCases));
  for (const observation of rejected) {
    assert.throws(() => assertObservedCommandProof([observation], proof, regressionCases), observation.outputExcerpt);
  }
  assert.throws(() => assertObservedCommandProof([commandObservation(json)], { ...proof, passed: 2 }, regressionCases));
  assertObservedCommandProof([...rejected, commandObservation(json)], proof, regressionCases);
});

test('task instructions distinguish supplied candidates, fixed trials, and independently reviewed concerns', () => {
  assert.ok(introductionPrompt.includes(JSON.stringify(candidateFixture)));
  assert.ok(introductionPrompt.includes('검증용 제공 후보'));
  assert.ok(introductionPrompt.includes('자연 발생한 학습을 입증하는 과제가 아닙니다'));
  assert.ok(introductionPrompt.includes('변경 없이 호출') || introductionPrompt.includes('추출'));
  assert.ok(introductionPrompt.includes('후보 코드, 과거 작업의 함수, 직접 고친 함수로 대체하지 않습니다'));
  assert.ok(regressionPrompt.includes('새 입력 버전'));
  assert.ok(regressionPrompt.includes('skills는 빈 배열'));
  assert.ok(regressionPrompt.includes('정확한 skillId'));
  assert.ok(regressionPrompt.includes('독립 trial은 skillConcerns를 항상 비웁니다'));
  assert.ok(!regressionPrompt.includes(candidateFixture.content));
  for (const prompt of [introductionPrompt, regressionPrompt]) {
    assert.doesNotMatch(prompt, /\b(?:improved|equivalent|regressed|inconclusive)\b/);
    assert.doesNotMatch(prompt, /[0-9]+\s*\/\s*6/);
  }
});

test('the clarified regression task removes only fixture mode instructions and leaves prior prompts intact', () => {
  assert.notEqual(clarifiedRegressionPrompt, regressionPrompt);
  assert.ok(regressionPrompt.includes('이 task/trial에서는'));
  assert.ok(regressionPrompt.includes('독립 trial에서는 성장 쓰기를 생략하므로 skills와 skillConcerns도 빈 배열입니다.'));
  assert.ok(regressionPrompt.includes('독립 trial은 skillConcerns를 항상 비웁니다.'));
  assert.ok(introductionPrompt.includes(JSON.stringify(candidateFixture)));
  assert.doesNotMatch(clarifiedRegressionPrompt, /\b(?:task|trial|improved|equivalent|regressed|inconclusive)\b/);
  assert.doesNotMatch(clarifiedRegressionPrompt, /[0-9]+\s*\/\s*[0-9]+|현재는 일반|현재 실행 유형/);
  assert.ok(clarifiedRegressionPrompt.includes('현재 활성 스킬의 구체적인 문제가 실제 관찰되면'));
  assert.ok(clarifiedRegressionPrompt.includes('정확한 skillId와 불일치 행·실제값·정답을 skillConcerns에 남깁니다. 문제가 없으면 빈 배열입니다.'));
  assert.ok(clarifiedRegressionPrompt.includes('문제 보고는 독립 검토 요청일 뿐 스킬의 회귀나 복귀를 자체 확정하지 않습니다.'));
  assert.ok(clarifiedRegressionPrompt.includes('skills는 빈 배열입니다.'));
  assert.ok(clarifiedRegressionPrompt.includes('memories는 빈 배열입니다.'));
  // Reversing only the requested mode clarifications restores the historical
  // prompt exactly, including all task, oracle, execution, and artifact rules.
  assert.equal(clarifiedRegressionPrompt
    .replace('작업 중에는', '이 task/trial에서는')
    .replace('memories는 빈 배열입니다.', 'memories는 빈 배열입니다. 독립 trial에서는 성장 쓰기를 생략하므로 skills와 skillConcerns도 빈 배열입니다.')
    .replace('현재 활성 스킬의 구체적인 문제가', '일반 task에서 현재 활성 스킬의 구체적인 문제가')
    .replace('문제가 없으면 빈 배열입니다.', '문제가 없으면 빈 배열입니다. 독립 trial은 skillConcerns를 항상 비웁니다.'), regressionPrompt);
});

test('actual local Python confirms V1/V2 introduction and regression scores without a model or container', t => {
  const program = [
    'import json, sys',
    'outputs = []',
    'for item in json.load(sys.stdin):',
    '    namespace = {}',
    '    exec(compile(item["source"], "controlled-reference", "exec"), namespace)',
    '    rows = [{"id": row["id"], "actual": namespace["convert"](row)} for row in item["cases"]]',
    '    expected = [row["value"] if "value" in row else row["amount"] for row in item["cases"]]',
    '    outputs.append({"rows": rows, "passed": sum(row["actual"] == value for row, value in zip(rows, expected)), "total": len(rows)})',
    'print(json.dumps(outputs))',
  ].join('\n');
  const matrix = [
    { source: extractReferencePython(baselineSkill), cases: introductionCases },
    { source: extractReferencePython(candidateFixture), cases: introductionCases },
    { source: extractReferencePython(baselineSkill), cases: regressionCases },
    { source: extractReferencePython(candidateFixture), cases: regressionCases },
    // A reference for this fixture's repair target, not a purported model-written repair.
    { source: 'def convert(row):\n    return row["value"] if "value" in row else row.get("amount")', cases: regressionCases },
  ];
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', program], {
    input: JSON.stringify(matrix), encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    t.skip('Local Python is unavailable; no container or interpreter installation is attempted.'); return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as unknown[];
  assert.equal(output.length, matrix.length);
  output.forEach((proof, index) => assertObservedOutput(proof, matrix[index].cases));
  assert.deepEqual((output as LifecycleOutput[]).map(proof => proof.passed), [0, 3, 5, 2, 6]);
  assertExpectedOutput(output[1], introductionCases);
  assertExpectedOutput(output[4], regressionCases);
});
