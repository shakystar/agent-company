import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import type { CommandObservation } from '../shared/telemetry.ts';

// Controlled fault-injection fixtures, not evidence of naturally discovered learning.
// Importing this module does not execute a model, container, process, or file operation.
export const fixtureSkillName = 'lifecycle-reference-converter';

export interface LifecycleCase {
  readonly id: string;
  readonly value?: number;
  readonly amount?: number;
}

export interface LifecycleOutput {
  rows: Array<{ id: string; actual: number | null }>;
  passed: number;
  total: number;
}

const description = 'JSON 입력 행의 숫자를 반환하는 검증용 Python 참조 변환기입니다.';
const skillContent = (source: string) => [
  '# JSON reference converter',
  '작업 실행에서는 아래 Python 블록의 convert(row)를 추출해 변경 없이 호출합니다. 입력 행과 함수의 반환값을 보존합니다.',
  '스킬 수정 후보를 작성하는 경우에도 convert(row) 인터페이스와 단일 Python 코드 블록을 유지합니다.',
  '```python', source, '```',
].join('\n');

export const baselineSkill = Object.freeze({
  name: fixtureSkillName, description,
  content: skillContent('def convert(row):\n    return row.get("value")'),
});

// The supplied candidate adds amount support but deliberately loses value=0.
// Its content is proposed by a real task; activation still requires a real comparison.
export const candidateFixture = Object.freeze({
  name: fixtureSkillName, description,
  content: skillContent('def convert(row):\n    return row.get("value") or row.get("amount")'),
});

export const introductionCases: readonly LifecycleCase[] = Object.freeze([
  Object.freeze({ id: 'alias-positive', amount: 13 }),
  Object.freeze({ id: 'alias-negative', amount: -5 }),
  Object.freeze({ id: 'alias-zero', amount: 0 }),
]);

export const regressionCases: readonly LifecycleCase[] = Object.freeze([
  Object.freeze({ id: 'value-zero-1', value: 0 }),
  Object.freeze({ id: 'value-zero-2', value: 0 }),
  Object.freeze({ id: 'value-zero-3', value: 0 }),
  Object.freeze({ id: 'value-zero-4', value: 0 }),
  Object.freeze({ id: 'value-positive', value: 7 }),
  Object.freeze({ id: 'alias-positive', amount: 11 }),
]);

const taskContract = [
  '이 작업은 제공된 참조 변환기의 동작을 관찰하는 통제 검증입니다. 자연 발생한 학습을 입증하는 과제가 아닙니다.',
  'input.json은 {id, value?:number, amount?:number} 행의 배열입니다. 목표는 각 행의 숫자를 정확하게 정규화하는 것입니다. value 키가 있으면 그 값을 사용하고, 없으면 amount 값을 사용합니다. 숫자 0도 유효합니다.',
  `현재 주입된 스킬 ${fixtureSkillName}의 SKILL.md를 .agents/skills 아래에서 찾아 읽습니다. 그 파일의 단일 Python 코드 블록에서 convert(row)를 추출합니다.`,
  'Python 표준 라이브러리로 해당 함수를 실제 실행하고 input.json의 모든 행을 원래 순서대로 한 번씩 변환합니다. 과제에 별도로 적힌 후보 코드, 과거 작업의 함수, 직접 고친 함수로 대체하지 않습니다. 이 task/trial에서는 현재 스킬 본문과 input.json을 변경하지 않습니다.',
  '변환 중 잘못된 값이 나와도 결과를 고치거나 행을 빼지 않습니다. Python None은 JSON null로 기록합니다. 실행할 수 없거나 함수가 예외를 일으키면 해당 오류를 그대로 보고하며, 실행하지 않은 값을 만들어 내지 않습니다.',
  'proof.json은 정확히 {"rows":[{"id":입력 id,"actual":실제 반환 숫자 또는 null}],"passed":정답과 일치한 행수,"total":입력 행수}입니다. 정답은 위 value 우선·amount 대체 규칙으로 따로 계산하되 actual을 정답으로 덮지 않습니다.',
  '과제 성과는 실제 변환값의 정확성입니다. 오류를 정직하게 보고한 행도 정규화 정답과 다르면 passed에 포함하지 않습니다. 판정 이름이나 이전 판정 결과를 출력에 넣지 않습니다.',
  'proof.json을 기록하고 다시 읽어 확인한 뒤 같은 실제 JSON을 터미널에 출력합니다. artifacts에는 {name:"proof.json",content:다시 읽은 실제 JSON 문자열,mediaType:"application/json"}을 넣습니다. result에는 실제 통과 건수와 불일치 행의 id·반환값·정답만 짧게 기록합니다.',
  'memories는 빈 배열입니다. 독립 trial에서는 성장 쓰기를 생략하므로 skills와 skillConcerns도 빈 배열입니다.',
].join('\n');

