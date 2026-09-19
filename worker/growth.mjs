import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function createModelTelemetry() {
  const usage = { status: 'unknown', inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null };
  const observations = [], commands = new Map();
  let turnOpen = false, lastCompleted = false, completeUsage = true, observationsTruncated = false, drained = 0;
  const snapshot = () => ({ usage: { ...usage }, observations: observations.map(item => ({ ...item })), observationsTruncated });
  return {
    snapshot,
    drain() { const result = { usage: { ...usage }, observations: observations.slice(drained).map(item => ({ ...item })), observationsTruncated }; drained = observations.length; return result; },
    accept(event) {
      if (event?.type === 'turn.started') { turnOpen = true; lastCompleted = false; if (usage.status !== 'unknown') usage.status = 'partial'; return true; }
      if (event?.type === 'turn.failed' || event?.type === 'error') { lastCompleted = false; if (usage.status !== 'unknown') usage.status = 'partial'; return true; }
      if (event?.type === 'turn.completed' && !lastCompleted) {
        const fields = { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cachedInputTokens: 'cached_input_tokens', reasoningOutputTokens: 'reasoning_output_tokens' };
        let reported = false;
        if (token(event.usage?.input_tokens) === null || token(event.usage?.output_tokens) === null) completeUsage = false;
        for (const [name, key] of Object.entries(fields)) {
          const value = token(event.usage?.[key]);
          if (value === null) continue;
          const sum = (usage[name] ?? 0) + value;
          if (Number.isSafeInteger(sum)) { usage[name] = sum; reported = true; }
          else completeUsage = false;
        }
        usage.status = reported ? 'partial' : usage.status;
        turnOpen = false; lastCompleted = true; return true;
      }
      const item = event?.item;
      if (item?.type !== 'command_execution' || typeof item.id !== 'string' || !item.id || item.id.length > 1000) return false;
      if (event.type === 'item.started') {
        if (commands.size < 200 && typeof item.command === 'string') commands.set(item.id, item.command.slice(0, 2000));
        return false;
      }
      if (event.type !== 'item.completed' || observations.some(value => value.id === item.id)) return false;
      if (observations.length >= 100) { observationsTruncated = true; return true; }
      const exitCode = Number.isSafeInteger(item.exit_code) ? item.exit_code : null;
      observations.push({ id: item.id, kind: 'command_execution', command: typeof item.command === 'string' ? item.command.slice(0, 2000) : commands.get(item.id) ?? '',
        status: item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'unknown', exitCode,
        outputExcerpt: typeof item.aggregated_output === 'string' ? item.aggregated_output.slice(0, 4000) : '' });
      commands.delete(item.id); return true;
    },
    finish(succeeded) {
      if (usage.status !== 'unknown') usage.status = succeeded && completeUsage && lastCompleted && !turnOpen && usage.inputTokens !== null && usage.outputTokens !== null ? 'reported' : 'partial';
      return snapshot();
    },
  };
}

/** Evaluation receives result content, not execution cost or elapsed-time metadata. */
export function qualityTask(task) {
  if (!task) return null;
  return {
    result: task.result,
    memories: Array.isArray(task.memories) ? task.memories.map(({ kind, title, content }) => ({ kind, title, content })) : [],
    skills: Array.isArray(task.skills) ? task.skills.map(({ name, description, content }) => ({ name, description, content })) : [],
    artifacts: Array.isArray(task.artifacts) ? task.artifacts.map(({ name, content, mediaType }) => ({ name, content, mediaType })) : [],
  };
}

async function directory(path) {
  try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('플랫폼 스킬 경로가 실제 디렉터리가 아닙니다.');
}
export async function synchronizeSkills(root, skills) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('작업공간 루트가 올바르지 않습니다.');
  root = await realpath(root);
  await directory(join(root, '.agents')); await directory(join(root, '.agents', 'skills'));
  const parent = join(root, '.agents', 'skills');
  // Only this platform's generated directories are replaced. Other user-created
  // skill directories are not silently deleted.
  for (const name of await readdir(parent)) {
    if (!/^skill-\d+$/.test(name)) continue;
    const target = join(parent, name), entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('플랫폼 스킬 디렉터리가 변조됐습니다.');
    await rm(target, { recursive: true });
  }
  for (const [index, skill] of skills.filter(value => value.status === 'active').entries()) {
    const target = join(parent, `skill-${index}`); await directory(target);
    await writeFile(join(target, 'SKILL.md'), `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}\n`, { flag: 'wx' });
  }
}
