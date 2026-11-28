// What the screen-reader announcer says when a card is answered: "Answered: " and the label of the button that was pressed.
// The labels come from the agent, so they are cut at ANSWER_LABEL_MAX and their hidden characters are shown, as on the buttons.
import { type CardT, dialogOf, dialogVisibleText } from '@talos-app/protocol'
import { answered } from '../../lib/announceText.ts'

const ANSWER_LABEL_MAX = 80

export function answeredSaid(label: string): string {
  const one = label.replace(/\s+/g, ' ').trim()
  return answered(one.length > ANSWER_LABEL_MAX ? `${one.slice(0, ANSWER_LABEL_MAX - 1)}…` : one)
}

/** A dialog card's button: its option label, or the card's one button (a sign-in) when no option was chosen. */
export function choiceSaid(card: CardT, choice: number | null): string {
  const label = choice === null ? card.primary_label : (dialogOf(card)?.options[choice] ?? card.primary_label)
  return answeredSaid(dialogVisibleText(label))
}
