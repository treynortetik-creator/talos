// What the agent is told about each tool, in the words and place the instruction text uses them (apps/bridge/src/instructions.ts
// puts them together). The words live on each tool's own record (`instructions`, a string or null); this reads them back by name.
import { AGENT_TOOLS } from './table.ts'

/** What the agent is told about a tool. A name with no record, or a record with no words, is a mistake in the caller and throws. */
export function toolInstructions(name: string): string {
  const text = AGENT_TOOLS[name]?.instructions
  if (typeof text !== 'string') throw new Error(`agent tool "${name}" has no instruction text`)
  return text
}
