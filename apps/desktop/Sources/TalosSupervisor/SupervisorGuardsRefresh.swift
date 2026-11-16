import Foundation
import TalosDesktopCore

/// What the supervisor remembers about the guards across starts of Main, for this run of the app.
struct GuardsRefreshState {
  /// A failed refresh was said on the phone (once per run).
  var failureTold = false
  /// Starts of Main in a row whose refresh found another one running, and whether that was said.
  var busyInARow = 0
  var busyTold = false
  /// The bun the owner was last told the hook moved to.
  var bunTold: String?
  /// Main's pinned bun or cli.ts found gone: the pin, whether the owner was told, and whether Main was restarted for it.
  var goneFor: String?
  var goneTold = false
  var goneRestarted = false
  var goneCheckedAt: Double?
}

extension Supervisor {
  /// Before each start of Main, while the guards are installed: the bridge's own `guards refresh` (guards/refresh.ts), run as
  /// `<bun> <checkout>/apps/bridge/src/cli.ts guards refresh` with the bun from a fixed list (`GuardsRefresh.bunCandidates`, by its
  /// real path) and the cli.ts of the checkout the installed hook names, in an environment of three fixed variables. Nothing comes from
  /// desktop.json (`talos_app_command`, its PATH or env) or the agent folder, which a session can edit (Fable R1-1); a bun or a cli.ts
  /// inside the Talos home, the agent folder, a thread's folder or a temp folder is refused before anything runs. The app only runs it
  /// and reads its one line (`GuardsRefresh.parse`). Not installed: nothing runs. A change gets an audit row naming what changed, and
  /// a new bun is told to the owner once; a failure gets a row and one phone line per run, and Main starts under the guards as they were.
  func refreshGuards(env _: [String: String]) {
    guard let data = probe.readFile(GuardsSettings.path(talosHome: talosAppHome)) else { return }
    let pinned = GuardsRefresh.pins(settings: data).map { Self.realPath($0.bun) ?? $0.bun }
    let outcome = runGuardsRefresh(data)
    // the owner hears once whenever the bun the app finds is not the one the hook was pinned to, whatever the refresh said (R2-3)
    if let pinned, let chosen = chosenBun(), chosen != pinned, guardsRefresh.bunTold != chosen {
      guardsRefresh.bunTold = chosen
      let moved: Bool = { if case .changed(let c) = outcome { return c.contains(.bun) } else { return false } }()
      postToPhone { _ in moved ? GuardsRefresh.bunChangedLine(bun: chosen) : GuardsRefresh.bunDiffersLine(pinned: pinned, chosen: chosen) }
    }
    if case .refused("busy") = outcome {
      guardsRefresh.busyInARow += 1
    } else {
      guardsRefresh.busyInARow = 0
    }
    guard let report = GuardsRefresh.report(outcome) else { return }
    audit(report.event, report.fields)
    if guardsRefresh.busyInARow >= GuardsRefresh.busyLimit, !guardsRefresh.busyTold {
      guardsRefresh.busyTold = postToPhone { _ in GuardsRefresh.busyLine }
    }
    if report.tellOwner, !guardsRefresh.failureTold, let why = report.fields["why"] {
      guardsRefresh.failureTold = postToPhone { _ in GuardsRefresh.phoneLine(why: why) }
    }
  }

  /// The bun a refresh runs with now: the first of the fixed list that is an executable file, by its real path.
  func chosenBun() -> String? {
    let list = options.guardsBunCandidates ?? GuardsRefresh.bunCandidates(home: options.home)
    for c in list where probe.isExecutable(c) {
      if let r = Self.realPath(c), probe.isExecutable(r) { return r }
    }
    return nil
  }

  /// Folders no pin may be in: the Talos home, the agent folder, each thread's own folder (config.json), and the temp folders.
  func sessionFolders() -> [String] {
    var out = [talosAppHome, config.expandedAgentDir(home: options.home)]
    if let d = probe.readFile(talosAppHome + "/config.json") {
      out += DedicatedSettings.parse(d).threads.values.compactMap(\.cwd)
    }
    return out.map { Self.realPath($0) ?? $0 } + options.guardsTmpRoots
  }

  private func runGuardsRefresh(_ settings: Data) -> GuardsRefresh.Outcome {
    guard let pins = GuardsRefresh.pins(settings: settings) else { return .failed("guards settings unreadable") }
    guard let cli = Self.realPath(pins.cli), FileManager.default.fileExists(atPath: cli) else { return .failed("checkout missing") }
    guard let bun = chosenBun() else { return .failed("bun not found") }
    let unsafe = sessionFolders()
    if GuardsRefresh.isUnder(cli, unsafe) { return .failed("checkout in a session folder") }
    if GuardsRefresh.isUnder(bun, unsafe) { return .failed("bun in a session folder") }
    let r = probe.guardsRefresh(command: [bun, cli], env: GuardsRefresh.childEnv(home: options.home, talosHome: talosAppHome))
    return GuardsRefresh.parse(status: r.status, timedOut: r.timedOut, stdout: r.stdout)
  }

  static func realPath(_ p: String) -> String? {
    guard let r = realpath(p, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
  }

  /// Every few seconds while Main runs under the guards: the bun and cli.ts its launch file's hook names. Gone (a `brew upgrade bun`
  /// removed the old version), the hook denies every guarded call (it fails closed), so Main is useless until it restarts: one audit
  /// row, one line to the owner, and a restart of Main the moment nobody is typing and the restart check says it would come back (the
  /// check `restart_main` uses), once per pin. The start that follows refreshes the guards onto the bun found now.
  func guardHookTick(_ now: Double) {
    guard case .running = phase, holdsSessionLock, !ownerStopped else { return }
    if let at = guardsRefresh.goneCheckedAt, now - at < timings.restartCheckEvery { return }
    guardsRefresh.goneCheckedAt = now
    guard let pins = GuardsRefresh.pins(settings: probe.readFile(GuardsSettings.mainLaunchPath(talosHome: talosAppHome))) else { return }
    guard !probe.isExecutable(pins.bun) || !FileManager.default.fileExists(atPath: pins.cli) else { return }
    let pin = pins.bun + "|" + pins.cli
    if guardsRefresh.goneFor != pin {
      guardsRefresh.goneFor = pin
      guardsRefresh.goneTold = false
      guardsRefresh.goneRestarted = false
      audit("guard_hook_gone", ["session": "main"])
    }
    if !guardsRefresh.goneTold { guardsRefresh.goneTold = postToPhone { _ in GuardsRefresh.mainHookGoneLine } }
    guard !guardsRefresh.goneRestarted else { return }
    // a restart that could not re-pin would only stop Main again: wait for a bun to be found
    guard chosenBun() != nil else { return }
    guard !clientsMayBeTyping() else { return }
    guard restartCheckVerdict(now).willReturn else { return }
    guardsRefresh.goneRestarted = true
    audit("guard_hook_restart", ["session": "main"])
    restartCold()
  }
}
