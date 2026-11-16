// A text file with line numbers: the numbers are not part of the text (a copy takes the code only), and long lines scroll
// sideways in the box rather than wrapping, so line N on screen is line N of the file.
export function CodeView({ text }: { text: string }) {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop() // a final newline ends the last line, it is not one more
  const width = `${String(lines.length).length + 1}ch`
  return (
    <div
      data-testid="code-view"
      className="overflow-x-auto rounded-button border border-line bg-bg font-mono text-xs leading-5"
    >
      <table className="border-collapse">
        <tbody>
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a line's place in the file is what it is
            <tr key={i}>
              <td
                data-testid="line-no"
                aria-hidden="true"
                style={{ minWidth: width }}
                className="select-none border-r border-line px-2 text-right align-top text-text-3"
              >
                {i + 1}
              </td>
              <td className="whitespace-pre px-3 align-top text-text">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
