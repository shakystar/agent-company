import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { BudgetPauseError, type ModelStartRequest } from '../shared/telemetry.ts';
import { secureDirectory } from './storage.ts';

interface StartRecord extends ModelStartRequest { sequence: number; recordedAt: string }
export interface ModelBudgetLedger { version: 1; limit: number; starts: StartRecord[] }

/** A development campaign gate. It does not change the normal product budget. */
export class FileModelBudget {
  readonly directory: string;
  constructor(directory: string, readonly limit: number) {
    this.directory = resolve(directory);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('모델 검증 실행 한도가 올바르지 않습니다.');
  }

  private async locked<T>(operation: (ledger: ModelBudgetLedger) => Promise<T>): Promise<T> {
    await secureDirectory(this.directory);
    const release = await lockfile.lock(this.directory, { realpath: true, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
    try {
      let ledger: ModelBudgetLedger;
      try { ledger = JSON.parse(await readFile(join(this.directory, 'model-budget.json'), 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        ledger = { version: 1, limit: this.limit, starts: [] };
      }
      if (ledger.version !== 1 || ledger.limit !== this.limit || !Array.isArray(ledger.starts)
        || ledger.starts.length > ledger.limit || ledger.starts.some((entry, index) => entry.sequence !== index + 1
          || !entry.runId || !['task', 'evaluate', 'trial', 'repair'].includes(entry.phase))) {
        throw new Error('기존 검증 예산 기록이 일치하지 않습니다. 기록을 초기화하지 않았습니다.');
      }
      return await operation(ledger);
    } finally { await release(); }
  }

  async read(): Promise<ModelBudgetLedger> { return this.locked(async ledger => structuredClone(ledger)); }

  async reserve(request: ModelStartRequest): Promise<void> {
    await this.locked(async ledger => {
      if (ledger.starts.length >= ledger.limit) throw new BudgetPauseError(`이번 개발 검증의 모델 실행 ${ledger.limit}회 한도를 모두 사용했습니다. 진행 상태를 보존했습니다.`);
      ledger.starts.push({ ...request, sequence: ledger.starts.length + 1, recordedAt: new Date().toISOString() });
      const temporary = join(this.directory, `model-budget-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(JSON.stringify(ledger, null, 2)); await handle.sync();
      } finally { await handle.close(); }
      try { await rename(temporary, join(this.directory, 'model-budget.json')); }
      catch (error) { await rm(temporary, { force: true }); throw error; }
    });
  }
}
