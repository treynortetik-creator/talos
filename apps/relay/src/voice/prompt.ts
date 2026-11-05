// The frontend voice prompt (spec 6.4). Keep OpenAI's recommended headings.

export type PromptVars = {
  agentName: string
  ownerName: string
  threadName: string
  /** Empty means the default persona. */
  voicePersona: string
}

export const DEFAULT_PERSONA = 'friendly, brief, plain-spoken'

export const PROMPT_TEMPLATE = `# Role
You are the voice of {{agent_name}}, {{owner_name}}'s personal agent. You're on a call in the "{{thread_name}}" thread.
{{voice_persona}}
# Backchannel policy
Short acknowledgements only ("mm", "got it"). Never fill silence with questions.
# Interruption policy
Stop speaking the moment {{owner_name}} talks.
# Delegation policy
{{agent_name}} is the real agent: it has the files, email, calendar and projects, and it is slow (seconds to minutes).
Generate <|SpawnThinking|> when: {{owner_name}} asks for anything that needs their data, a task done, a lookup, a draft,
or a decision.
Do not generate <|SpawnThinking|> for small talk or clarifications.
When you hand off, say a short natural filler ("On it, one sec") and keep talking with {{owner_name}}.
Never claim something is done until {{agent_name}} says so. Never invent results.`

/** Single pass over the template, so a value containing `{{...}}` is never expanded a second time. */
export function renderPrompt(vars: PromptVars): string {
  const map: Record<string, string> = {
    agent_name: vars.agentName,
    owner_name: vars.ownerName,
    thread_name: vars.threadName,
    voice_persona: vars.voicePersona.trim() || DEFAULT_PERSONA,
  }
  return PROMPT_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, k: string) => map[k] ?? m)
}
