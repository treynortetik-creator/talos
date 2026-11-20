import Foundation

/// The permission mode of Main, as the owner sees it (Mac settings → Session): one plain choice, kept as ONE permission flag in the
/// saved launch arguments (`desktop.json` `args`). Claude Code 2.1.x: with no flag its built-in default is `auto` (v2.1.283 and
/// later), so Auto is also what a command with no permission flag shows. Nothing here runs anything; the supervisor saves and
/// restarts.
public enum PermissionMode: String, CaseIterable, Equatable, Sendable {
  /// Claude Code's classifier mode: it runs without routine prompts and asks for the rest.
  case auto
  /// Claude Code's `default` mode (called Manual in the CLI): reads only, everything else asks.
  case ask
  /// Nothing asks: no permission card ever reaches the phone.
  case bypass

  public var label: String {
    switch self {
    case .auto: return "Auto (recommended)"
    case .ask: return "Ask me"
    case .bypass: return "Bypass all"
    }
  }
}

public enum PermissionModeSetting {
  public enum Reading: Equatable, Sendable {
    case mode(PermissionMode)
    /// Flags this picker does not own as one choice (plan, accept-edits, don't-ask, two that disagree, the allow-only flag, a value
    /// it does not know): shown as custom and left as they are until a mode is chosen.
    case custom
  }

  public static let bypassLine = "No permission cards reach your phone in this mode."
  public static let customLabel = "Custom (from your launch command)"
  public static let customLine = "Your launch command sets its own permission flags. Choosing a mode replaces them."
  public static let title = "Permission mode"
  public static let applies =
    "Applies now: Talos restarts the agent for you, and that start is a cold start. You confirm the development-channel dialog once, at the Mac or on the phone card."
  public static let askFirstTitle = "The agent is working on something"
  public static let askFirstBody = "Changing the permission mode restarts the agent and ends the turn it is on. Restart it now?"
  public static let savedNotRunning = "Saved. The agent is not running: the new mode applies when it starts."

  /// The lines the phone gets about an agent's request: fixed words, never the agent's own text.
  public static func changedLine(_ mode: PermissionMode, restarting: Bool) -> String {
    let tail = restarting
      ? "Talos is restarting the agent now, and the new start waits for you to confirm the development-channel dialog at the Mac (\"Start with \(mode.label)?\")."
      : "It applies the next time the agent starts."
    // Bypass all is said plainly and with the way back: a row the owner sees, so an injected switch cannot go unseen
    if mode == .bypass {
      return "Your agent switched itself to \(mode.label). No permission cards reach your phone in this mode. If you did not ask for this, change it back in Mac settings, Session, Permission mode. \(tail)"
    }
    return "The agent asked to switch the permission mode to \(mode.label). \(tail)"
  }
  public static func alreadyLine(_ mode: PermissionMode) -> String { "The permission mode is already \(mode.label). Nothing changed." }
  public static func refusedLine(_ why: PermissionModeRequest.Refusal) -> String {
    switch why {
    case .locked: return "The agent asked to change the permission mode, but Talos settings are locked. Nothing changed."
    case .ownerStopped: return "The agent asked to change the permission mode, but you stopped it at the Mac. Nothing changed."
    case .tooSoon: return "The agent asked to change the permission mode again within two minutes. Nothing changed."
    case .custom: return "The agent asked to change the permission mode, but your launch command sets its own permission flags. Nothing changed. Choose a mode in Mac settings, Session, to replace them."
    }
  }

  static let bypassFlag = "--dangerously-skip-permissions"
  static let allowFlag = "--allow-dangerously-skip-permissions"
  static let modeFlag = "--permission-mode"

  /// The flag a mode writes: `--permission-mode auto`, `--permission-mode default` (Claude Code's canonical name for Ask me) and
  /// the bypass flag Talos already passes on to thread sessions.
  public static func flags(for mode: PermissionMode) -> [String] {
    switch mode {
    case .auto: return [modeFlag, "auto"]
    case .ask: return [modeFlag, "default"]
    case .bypass: return [bypassFlag]
    }
  }

  private static func isPermissionFlag(_ f: String) -> Bool {
    f == bypassFlag || f == allowFlag || f == modeFlag || f.hasPrefix(modeFlag + "=")
  }

