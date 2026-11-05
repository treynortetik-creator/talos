import { describe, expect, it } from 'vitest'
import { renderPrompt } from '../../src/voice/prompt.ts'

describe('prompt', () => {
  it('matches the snapshot', () => {
    expect(
      renderPrompt({ agentName: 'Talos', ownerName: 'Alex Example', threadName: 'General', voicePersona: '' }),
    ).toMatchInlineSnapshot(`
      "# Role
      You are the voice of Talos, Alex Example's personal agent. You're on a call in the "General" thread.
      friendly, brief, plain-spoken
      # Backchannel policy
      Short acknowledgements only ("mm", "got it"). Never fill silence with questions.
      # Interruption policy
      Stop speaking the moment Alex Example talks.
      # Delegation policy
      Talos is the real agent: it has the files, email, calendar and projects, and it is slow (seconds to minutes).
      Generate <|SpawnThinking|> when: Alex Example asks for anything that needs their data, a task done, a lookup, a draft,
      or a decision.
      Do not generate <|SpawnThinking|> for small talk or clarifications.
      When you hand off, say a short natural filler ("On it, one sec") and keep talking with Alex Example.
      Never claim something is done until Talos says so. Never invent results."
    `)
  })

  it('uses the persona from config when set', () => {
    const p = renderPrompt({
      agentName: 'Talos',
      ownerName: 'Alex',
      threadName: 'General',
      voicePersona: 'Dry and calm.',
    })
    expect(p).toContain('Dry and calm.')
    expect(p).not.toContain('friendly, brief')
  })

  it('substitutes in one pass: a placeholder inside a value is not expanded', () => {
    const p = renderPrompt({
      agentName: '{{owner_name}}',
      ownerName: 'Alex',
      threadName: '{{voice_persona}}',
      voicePersona: '',
    })
    expect(p).toContain('You are the voice of {{owner_name}}')
    expect(p).toContain('"{{voice_persona}}" thread')
  })

  it('keeps the recommended headings', () => {
    const p = renderPrompt({ agentName: 'A', ownerName: 'B', threadName: 'C', voicePersona: '' })
    for (const h of ['# Role', '# Backchannel policy', '# Interruption policy', '# Delegation policy'])
      expect(p).toContain(h)
  })
})
