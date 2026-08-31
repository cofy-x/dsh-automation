/** Single-process parallel Worker slots with independent fenced lease ownership. */

import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { RunId } from '../domain.ts'
import type { AutomationService } from '../index.ts'
import { AutomationWorker, type WorkerLog, type WorkerOptions } from '../worker.ts'

export interface WorkerPoolOptions extends WorkerOptions {
  readonly slots: number
}

export interface WorkerPoolCycleResult {
  readonly recovered: number
  readonly claimedRunIds: readonly RunId[]
}

export class AutomationWorkerPool {
  private readonly workers: readonly AutomationWorker[]

  constructor(ctx: Context, automation: AutomationService, options: WorkerPoolOptions, log: WorkerLog) {
    if (!Number.isSafeInteger(options.slots) || options.slots < 1 || options.slots > 64) {
      throw new Error('automation Worker slots must be an integer between 1 and 64')
    }
    const baseId = options.workerId ?? `${hostname()}:${process.pid}`
    this.workers = Array.from({ length: options.slots }, (_, index) => new AutomationWorker(
      ctx,
      automation,
      { ...options, workerId: `${baseId}/slot-${index + 1}` },
      log,
    ))
  }

  async runOnce(): Promise<WorkerPoolCycleResult> {
    const results = await Promise.all(this.workers.map(async worker => await worker.runOnce()))
    return {
      recovered: results.reduce((total, result) => total + result.recovered, 0),
      claimedRunIds: results.flatMap(result => result.claimedRunId === undefined ? [] : [result.claimedRunId]),
    }
  }

  start(): () => Promise<void> {
    const stop = this.workers.map(worker => worker.start())
    return async () => { await Promise.all(stop.map(async dispose => await dispose())) }
  }
}