export const introductionPrompt = [
  taskContract,
  '일반 task에서만 다음 객체를 검증용 제공 후보 1개로 skills에 그대로 제안합니다. 이름·설명·내용을 수정하지 않습니다. 이는 자연스럽게 발견한 개선이라고 주장하지 않으며, 현재 작업 실행용 함수로 사용하지 않습니다. 독립 trial은 이 제안을 생략합니다.',
  JSON.stringify(candidateFixture),
  '이번 일반 task의 skillConcerns는 빈 배열입니다. 제공 후보의 품질이나 활성화 여부를 스스로 결정하지 않습니다.',
].join('\n\n');

export const regressionPrompt = [
  taskContract,
  '이 과제의 input.json은 앞선 과제와 다른 새 입력 버전입니다. 이전 proof.json이나 결과를 재사용하지 않고 현재 입력 전체를 실제 실행합니다.',
  '새 스킬 제안은 하지 않으므로 skills는 빈 배열입니다. 일반 task에서 현재 활성 스킬의 구체적인 문제가 실제 관찰되면, 실행기가 제공한 해당 스킬의 정확한 skillId와 불일치 행·실제값·정답을 skillConcerns에 남깁니다. 문제가 없으면 빈 배열입니다. 독립 trial은 skillConcerns를 항상 비웁니다.',
  '문제 보고는 독립 검토 요청일 뿐 스킬의 회귀나 복귀를 자체 확정하지 않습니다. 이 작업에서 스킬 또는 원래 입력을 직접 수정하지 않습니다.',
].join('\n\n');

// Keep the original prompts byte-stable for persisted Run lookup. This separate
// clarification removes fixture-owned mode instructions; it does not establish
// why an earlier model omitted a concern. The worker owns the actual trial mode.
export const clarifiedRegressionPrompt = regressionPrompt
  .replace('이 task/trial에서는', '작업 중에는')
  .replace(' 독립 trial에서는 성장 쓰기를 생략하므로 skills와 skillConcerns도 빈 배열입니다.', '')
  .replace('일반 task에서 현재 활성 스킬의', '현재 활성 스킬의')
  .replace(' 독립 trial은 skillConcerns를 항상 비웁니다.', '');

function expectedValues(cases: readonly LifecycleCase[]) {
  const ids = new Set<string>();
  return cases.map(row => {
    assert.equal(typeof row.id, 'string', 'A case must have a string id.');
    assert.ok(row.id.length > 0 && !ids.has(row.id), 'Case ids must be nonempty and unique.');
    ids.add(row.id);
    const actual = Object.hasOwn(row, 'value') ? row.value : row.amount;
    assert.ok(typeof actual === 'number' && Number.isFinite(actual), 'A case must have a finite semantic numeric value.');
    return { id: row.id, actual };
  });
}

/** The semantic oracle, independent of either supplied implementation. */
export function expectedOutput(cases: readonly LifecycleCase[]): LifecycleOutput {
  return { rows: expectedValues(cases), passed: cases.length, total: cases.length };
}