  /// What the arguments say, read as Claude Code reads them (`MainArgs`): nothing after `--`, never another flag's value.
  public static func read(_ args: [String]) -> Reading {
    var modes: Set<PermissionMode> = []
    for f in MainArgs.flags(args) {
      let value: String
      if f.flag == bypassFlag {
        modes.insert(.bypass)
        continue
      } else if f.flag == allowFlag {
        return .custom
      } else if f.flag == modeFlag {
        value = f.index + 1 < args.count ? args[f.index + 1] : ""
      } else if f.flag.hasPrefix(modeFlag + "=") {
        value = String(f.flag.dropFirst(modeFlag.count + 1))
      } else {
        continue
      }
      switch value {
      case "auto": modes.insert(.auto)
      case "default", "manual": modes.insert(.ask)
      case "bypassPermissions": modes.insert(.bypass)
      default: return .custom
      }
    }
    if modes.isEmpty { return .mode(.auto) }
    return modes.count == 1 ? .mode(modes.first!) : .custom
  }

  /// The arguments with every permission flag replaced by the mode's one flag: in the place of the first one, or first when there was
  /// none (never last: a flag that waits for its value, or a variadic one, would take it). A flag after `--` or another flag's value is
  /// not a flag and is never touched.
  public static func applying(_ mode: PermissionMode, to args: [String]) -> [String] {
    var drop = Set<Int>()
    var first: Int?
    for f in MainArgs.flags(args) where isPermissionFlag(f.flag) {
      first = first ?? f.index
      drop.insert(f.index)
      if f.flag == modeFlag, f.index + 1 < args.count { drop.insert(f.index + 1) }
    }
    var out: [String] = first == nil ? flags(for: mode) : []
    for (k, a) in args.enumerated() {
      if k == first { out += flags(for: mode) }
      if !drop.contains(k) { out.append(a) }
    }
    return out
  }

  public enum Outcome: Equatable, Sendable {
    case unchanged
    /// Save these arguments. The next start is a cold one.
    case updated(args: [String])
  }

  public static func evaluate(_ mode: PermissionMode, against cfg: DesktopConfig) -> Outcome {
    if read(cfg.args) == .mode(mode) { return .unchanged }
    return .updated(args: applying(mode, to: cfg.args))
  }

  /// The config after the change: only `args` differs.
  public static func applied(_ cfg: DesktopConfig, args: [String]) -> DesktopConfig {
    var c = cfg
    c.args = args
    return c
  }

  public enum FollowUp: Equatable, Sendable {
    /// Nothing is running: the new mode applies at the next start.
    case saveOnly
    case restartNow
    /// A turn is running: the owner says whether to end it.
    case askFirst
  }

  public static func followUp(sessionUp: Bool, turnRunning: Bool) -> FollowUp {
    guard sessionUp else { return .saveOnly }
    return turnRunning ? .askFirst : .restartNow
  }

  /// `claude agents --json` says `busy` for a session on a turn (`Supervisor.Status.agentActivity`).
  public static func turnRunning(agentActivity: String?) -> Bool { agentActivity == "busy" }
}

/// `$TALOS_APP_HOME/permission-mode-request.json`: written by the bridge when Main, asked by the owner, calls `permission_mode`
/// (mode 0600, atomic). Any program running as the owner can write the file, so it carries no authority of its own: the Mac refuses
/// while the owner keeps "Lock Talos settings" on (`config.json` `settings_lock`, read again here), and the changed launch is a cold
/// start that waits for the owner's own confirmation of the development-channel dialog (the launch seal), so a forged request can
/// neither run Main in another mode unseen nor start it without the owner.
public struct PermissionModeRequest: Equatable, Sendable {
  public static let fileName = "permission-mode-request.json"
  public static let maxBytes = 4096
  public static let maxAgeMs: Double = 300_000
  public static let maxFutureMs: Double = 60_000
  public static let action = "set_permission_mode"

  public var mode: PermissionMode
  public var controlId: String
  public var ts: Double

  public init(mode: PermissionMode, controlId: String, ts: Double) {
    self.mode = mode
    self.controlId = controlId
    self.ts = ts
  }

