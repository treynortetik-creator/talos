import Foundation

/// When the Mac app restarts the agent or puts back the last good setup, and what it tells the owner. Pure: the supervisor reads
/// the inputs and does what this says.
public enum AgentRecovery {
  /// The bridge counts as down once this supervisor has watched its status stale or its process gone this long while the agent
  /// runs. Several times the 45 s a status counts as fresh, so a bridge that is only restarting is left alone.
  public static let bridgeDownLimit: Double = 300
  /// At most one phone request is acted on per this many seconds; a request that comes sooner is discarded.
  public static let requestMinGap: Double = 120

  public enum Reason: Equatable, Sendable {
    case crashLoop
    case bridgeDown
  }

  public enum Action: Equatable, Sendable {
    case none
    /// A request that is unusable, stale, from before this launch or already handled: delete the file and do nothing else.
    case discard
    case restart(controlId: String)
    /// Run `talos-app restore-last-good --yes --newest-start`, then restart. Never from a request: restore is not a phone action.
    case restore(Reason)
    /// A request that is not acted on and says so: delete the file, audit it.
    case refuse(Refusal)
  }

  public enum Refusal: String, Equatable, Sendable {
    case tooSoon = "too_soon"
    /// The owner pressed Stop at the Mac. That wins over the phone; the owner is told.
    case ownerStopped = "owner_stopped"
  }

  public enum Outcome: Equatable, Sendable {
    case restartedOnRequest
    /// The automatic restore ran. `restarted` is false when the owner pressed Stop while it ran, or the app no longer holds the session (it quit or detached).
    case restored(Reason, RestoreResult, restarted: Bool)
    case restoreFailed
    case ignoredOwnerStopped
    case ignoredTooSoon
  }

  /// What `talos-app restore-last-good` said it did, read from its one stable output line and nothing else. The output is
  /// text from a command that reads files the agent can write, so only an exact match is quoted: the files must be the three
  /// setup files and the date digits, never free text.
  public enum RestoreResult: Equatable, Sendable {
    /// `files` is the setup file names joined by ", " (a file it moved aside says so); `saved` is "YYYY-MM-DD HH:MM UTC".
    case changed(files: String, saved: String)
    case nothingToChange
    /// Exit 0 but no line this app knows: still restored, nothing to say about what.
    case unknown

    static let setupFiles = [".mcp.json", ".claude/settings.json", ".claude/settings.local.json"]
    private static let lead = "restore-last-good: restored "
    private static let mid = " from the version saved "
    private static let nothing = [
      "restore-last-good: the agent folder already matches that version. Nothing to do.",
      "restore-last-good: the agent folder already matches the saved versions. Nothing to do.",
    ]

    public static func parse(_ out: String) -> RestoreResult {
      // The version list the command prints first holds `from <agent folder>`, and a folder name can hold a newline, so a line in
      // it can look like the result. The result is what the command prints last.
      var found = RestoreResult.unknown
      for line in out.split(separator: "\n", omittingEmptySubsequences: true) {
        let l = String(line)
        if let c = changed(l) { found = c } else if nothing.contains(l) { found = .nothingToChange }
      }
      return found
    }

    private static func changed(_ l: String) -> RestoreResult? {
      guard l.hasPrefix(lead) else { return nil }
      let parts = l.dropFirst(lead.count).components(separatedBy: mid)
      guard parts.count == 2, isDate(parts[1]) else { return nil }
      let files = parts[0].components(separatedBy: ", ")
      guard (1...setupFiles.count).contains(files.count),
        files.allSatisfy({ f in setupFiles.contains { f == $0 || f == $0 + " (moved aside)" } })
      else { return nil }
      return .changed(files: parts[0], saved: parts[1])
    }

    /// `2026-11-02 17:02 UTC`, ASCII digits only.
    private static func isDate(_ s: String) -> Bool {
      let u = Array(s.utf8)
      let shape = Array("dddd-dd-dd dd:dd UTC".utf8)
      guard u.count == shape.count else { return false }
      return zip(u, shape).allSatisfy { $1 == UInt8(ascii: "d") ? ($0 >= 0x30 && $0 <= 0x39) : $0 == $1 }
    }
  }

