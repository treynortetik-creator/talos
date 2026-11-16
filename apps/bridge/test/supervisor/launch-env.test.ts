// An adopted Main's environment, from /proc/<pid>/environ: what its process really has.
import { describe, expect, it } from 'bun:test'
import { buildMainEnv, MAIN_LOGIN_ENV, processEnviron } from '../../src/supervisor/launch-env.ts'

describe('a process’s own environment', () => {
  it('reads /proc/<pid>/environ: NUL-separated name=value, a value that holds = kept whole', () => {
    const seen: string[] = []
    const env = processEnviron(4242, (p) => {
      seen.push(p)
      return Buffer.from('PATH=/usr/bin\0CLAUDE_CODE_RESTRICTED=1\0X=a=b\0\0')
    })
    expect(seen).toEqual(['/proc/4242/environ'])
    expect(env).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_RESTRICTED: '1', X: 'a=b' })
  })
  it('one that cannot be read, or no real pid, is null (never an empty environment)', () => {
    expect(
      processEnviron(4242, () => {
        throw new Error('EACCES')
      }),
    ).toBeNull()
    expect(processEnviron(0)).toBeNull()
    expect(processEnviron(1)).toBeNull()
  })
  it('this process’s own, on Linux', () => {
    if (process.platform !== 'linux') return
    expect(processEnviron(process.pid)?.HOME).toBe(process.env.HOME) // PATH is changed at run time by bun
  })
})

describe('Main’s environment: a fixed list from the login shell (Pantheon, Fable on d3eaec7b)', () => {
  it('what a login profile plants never reaches Main; what supervisor.json’s env names does', () => {
    const env = buildMainEnv(
      {
        PATH: '/usr/bin:/bin',
        HOME: '/home/talos',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        ANTHROPIC_BASE_URL: 'http://evil.example.com',
        LD_PRELOAD: '/home/talos/x.so',
        CLAUDE_CONFIG_DIR: '/home/talos/other',
        NODE_OPTIONS: '--require /home/talos/x.js',
        CLAUDE_CODE_OAUTH_TOKEN: 'from-a-profile',
      },
      { TELEGRAM_STATE_DIR: '/home/talos/.claude/channels/telegram' },
    )
    for (const k of [
      'ANTHROPIC_BASE_URL',
      'LD_PRELOAD',
      'CLAUDE_CONFIG_DIR',
      'NODE_OPTIONS',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ])
      expect(env[k], k).toBeUndefined()
    expect(env).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/home/talos',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TELEGRAM_STATE_DIR: '/home/talos/.claude/channels/telegram',
    })
  })
  it('the list is short and holds nothing that steers Claude Code or a loader', () => {
    for (const k of MAIN_LOGIN_ENV)
      expect(/^(ANTHROPIC|CLAUDE|LD_|DYLD_|NODE_|PYTHON|BASH_ENV|ENV$)/.test(k), k).toBe(false)
    expect(MAIN_LOGIN_ENV.size).toBeLessThanOrEqual(16)
  })
})
