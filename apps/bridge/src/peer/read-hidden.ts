// Reads one line from the terminal with no echo (`talos-app peer add`).
/** One line from the terminal with no echo (raw mode); falls back to a plain line when stdin is not a terminal. */
export async function readHidden(question: string): Promise<string> {
  const stdin = process.stdin
  process.stdout.write(question)
  if (!stdin.isTTY) {
    for await (const line of console) return String(line)
    return ''
  }
  stdin.setRawMode(true)
  stdin.resume()
  return await new Promise<string>((resolve) => {
    let text = ''
    const on = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', on)
          process.stdout.write('\n')
          return resolve(text)
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false)
          process.exit(130)
        }
        text = ch === '\u007f' ? text.slice(0, -1) : text + ch
      }
    }
    stdin.on('data', on)
  })
}