/** Checks honest observation/counting; a correctly reported failed case is allowed. */
export function assertObservedOutput(value: unknown, cases: readonly LifecycleCase[]): asserts value is LifecycleOutput {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected a proof object.');
  const output = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(output).sort(), ['passed', 'rows', 'total']);
  assert.ok(Array.isArray(output.rows), 'Proof rows must be an array.');
  const expected = expectedValues(cases);
  assert.equal(output.rows.length, expected.length, 'No input row may be skipped or added.');
  let passed = 0;
  for (const [index, raw] of output.rows.entries()) {
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), 'Expected an observed row.');
    assert.deepEqual(Object.keys(raw).sort(), ['actual', 'id']);
    const row = raw as Record<string, unknown>;
    assert.equal(row.id, expected[index].id, 'Observed row ids and ordering must match the input.');
    assert.ok(row.actual === null || (typeof row.actual === 'number' && Number.isFinite(row.actual)), 'An actual value must be a finite number or null.');
    if (row.actual === expected[index].actual) passed++;
  }
  assert.equal(output.total, expected.length, 'Reported total must equal the input length.');
  assert.equal(output.passed, passed, 'Reported passed must equal the observed correct-value count.');
}

/** Use for a repaired implementation only after its actual proof has been captured. */
export function assertExpectedOutput(value: unknown, cases: readonly LifecycleCase[]): asserts value is LifecycleOutput {
  assertObservedOutput(value, cases);
  assert.deepEqual(value, expectedOutput(cases), 'The actual conversion does not match every semantic expected value.');
}

function jsonBlockEnd(text: string, start: number): number | null {
  const closing: string[] = [];
  let quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') closing.push('}');
    else if (character === '[') closing.push(']');
    else if (character === '}' || character === ']') {
      if (closing.pop() !== character) return null;
      if (!closing.length) return index;
    }
  }
  return null;
}

function outputJsonValues(output: string): unknown[] {
  const text = output.trim();
  if (!text) return [];
  // A complete wrapper/array/string is one JSON value, not a license to treat a
  // nested object or quoted source text as the independently printed proof.
  try { return [JSON.parse(text)]; } catch { /* Try standalone blocks between log lines. */ }
  const values: unknown[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '{' && text[index] !== '[') continue;
    if (text.slice(text.lastIndexOf('\n', index) + 1, index).trim()) continue;
    const end = jsonBlockEnd(text, index);
    // Do not salvage inner objects from a truncated or mismatched outer block.
    if (end === null) break;
    const newline = text.indexOf('\n', end);
    if (!text.slice(end + 1, newline === -1 ? text.length : newline).trim()) {
      try { values.push(JSON.parse(text.slice(index, end + 1))); } catch { /* Not a complete JSON output value. */ }
    }
    index = end;
  }
  return values;
}

/** Matches a valid proof to recorded successful command stdout; it does not infer what the command's source executed. */
export function assertObservedCommandProof(observations: readonly CommandObservation[], proof: unknown,
  cases: readonly LifecycleCase[]): void {
  assertObservedOutput(proof, cases);
  assert.ok(observations.some(observation => observation.kind === 'command_execution' && observation.status === 'completed'
    && observation.exitCode === 0 && typeof observation.command === 'string' && observation.command.trim()
    && typeof observation.outputExcerpt === 'string'
    && outputJsonValues(observation.outputExcerpt).some(value => isDeepStrictEqual(value, proof))),
  'No successful recorded command output contains the same observed proof JSON.');
}

/** Ensures a controlled supplied candidate was not silently replaced by a different task output. */
export function assertFixtureCandidate(value: unknown): void {
  assert.ok(value && typeof value === 'object', 'Expected a proposed controlled candidate.');
  const skill = value as Record<string, unknown>;
  assert.deepEqual({ name: skill.name, description: skill.description, content: skill.content }, candidateFixture,
    'The proposed controlled candidate must preserve its supplied name, description, and content.');
}

/** Extracts reference text for fixture checks without evaluating the Python source. */
export function extractReferencePython(skill: Pick<typeof baselineSkill, 'content'>): string {
  const blocks = [...skill.content.matchAll(/```python\r?\n([\s\S]*?)\r?\n```/g)];
  assert.equal(blocks.length, 1, 'Expected one Python reference block.');
  assert.match(blocks[0][1], /^def convert\(row\):\r?\n/);
  return blocks[0][1];
}
