// WHERE Main's Claude Code reads its config (and so its plugins) from, for the bridge. The supervisor builds Main's environment from the login shell and
// supervisor.json's `env` (buildLaunchEnv), and every session and the launch signature read the plugins from `mainClaudeDir(thatEnv)`: this builds the same
// environment here, so the install, its after-check and the Settings flag look in the same folder. `set` says whether CLAUDE_CONFIG_DIR is set in it: the
// install is told the folder only then (with it unset Claude Code reads ~/.claude.json, which a stray CLAUDE_CONFIG_DIR=~/.claude would move to ~/.claude/.claude.json).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mainClaudeDir } from '../claude-dir.ts'
import { defaultHome } from '../config.ts'
import { readSupervisorConfig } from '../supervisor/cli.ts'
import { buildLaunchEnv, processEnv } from '../supervisor/launch-env.ts'
import { loginShellEnvAsync } from '../supervisor/login-env.ts'

export type MainDir = { dir: string; set: boolean }

/** How long the login shell's answer is kept: each read runs the owner's shell profile (up to 5 s). */
export const MAIN_DIR_TTL_MS = 5 * 60_000

export class MainClaudeDir {
  private last: MainDir | undefined
  private at = Number.NEGATIVE_INFINITY
  private inFlight: Promise<MainDir> | undefined

  constructor(
    private readonly home: string = process.env.TALOS_APP_HOME || defaultHome(),
    private readonly userHome: string = homedir(),
    private readonly login: () => Promise<Record<string, string> | null> = () =>
      loginShellEnvAsync(process.env.SHELL || '/bin/bash', processEnv()),
    private readonly now: () => number = Date.now,
  ) {}

  private from(shell: Record<string, string>): MainDir {
    const cfg = readSupervisorConfig(this.home, this.userHome)
    const env = buildLaunchEnv(shell, 'error' in cfg ? {} : cfg.env)
    return { dir: mainClaudeDir(env, this.userHome), set: Boolean(env.CLAUDE_CONFIG_DIR) }
  }

  /** Without waiting for a shell: the last answer, else this process's environment (what a bridge started from Main's own shell shares). */
  sync(): MainDir {
    try {
      return this.last ?? this.from(processEnv())
    } catch {
      return { dir: join(this.userHome, '.claude'), set: false }
    }
  }

  /**
   * The login shell's environment, as Main's start would see it; remembered for `sync`, and for MAIN_DIR_TTL_MS: reads inside it (and reads at the same
   * moment) share one spawn of the shell.
   */
  resolve(): Promise<MainDir> {
    if (this.last && this.now() - this.at < MAIN_DIR_TTL_MS) return Promise.resolve(this.last)
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async read(): Promise<MainDir> {
    try {
      const login = await this.login()
      this.last = this.from(login ?? processEnv())
    } catch {
      this.last ??= this.sync()
    }
    this.at = this.now()
    return this.last
  }
}

/** One for the bridge: the install resolves it at each request and tap, the Settings flag reads the last answer. */
export const mainClaudeDirs = new MainClaudeDir()
