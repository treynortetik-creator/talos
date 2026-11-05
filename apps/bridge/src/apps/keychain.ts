// Secrets live only in the macOS login Keychain (M5.6, rev 2.4): OAuth tokens and client registrations, each http/sse
// server's reported config (URL and headers), and the HMAC key behind the config fingerprint. The runner is an interface:
// tests use a memory double and never touch a real Keychain; the real runner drives /usr/bin/security with values on STDIN.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { b64urlDecode, b64urlEncode, jcs } from '@talos-app/protocol'

export const KEYCHAIN_SERVICE = 'talos-app.direct'
const ACCOUNT = /^[0-9a-f]{16}\/(oauth|config|hmac-key)$/
const VALUE_PREFIX = 'v1.'

export class KeychainError extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'bad_account',
  ) {
    super(message)
  }
}

export interface KeychainRunner {
  /** `value` is any string; the runner stores it encoded so no character reaches a command line unescaped. */
  write(account: string, value: string): Promise<void>
  /** `undefined` for a missing item; throws `KeychainError` when the Keychain cannot be read (locked, no tool). */
  read(account: string): Promise<string | undefined>
  delete(account: string): Promise<void>
}

export type SpawnResult = { code: number; stdout: string }
export type KeychainSpawn = (argv: string[], stdin?: string) => Promise<SpawnResult>

/** argv array only, never a shell. */
export const bunKeychainSpawn: KeychainSpawn = async (argv, stdin) => {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  if (stdin !== undefined) {
    const sink = proc.stdin as { write(s: string): unknown; end(): unknown }
    sink.write(stdin)
    sink.end()
  }
  const [stdout, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited])
  return { code, stdout }
}

const SECURITY = '/usr/bin/security'

export function securityRunner(spawn: KeychainSpawn = bunKeychainSpawn): KeychainRunner {
  const check = (account: string) => {
    if (!ACCOUNT.test(account)) throw new KeychainError('bad keychain account', 'bad_account')
  }
  return {
    async write(account, value) {
      check(account)
      const enc = VALUE_PREFIX + b64urlEncode(new TextEncoder().encode(value))
      // `security -i` reads commands from stdin, so the secret never appears in argv or `ps` (gate G9)
      const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${enc}\n`
      let r: SpawnResult
      try {
        r = await spawn([SECURITY, '-i'], line)
      } catch {
        throw new KeychainError('Keychain tool could not start', 'unavailable')
      }
      if (r.code !== 0) throw new KeychainError('Keychain write failed', 'unavailable')
    },
    async read(account) {
      check(account)
      let r: SpawnResult
      try {
        r = await spawn([SECURITY, 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])
      } catch {
        throw new KeychainError('Keychain tool could not start', 'unavailable')
      }
      if (r.code === 44) return undefined // errSecItemNotFound
      if (r.code !== 0) throw new KeychainError('Keychain locked or unreadable', 'unavailable')
      const text = r.stdout.trim()
      if (!text.startsWith(VALUE_PREFIX)) throw new KeychainError('Keychain item is not ours', 'unavailable')
      return new TextDecoder().decode(b64urlDecode(text.slice(VALUE_PREFIX.length)))
    },
    async delete(account) {
      check(account)
      try {
        await spawn([SECURITY, '-i'], `delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${account}\n`)
      } catch {
        throw new KeychainError('Keychain tool could not start', 'unavailable')
      }
    },
  }
}

/** First 16 hex of sha256(server, source), the account stem. */
export const serverIdOf = (server: string, source: string): string =>
  createHash('sha256').update(`${server}\u0000${source}`).digest('hex').slice(0, 16)

/** Per-server secrets on top of a runner. */
export class ServerSecrets {
  constructor(private readonly kc: KeychainRunner) {}

  async hmacKey(id: string): Promise<Uint8Array> {
    const have = await this.kc.read(`${id}/hmac-key`)
    if (have) return b64urlDecode(have)
    const key = new Uint8Array(randomBytes(32))
    await this.kc.write(`${id}/hmac-key`, b64urlEncode(key))
    return key
  }

  /** HMAC-SHA256 (hex) over the JCS form of the reported config. Two callers with the same config get the same value. */
  async fingerprint(id: string, config: unknown): Promise<string> {
    const key = await this.hmacKey(id)
    return createHmac('sha256', key).update(jcs(config)).digest('hex')
  }

  async saveConfig(id: string, config: unknown): Promise<void> {
    await this.kc.write(`${id}/config`, jcs(config))
  }

  async loadConfig(id: string): Promise<Record<string, unknown> | undefined> {
    const raw = await this.kc.read(`${id}/config`)
    if (raw === undefined) return undefined
    try {
      const v: unknown = JSON.parse(raw)
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  async saveOauth(id: string, state: unknown): Promise<void> {
    await this.kc.write(`${id}/oauth`, jcs(state))
  }

  async loadOauth(id: string): Promise<Record<string, unknown> | undefined> {
    const raw = await this.kc.read(`${id}/oauth`)
    if (raw === undefined) return undefined
    try {
      const v: unknown = JSON.parse(raw)
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  /** `apps logout`: the server's `oauth` and `config` items. */
  async logout(id: string): Promise<void> {
    await this.kc.delete(`${id}/oauth`)
    await this.kc.delete(`${id}/config`)
  }
}
