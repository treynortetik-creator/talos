// The MCP servers a thread's own session may use (`threads[].session_opts.mcp_allow`, docs/OPTION-C.md "Leads and the fence").
// Off = no list: the session gets what Claude Code gives it today. On = only the servers named here, plus talos-app, which it
// always has. Each change is one owner-signed thread patch through `onChange`.
import { MCP_ALLOW_MAX, McpAllowList } from '@talos-app/protocol'
import { useId, useState } from 'react'
import { Button, Input, Switch } from '../../ui/index.ts'

export function McpAllow({
  value,
  locked,
  onChange,
}: {
  value: readonly string[] | undefined
  locked: boolean
  /** `undefined` = no list. */
  onChange: (next: string[] | undefined) => Promise<unknown>
}) {
  const ids = { sw: useId(), add: useId() }
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const on = value !== undefined
  const list = value ?? []

  const add = async () => {
    const name = text.trim()
    if (!name) return
    if (name === 'talos-app') {
      setProblem('talos-app is always allowed.')
      return
    }
    if (list.includes(name)) {
      setProblem(`${name} is already on the list.`)
      return
    }
    if (list.length >= MCP_ALLOW_MAX) {
      setProblem(`The list holds up to ${MCP_ALLOW_MAX} servers.`)
      return
    }
    if (!McpAllowList.safeParse([name]).success) {
      setProblem('A server name is up to 80 characters, with no commas, control characters or spaces at the ends.')
      return
    }
    setProblem(null)
    setText('')
    await onChange([...list, name])
  }

  return (
    <div className="flex flex-col gap-1 text-xs text-text-2" data-testid="mcp-allow">
      <div className="flex min-h-11 items-center justify-between gap-2">
        <label htmlFor={ids.sw} className="text-sm font-medium text-text">
          Limit MCP servers
        </label>
        <Switch
          id={ids.sw}
          checked={on}
          disabled={locked}
          onCheckedChange={(v) => void onChange(v ? [] : undefined)}
          data-testid="mcp-allow-switch"
        />
      </div>
      {!on && <span>Off: the session gets whatever servers Claude Code gives it.</span>}
      {on && (
        <>
          <span>Only talos-app and these. Use the names Claude Code shows, like github or claude.ai Gmail.</span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Allowed MCP servers">
            {list.map((name) => (
              <li key={name} className="flex min-h-11 items-center justify-between gap-2 text-sm text-text">
                <span className="break-all">{name}</span>
                <Button
                  variant="outline"
                  disabled={locked}
                  aria-label={`Remove ${name}`}
                  onClick={() => void onChange(list.filter((n) => n !== name))}
                >
                  Remove
                </Button>
              </li>
            ))}
            {list.length === 0 && <li>No other servers.</li>}
          </ul>
          <label htmlFor={ids.add}>Add a server</label>
          <div className="flex gap-2">
            <Input
              id={ids.add}
              value={text}
              disabled={locked}
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => {
                setProblem(null)
                setText(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add()
              }}
            />
            <Button variant="outline" disabled={locked || !text.trim()} onClick={() => void add()}>
              Add
            </Button>
          </div>
          {problem && (
            <p role="alert" className="m-0 text-danger">
              {problem}
            </p>
          )}
        </>
      )}
    </div>
  )
}