  /// Strict: the action, the mode names the picker has, a plain id and a number. Anything else is not a request.
  public static func parse(_ data: Data) -> PermissionModeRequest? {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], JSONValue.int(o["v"]) == 1,
      o["action"] as? String == action, let m = o["mode"] as? String, let mode = PermissionMode(rawValue: m),
      let id = o["control_id"] as? String, AgentRequest.isValidId(id), let ts = o["ts"] as? NSNumber,
      CFGetTypeID(ts) != CFBooleanGetTypeID(), ts.doubleValue.isFinite
    else { return nil }
    return PermissionModeRequest(mode: mode, controlId: id, ts: ts.doubleValue)
  }

  public enum Refusal: String, Equatable, Sendable {
    case locked
    case ownerStopped = "owner_stopped"
    case tooSoon = "too_soon"
    /// The saved launch command sets its own permission flags: only the owner's pick in Mac settings replaces them.
    case custom
  }

  public enum Decision: Equatable, Sendable {
    case discard
    case refuse(Refusal)
    case apply
  }

  public static func decide(
    _ r: PermissionModeRequest, nowMs: Double, lastHandledId: String?, launchedAtMs: Double, locked: Bool, ownerStopped: Bool,
    sinceLastRequest: Double? = nil
  ) -> Decision {
    if r.controlId == lastHandledId || r.ts < launchedAtMs || nowMs - r.ts > maxAgeMs || r.ts - nowMs > maxFutureMs { return .discard }
    if locked { return .refuse(.locked) }
    if ownerStopped { return .refuse(.ownerStopped) }
    if AgentRecovery.isTooSoon(sinceLastRequest: sinceLastRequest) { return .refuse(.tooSoon) }
    return .apply
  }

  /// `settings_lock` in `config.json`. Anything that cannot be read, or is not a plain `false` or absent, counts as locked: the lock is
  /// the owner's, and a doubt never opens it.
  public static func isLocked(configJson: Data?) -> Bool {
    guard let d = configJson, let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return true }
    guard let v = o["settings_lock"] else { return false }
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return true }
    return n.boolValue
  }
}

/// What is at the request path right now (as `AgentRequestFile`: a link, a pipe, a big or damaged file is `invalid`, never read whole).
public enum PermissionModeRequestFile: Equatable, Sendable {
  case absent
  case invalid
  case request(PermissionModeRequest)

  public static func read(path: String) -> PermissionModeRequestFile {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    if fd < 0 { return errno == ENOENT ? .absent : .invalid }
    defer { Darwin.close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= PermissionModeRequest.maxBytes else { return .invalid }
    var buf = [UInt8](repeating: 0, count: PermissionModeRequest.maxBytes + 1)
    let n = Darwin.read(fd, &buf, buf.count)
    guard n >= 0, n <= PermissionModeRequest.maxBytes, let r = PermissionModeRequest.parse(Data(buf[0..<n])) else { return .invalid }
    return .request(r)
  }

  /// Deletes the file only if it is still the one `seen`, so a request written after the read is not lost.
  @discardableResult
  public static func clear(path: String, ifStill seen: PermissionModeRequestFile) -> Bool {
    guard seen != .absent, read(path: path) == seen else { return false }
    return unlink(path) == 0
  }
}

/// A saved launch command the running agent does not have yet: the Session tab says so, with one button that restarts cold (stop the
/// old process, start with the saved arguments and the same conversation). A saved command is never left unapplied without a word.
public enum LaunchPending {
  public static let button = "Restart to apply"
  public static let line =
    "The saved launch command is not the one the agent is running with. Restarting stops it and starts it again with the saved command and the same conversation. You confirm the development-channel dialog once."

  /// `running`: the pieces of the launch the agent was started with (`launchParts`); empty when it was found already running with some
  /// other command (the app reopened on an agent started before). `saved`: the config now. The program is left out: it is resolved at
  /// each start and is not what the owner edits here.
  public static func isPending(running: [String: String], saved: DesktopConfig) -> Bool {
    let now = saved.launchParts(resolvedClaude: "")
    return ["folder", "flags", "env"].contains { running[$0] != now[$0] }
  }

  /// The arguments a thread session is held to: the saved ones when Main runs with them (the arguments of its newest launch that got to
  /// running, `Status.runningArgs`) or the owner has confirmed exactly this launch (`confirmedSaved`: the seal verifies it); otherwise
  /// those Main runs with. A saved change nobody has confirmed is never passed on: not while it waits at the development-channel
  /// dialog, not between the old launch and the new one. With no launch known at all and none confirmed, no permission flag is given.
  public static func holdsThreads(saved: [String], running: [String]?, confirmedSaved: Bool) -> Bool {
    if confirmedSaved { return false }
    return running.map { ResumeRewrite.strip($0) != ResumeRewrite.strip(saved) } ?? true
  }

  public static func argsForThreads(saved: [String], running: [String]?, pending: Bool) -> [String] {
    pending ? (running ?? []) : saved
  }
}
