/** Public DSH Agent composition for fresh and resumed automation Runs. */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RunClaim, TargetSpec } from '../domain.ts'
import { installRecoveryWakeFilter } from './recovery.ts'

export async function createAutomationAgent(ctx: Context, claim: RunClaim, resume: boolean): Promise<AgentHandle> {
  const selection = resolveSelection(ctx, claim.run.target)
  const presets = ctx.get('agentPresets')
  if (presets === undefined && claim.run.target.preset !== undefined) {
    throw new Error(`target preset ${claim.run.target.preset} requires the agentPresets service`)
  }
  const setup = async (agentCtx: Context): Promise<void> => {
    if (resume) installRecoveryWakeFilter(agentCtx)
    if (presets === undefined) {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    } else {
      await presets.mount(agentCtx, claim.run.target.preset)
    }
  }
  if (resume) {
    return await ctx.agents.resume({
      resumeSessionId: SessionId(claim.sessionId),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
  }
  return await ctx.agents.create({
    sessionId: SessionId(claim.sessionId),
    meta: {
      cwd: claim.run.target.cwd,
      ...(claim.run.target.preset === undefined ? {} : { agentPreset: claim.run.target.preset }),
    },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup,
  })
}

export function applyPermission(ctx: Context, agent: Agent, target: TargetSpec): void {
  if (target.permissionPreset === undefined) return
  const permissions = ctx.get('permissionPresets')
  if (permissions === undefined) throw new Error(`target permission preset ${target.permissionPreset} requires the permissionPresets service`)
  permissions.set(agent.session, target.permissionPreset)
}

function resolveSelection(ctx: Context, target: TargetSpec): ModelSelection {
  if (target.provider !== undefined && target.model !== undefined) {
    return { provider: target.provider, model: target.model }
  }
  return ctx.agentDefaultModel.currentSelection()
}
