// The services only a live main-session bridge runs, started once by the bridge: settings proposals, dialogs, questions, screen consent,
// plugin adds, action-rule asks and linked agents. Each is a card service on the context; none is started in a worker or a headless bridge.
import { ActionRuleAsks } from './action-rule-asks.ts'
import type { BridgeOptions } from './bridge-options.ts'
import { ConfigProposals } from './config-propose/service.ts'
import type { BridgeContext } from './context.ts'
import { DialogCards } from './dialog-card.ts'
import { PeerService } from './peer/service.ts'
import { QuestionAsks } from './permission/question.ts'
import { AgentPlugins } from './plugins/agent-plugins.ts'
import { ScreenConsent } from './screen-consent.ts'

export function startMainCards(ctx: BridgeContext, peers: BridgeOptions['peers']): void {
  ctx.configProposals = new ConfigProposals(ctx)
  ctx.dialogs = new DialogCards(ctx)
  ctx.questions = new QuestionAsks(ctx)
  ctx.screenConsent = new ScreenConsent(ctx)
  ctx.agentPlugins = new AgentPlugins(ctx)
  ctx.actionRuleAsks = new ActionRuleAsks(ctx)
  ctx.peers = new PeerService(ctx, peers)
}
