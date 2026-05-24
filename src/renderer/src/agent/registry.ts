import type { AgentProvider, AgentProviderId } from './types'
import { DeepseekRuntimeProvider } from './deepseek-runtime'
import { ReasonixRuntimeProvider } from './reasonix-runtime'

export function getProvider(id: AgentProviderId): AgentProvider {
  if (id === 'reasonix-runtime') return new ReasonixRuntimeProvider()
  return new DeepseekRuntimeProvider()
}
