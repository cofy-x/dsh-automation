/** Long-lived Worker that leases Runs and executes canonical DSH turns. */

import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { RunClaim, RunId, RunSettlement } from './domain.ts'
import type { AutomationService } from './index.ts'
import { applyPermission, createAutomationAgent } from './worker/agent-runtime.ts'
import { automationMessage } from './worker/messages.ts'
import {
  indeterminate,
  isRecoveryWakeMessage,
  recoveryWakeMessage,
  safeToResumeBeforeTurn,
  settlementFromEvents,
} from './worker/recovery.ts'

export { isRecoveryWakeMessage, recoveryWakeMessage, safeToResumeBeforeTurn, settlementFromEvents } from './worker/recovery.ts'

/** Worker deployment settings resolved from the application command. */
export interface WorkerOptions {
  readonly workerId?: string
  readonly pollMs: number
  readonly leaseMs: number
  readonly shutdownGraceMs?: number
}

/** Result of one bounded recovery-and-claim cycle. */
export interface WorkerCycleResult {
  readonly recovered: number
  readonly claimedRunId?: RunId
}

/** Internal deterministic checkpoints used by process-crash integration tests. */
export interface WorkerHooks {
  checkpoint?(point: 'after-claim' | 'after-dispatch' | 'before-settle', claim: RunClaim): void | Promise<void>
}

/** Process logger used by the Worker. */
export interface WorkerLog {
  info(message: string): void
  warn(message: string): void
}

/** One long-lived queue consumer owned by the automation app fiber. */
export class AutomationWorker {
  private readonly workerId: string
  private timer: ReturnType<typeof setInterval> | undefined
  private pumpTask: Promise<void> | undefined
  private stopping = false
  private activeAgent: Agent | undefined

  constructor(
    private readonly ctx: Context,
    private readonly automation: AutomationService,
    private readonly options: WorkerOptions,
    private readonly log: WorkerLog,
    private readonly hooks: WorkerHooks = {},
  ) {
    this.workerId = options.workerId ?? `${hostname()}:${process.pid}`
  }

  /** Execute one bounded cycle and propagate operational failures to the caller. */
  async runOnce(): Promise<WorkerCycleResult> {
    if (this.timer !== undefined || this.pumpTask !== undefined) throw new Error('automation Worker is already started')
    return await this.pump()
  }

  /** Start polling immediately and keep the process live until disposed. */
  start(): () => Promise<void> {
    if (this.timer !== undefined) throw new Error('automation Worker is already started')
    this.timer = setInterval(() => { this.requestPump() }, this.options.pollMs)
    this.requestPump()
    this.log.info(`dsh-automation: Worker ${this.workerId} started`)
    return async () => {
      this.stopping = true
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = undefined
      const active = this.pumpTask
      if (active !== undefined) {
        const graceful = await settlesWithin(active, this.options.shutdownGraceMs ?? 30_000)
        if (!graceful) {
          this.log.warn(`dsh-automation: Worker ${this.workerId} exceeded shutdown grace; cancelling active turn`)
          this.activeAgent?.cancel({ kind: 'disposed' })
          await active
        }
      }
      this.log.info(`dsh-automation: Worker ${this.workerId} stopped`)
    }
  }

  private requestPump(): void {
    if (this.pumpTask !== undefined || this.stopping) return
    const task = this.pump().then(
      () => {},
      (error: unknown) => { this.log.warn(`dsh-automation: Worker pump failed: ${errorMessage(error)}`) },
    )
    this.pumpTask = task
    void task.finally(() => {
      if (this.pumpTask === task) this.pumpTask = undefined
    })
  }

  private async pump(): Promise<WorkerCycleResult> {
    if (this.stopping) return { recovered: 0 }
    const now = Date.now()
    const undispatched = this.automation.recoverUndispatchedExpired(now)
    const dispatched = await this.recoverExpiredDispatched(now)
    const recovered = undispatched.length + dispatched
    if (this.stopping) return { recovered }
    const claim = this.automation.claimNext(this.workerId, Date.now(), this.options.leaseMs)
    if (claim === undefined) return { recovered }
    await this.checkpoint('after-claim', claim)
    await this.execute(claim)
    return { recovered, claimedRunId: claim.run.id }
  }

  private async recoverExpiredDispatched(now: number): Promise<number> {
    let recovered = 0
    for (const ref of this.automation.expiredDispatched(now)) {
      try {
        const events = await readPersistedEvents(this.ctx, SessionId(ref.sessionId))
        const settlement = settlementFromEvents(events)
        if (settlement !== undefined) {
          this.automation.settleExpired(ref, settlement, Date.now())
          recovered += 1
        } else if (safeToResumeBeforeTurn(events)) {
          const claim = this.automation.reclaimDispatched(ref, this.workerId, Date.now(), this.options.leaseMs)
          if (claim !== undefined) {
            await this.execute(claim, true)
            recovered += 1
          }
        } else {
          this.automation.settleExpired(ref, indeterminate('canonical Session has no terminal turn and is not safely resumable'), Date.now())
          recovered += 1
        }
      } catch (error) {
        try {
          this.automation.settleExpired(ref, indeterminate(`canonical Session recovery failed: ${errorMessage(error)}`), Date.now())
          recovered += 1
        } catch (settleError) {
          this.log.warn(`dsh-automation: ${ref.runId} recovery settlement lost: ${errorMessage(settleError)}`)
        }
      }
    }
    return recovered
  }

