import Foundation
import TalosDesktopCore
import TalosSupervisor

/// `Talos --update-check`: the read-only report of which running thread sessions an update would restart (UpdateCheck.swift,
/// WorkerUpdateCheck.swift). No window, no supervisor: a worker manager is made with the app's own launch settings (desktop.json as
/// the app reads it at its start, the login shell's environment, the bundle's sealed hook) and never ticks, so it takes no lock and
/// runs no tmux. No audit log is given to it, and nothing posts.
@MainActor
enum UpdateCheckCLI {
  static func run(_ args: [String]) -> Int32 {
    UpdateCheckCommand.run(
      args, out: { print($0) }, err: { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }, check: check)
  }

  private static func check() -> WorkerManager.UpdateCheckOutcome {
    let home = NSHomeDirectory()
    // desktop.json there and unreadable: said, and every running session unknown (never the defaults in its place)
    let (cfg, known) = UpdateCheckLaunch.config(ConfigFile.read(SupervisorController.configPath)) {
      PreSetup.startupConfig(file: nil, store: DefaultsStore())
    }
    // the environment as launchd gives the app, never this caller's: the login shell once, in the foreground (`WorkerLaunchEnv.env`)
    let seed = UpdateCheckLaunch.seed(caller: ProcessInfo.processInfo.environment)
    let (env, shell) = UpdateCheckLaunch.baseEnv(caller: ProcessInfo.processInfo.environment, overrides: cfg.env)
    let src = SupervisorController.launchSource(cfg, loginEnv: env)
    // the app's own options (no audit log: this look audits nothing), with the launch source as the tick applies it. No tmux is ever
    // run here: the dry plan runs none, and a manager that never ticks makes no call (a path that is not one)
    var o = SupervisorController.workerOptions(
      cfg: cfg, talosHome: SupervisorController.talosHome(cfg: cfg, env: seed), tmux: "/nonexistent/update-check-runs-no-tmux",
      conf: "/nonexistent", auditPath: nil)
    o.agentDir = src.agentDir
    o.claudePath = src.claudePath
    o.permissionFlag = src.permissionFlag
    o.mainArgs = src.mainArgs
    o.home = home
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { shell }), baseEnv: { env })
    m.hasLoginEnv = { shell != nil }
    m.updateRestart.launchEnv = { cfg.env }
    return m.updateCheck(loginEnvKnown: shell != nil, launchSettingsKnown: known)
  }
}
