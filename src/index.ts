/** Cordis service exposing the durable automation store to DSH plugins. */

import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type { RunClaim, RunId, RunSettlement, RunState, RunView, SubmitRunRequest } from './domain.ts'
import { AutomationStore, type ExpiredAttempt, type RunEvent } from './store.ts'

export * from './domain.ts'
export { AutomationStore, SCHEMA_VERSION } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    automation: AutomationService
  }
}

/** Plugin configuration. */
export interface Config {
  readonly databasePath?: string
  readonly busyTimeoutMs?: number
}

/** Durable Run service shared by Trigger adapters and management surfaces. */
export class AutomationService extends Service {
  static Config: z<Config> = z.object({
    databasePath: z.string(),
    busyTimeoutMs: z.number().step(1).min(0).max(2_147_483_647).default(5_000),
  })

  private store!: AutomationStore

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'automation')
  }

  protected async *[Service.init](): AsyncGenerator<() => void, void, void> {
    this.store = await AutomationStore.open({
      path: this.config.databasePath ?? join(resolveDshHome(), 'automation', 'automation.db'),
      ...(this.config.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: this.config.busyTimeoutMs }),
    })
    yield () => { this.store.close() }
  }

  /** Submit an immutable Run, idempotently when the Trigger carries a key. */
  submit(request: SubmitRunRequest): { readonly run: RunView; readonly created: boolean } {
    return this.store.submit(request)
  }

  /** Read one Run. */
  get(id: RunId): RunView {
    return this.store.get(id)
  }

  /** List Runs newest-first. */
  list(state?: RunState): RunView[] {
    return this.store.list(state)
  }

  /** Atomically claim the next eligible Run. */
  claimNext(workerId: string, now: number, leaseDurationMs: number): RunClaim | undefined {
    return this.store.claimNext(workerId, now, leaseDurationMs)
  }

  /** Extend the exact currently owned Attempt lease. */
  heartbeat(claim: RunClaim, now: number, leaseDurationMs: number): RunClaim {
    return this.store.heartbeat(claim, now, leaseDurationMs)
  }

  /** Record that canonical DSH dispatch has passed its durability checkpoint. */
  markRunning(claim: RunClaim, now: number): RunView {
    return this.store.markRunning(claim, now)
  }

  /** Settle the exact currently owned Attempt. */
  settle(claim: RunClaim, settlement: RunSettlement, now: number): RunView {
    return this.store.settle(claim, settlement, now)
  }

  /** Requeue expired claims only when no durable dispatch occurred. */
  recoverUndispatchedExpired(now: number): RunId[] {
    return this.store.recoverUndispatchedExpired(now)
  }

  /** List expired dispatched Attempts requiring canonical Session inspection. */
  expiredDispatched(now: number): ExpiredAttempt[] {
    return this.store.expiredDispatched(now)
  }

  /** Take over a dispatched Attempt only after canonical inspection proves resume is safe. */
  reclaimDispatched(ref: ExpiredAttempt, workerId: string, now: number, leaseDurationMs: number): RunClaim | undefined {
    return this.store.reclaimDispatched(ref, workerId, now, leaseDurationMs)
  }

  /** Settle an expired Attempt from canonical recovery evidence. */
  settleExpired(ref: ExpiredAttempt, settlement: RunSettlement, now: number): RunView {
    return this.store.settleExpired(ref, settlement, now)
  }

  /** Read the append-only audit stream for one Run. */
  events(id: RunId): RunEvent[] {
    return this.store.events(id)
  }

  /** Request cancellation; queued Runs settle immediately. */
  cancel(id: RunId): RunView {
    return this.store.requestCancel(id, Date.now())
  }
}

export default AutomationService