  private async execute(initialClaim: RunClaim, resume = false): Promise<void> {
    let claim = initialClaim
    let handle: AgentHandle | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let deliveryStarted = resume
    let leaseFailure: unknown
    try {
      const renewLease = (): void => {
        try {
          claim = this.automation.heartbeat(claim, Date.now(), this.options.leaseMs)
          if (claim.run.state === 'cancelling') handle?.agent.cancel({ kind: 'user' })
        } catch (error) {
          leaseFailure = error
          handle?.agent.cancel({ kind: 'disposed' })
        }
      }
      // Agent creation and Session loading can take longer than one lease. Ownership
      // must therefore be renewed from the moment the Run is claimed, not only once
      // the first user message has been persisted.
      renewLease()
      if (leaseFailure !== undefined) throw leaseFailure
      heartbeat = setInterval(renewLease, Math.max(1, Math.floor(this.options.leaseMs / 3)))
      if (isCancelling(claim)) {
        this.automation.settle(claim, { state: 'cancelled', outcome: 'cancelled' }, Date.now())
        return
      }
      handle = await createAutomationAgent(this.ctx, claim, resume)
      this.activeAgent = handle.agent
      if (resume) {
        const pending = [...handle.agent.inbox.nextStep, ...handle.agent.inbox.nextTurn]
          .filter(message => !isRecoveryWakeMessage(message))
        if (pending.length === 0) throw new Error('canonical Session recovery found no pending task message')
        handle.agent.steer(recoveryWakeMessage())
      }
      await handle.agent.whenIdle()
      if (resume) {
        if (heartbeat !== undefined) clearInterval(heartbeat)
        heartbeat = undefined
        if (leaseFailure !== undefined) throw leaseFailure
        await this.ctx.sessions.flush(handle.agent.session)
        const settlement = settlementFromEvents(handle.agent.session.snapshotEvents())
          ?? indeterminate('resumed canonical Session settled without a terminal turn')
        await this.checkpoint('before-settle', claim)
        this.automation.settle(claim, settlement, Date.now())
        this.log.info(`dsh-automation: ${claim.run.id} ${settlement.state} after recovery`)
        return
      }
      applyPermission(this.ctx, handle.agent, claim.run.target)
      renewLease()
      if (leaseFailure !== undefined) throw leaseFailure
      if (isCancelling(claim)) {
        this.automation.settle(claim, { state: 'cancelled', outcome: 'cancelled' }, Date.now())
        return
      }
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(automationMessage(claim))
      deliveryStarted = true
      await this.ctx.sessions.flush(handle.agent.session)
      claim = { ...claim, run: this.automation.markRunning(claim, Date.now()) }
      await this.checkpoint('after-dispatch', claim)
      if (claim.run.state === 'cancelling') handle.agent.cancel({ kind: 'user' })
      await handle.agent.whenIdle()
      if (heartbeat !== undefined) clearInterval(heartbeat)
      heartbeat = undefined
      if (leaseFailure !== undefined) throw leaseFailure
      await this.ctx.sessions.flush(handle.agent.session)
      const settlement = settlementFromEvents(handle.agent.session.snapshotEvents(firstSeq))
        ?? indeterminate('canonical Session settled without a terminal turn')
      await this.checkpoint('before-settle', claim)
      this.automation.settle(claim, settlement, Date.now())
      this.log.info(`dsh-automation: ${claim.run.id} ${settlement.state}`)
    } catch (error) {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      const settlement = deliveryStarted
        ? indeterminate(`execution failed after delivery began: ${errorMessage(error)}`)
        : { state: 'failed', outcome: 'error', error: `execution failed before delivery: ${errorMessage(error)}` } satisfies RunSettlement
      try {
        this.automation.settle(claim, settlement, Date.now())
      } catch (settleError) {
        this.log.warn(`dsh-automation: ${claim.run.id} could not settle after failure: ${errorMessage(settleError)}`)
      }
    } finally {
      this.activeAgent = undefined
      await handle?.dispose()
    }
  }

  private async checkpoint(point: 'after-claim' | 'after-dispatch' | 'before-settle', claim: RunClaim): Promise<void> {
    await this.hooks.checkpoint?.(point, claim)
  }

}

async function readPersistedEvents(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

function isCancelling(claim: RunClaim): boolean {
  return claim.run.state === 'cancelling'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function settlesWithin(task: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => { resolve(false) }, milliseconds) })
  const settled = await Promise.race([task.then(() => true as const), timeout])
  if (timer !== undefined) clearTimeout(timer)
  return settled
}