  /// `crashLoopStopped`: the supervisor stopped restarting because `CrashLoop` said the cap was hit. `bridgeDownFor` is seconds
  /// the supervisor has watched the bridge down (see `BridgeWatch`); `restoredOnce` is the latch that keeps the automatic restore
  /// to one. `ownerStopped`: the owner pressed Stop at the Mac. `sinceLastRequest`: seconds since a request was last acted on.
  /// `launchedAtMs`: when this supervisor started, in whole unix ms. A request dated before it was written while the app was closed,
  /// and Stop and "start on launch" are not remembered across a launch, so it must not start the agent.
  public static func decide(
    request: AgentRequestFile, nowMs: Double, lastHandledId: String?, crashLoopStopped: Bool, bridgeDownFor: Double,
    restoredOnce: Bool, ownerStopped: Bool = false, sinceLastRequest: Double? = nil, launchedAtMs: Double = 0
  ) -> Action {
    switch request {
    case .invalid: return .discard
    case .request(let r):
      if r.controlId == lastHandledId || r.isStale(nowMs: nowMs) || r.ts < launchedAtMs { return .discard }
      // Product decision, one line to flip: while the owner's Stop stands, the phone's request is ignored.
      if ownerStopped { return .refuse(.ownerStopped) }
      if let since = sinceLastRequest, since < requestMinGap { return .refuse(.tooSoon) }
      return .restart(controlId: r.controlId)
    case .absent: break
    }
    guard !restoredOnce else { return .none }
    if crashLoopStopped { return .restore(.crashLoop) }
    if bridgeDownFor >= bridgeDownLimit { return .restore(.bridgeDown) }
    return .none
  }

  /// How the bridge looks from its status file, nil when that cannot be told: no file, or a stamp from the future (a skewed or
  /// forged file says nothing about an outage).
  public static func bridgeHealth(_ s: BridgeStatus?, nowMs: Double, pidAlive: (Int32) -> Bool) -> BridgeStatus.Health? {
    guard let s else { return nil }
    let now = Date(timeIntervalSince1970: nowMs / 1000)
    if s.updatedAt.timeIntervalSince(now) > 5 { return nil }  // health() calls that stale; it is not an outage
    return s.health(now: now, pidAlive: pidAlive)
  }

  /// What this supervisor has seen of the bridge during the current start, on a clock that stops while the Mac sleeps. The status
  /// file's own age is wall-clock, so a long sleep would read as a long outage, and the bridge never deletes the file, so one
  /// from an old run or a bridge the owner turned off would read as down from the first tick: only a bridge seen healthy in this
  /// start can go down, and only the time spent awake and watching counts.
  public struct BridgeWatch: Equatable, Sendable {
    var seenUp = false
    /// Awake-clock time of the first tick that saw it down; nil while it is not.
    public private(set) var downSince: Double?
    public init() {}

    /// One tick. Any tick the agent is not in its running phase starts the watch over (the next start has seen nothing yet).
    public mutating func observe(_ health: BridgeStatus.Health?, running: Bool, awakeNow: Double) {
      guard running else { return self = BridgeWatch() }
      switch health {
      case .healthy?:
        seenUp = true
        downSince = nil
      case .stale?, .dead?:
        if seenUp { downSince = downSince ?? awakeNow }
      default:
        downSince = nil
      }
    }

    public func downFor(awakeNow: Double) -> Double { downSince.map { awakeNow - $0 } ?? 0 }
  }

  /// The "restored once" latch resets on a healthy start: the agent has stayed running for `healthyFor` seconds (the backoff's
  /// own ten minutes) and the bridge has not been down.
  public static func isHealthy(running: Bool, runningFor: Double, healthyFor: Double, bridgeDown: Bool) -> Bool {
    running && runningFor >= healthyFor && !bridgeDown
  }
}
