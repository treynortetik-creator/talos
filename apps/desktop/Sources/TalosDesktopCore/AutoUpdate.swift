import Foundation

/// The Mac app's own updater, the parts that decide (the live half is TalosSupervisor's `AutoUpdater`). On launch and about every hour,
/// while `desktop.json` `auto_update` is on: the signed manifest is fetched from the feed and checked against the pinned key
/// (`ReleaseManifest`); a newer release's zip is downloaded and checked (its sha256 here, then install.sh `--check-only`: codesign,
/// Gatekeeper and the Developer ID team); then it waits for quiet (`QuietWait`, `BackgroundWork`) for at most 2 hours, and hands the
/// rest to `auto-update-apply.sh`, which moves the bridge checkout to the release's commit and swaps the app through install.sh.
public enum AutoUpdate {
  /// The feed when `update_feed_url` is not set: the public repo's newest release. The trust check never looks at it.
  public static let defaultFeed = "https://github.com/treynortetik-creator/talos/releases/latest/download/"
  public static let manifestName = "latest.json"
  public static let sigName = "latest.json.sig"
  /// How often a Mac looks for a release: every hour, so a release waits at most about an hour, not six. Each look moves by up to
  /// `checkJitter` either way (random per check) so a fleet does not ask the feed in the same second.
  public static let checkEvery: Double = 3600
  public static let checkJitter: Double = 600
  /// The longest a downloaded release waits for quiet; after it, the next check tries again.
  public static let quietCap: Double = 2 * 3600
  /// A key in an attached client this recently: the owner may be typing.
  public static let keysQuiet: Double = 120
  /// Quiet must be seen this many looks in a row (a look every `quietPoll` seconds) before anything moves.
  public static let quietLooks = 2
  public static let quietPoll: Double = 30
  /// The folder under the Talos home where the updater keeps its downloads and records (0700).
  public static let folder = "auto-update"
  /// The owner's warning before Talos quits for an update; a message from the owner in it postpones the update.
  public static let noticeFor: Double = 120
  /// After a postponement (the owner wrote, or a session got busy), the earliest the next try may start.
  public static let postponeFor: Double = 30 * 60
  /// A release that failed is not tried again for this long.
  public static let retryFailedAfter: Double = 24 * 3600
  /// An update whose swap has not said how it ended by then is over: its group is stopped and the checkout put back.
  public static let applyCap: Double = 30 * 60

  /// The feed's base address from the setting (nil or empty: `defaultFeed`), ending in "/". https only; `allowLocal` (tests, never
  /// the app) also takes file:// and http on the loopback address.
  public static func feedBase(_ setting: String?, allowLocal: Bool = false) -> URL? {
    var s = (setting ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { s = defaultFeed }
    if !s.hasSuffix("/") { s += "/" }
    guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), u.query == nil, u.fragment == nil, u.user == nil else {
      return nil
    }
    if scheme == "https", let h = u.host, !h.isEmpty { return u }
    if allowLocal, scheme == "file" { return u }
    if allowLocal, scheme == "http", u.host == "127.0.0.1" { return u }
    return nil
  }

  /// A file beside the manifest on the feed (the names are checked by the manifest's own rules first).
  public static func fileURL(_ base: URL, _ name: String) -> URL? { URL(string: name, relativeTo: base)?.absoluteURL }

  // MARK: the owner's one line

  /// The relay is a separate deploy: a newer bridge works with it through the features each side lists, so the update never waits
  /// for it, and the line says so.
  public static func updatedLine(_ version: String) -> String {
    "Talos updated to \(oneLine(version)). The relay updates separately."
  }

  /// A build for the owner's eyes: a commit's first 7 characters, or the text itself (one line, at most 24 characters).
  public static func shortBuild(_ build: String) -> String {
    let b = oneLine(build).trimmingCharacters(in: .whitespaces)
    let hex = b.count >= 7 && b.allSatisfy { $0.isHexDigit && $0.isASCII }
    return hex ? String(b.prefix(7)) : String(b.prefix(24))
  }

  /// The relay is on an older build than the update. Both builds are named, and so is the step the owner takes: the relay does not
  /// follow releases by itself, and nothing waits for it. `relay`: the build the relay reports; `app`: the build the update brings.
  public static func relayBehindLine(version: String, relay: String, app: String) -> String {
    "The relay (the server your phone talks to) is on build \(shortBuild(relay)). Talos \(oneLine(version)) is build \(shortBuild(app)). "
      + "The update works with the older relay, but your phone may say Talos is newer than the app until the relay is redeployed. "
      + "To fix that, redeploy the relay in Railway (open its project, then Deployments, then Redeploy) and check again. "
      + "Talos does not wait for the relay: it installs when nothing is going on, or when you press Update now."
  }

  // The lines the update window shows for a check that could not finish. Plain words; the details are in the log.
  public static let noKeyLine = "This copy of Talos can\u{2019}t check for updates (it is a development build)."
  public static let badFeedLine = "Talos can\u{2019}t use the update address that is set. Clear it in the Talos settings file to use the default."
  public static let unreachableLine = "Talos couldn\u{2019}t reach the update server. Check your internet connection and try again."
  public static let downloadFailedLine = "The download didn\u{2019}t finish. Check your internet connection and try again."
  public static func cloneNeedsOKLine(_ clone: String) -> String {
    "Talos needs your OK before it can update: it has not used the Talos code folder \(oneLine(clone)) before. "
      + "\(AllowUpdatesCopy.whereToAnswer) Allow updates only if it is the folder you installed from."
  }
  public static let notHealthyLine = "Talos can\u{2019}t update right now because your agent isn\u{2019}t running normally. Fix that, then try again."
  public static let cannotRestartLine =
    "Talos can\u{2019}t update right now because your agent might not come back after a restart. Check the Talos window, then try again."
  public static func busyLine(_ version: String, old: String) -> String {
    "Talos couldn\u{2019}t update to \(oneLine(version)): your agent was busy for 2 hours. Still on \(oneLine(old)). Try Update now again when it is idle."
  }
  public static func pausedLine(_ version: String, old: String) -> String {
    "Talos \(oneLine(version)) didn\u{2019}t start properly on this Mac, so updates to it are paused for a week. Still on \(oneLine(old))."
  }
  public static func triedLine(_ version: String, old: String) -> String {
    "Talos couldn\u{2019}t update to \(oneLine(version)) a short while ago. It tries again within a day. Still on \(oneLine(old))."
  }

  /// The commit a relay build names: a bare sha (7 to 40 hex), or the hex of a `git describe` (`tag-N-g<hex>`, maybe `-dirty`), lowercase.
  /// Anything else (a tag, a package version) names no commit, so nothing is claimed about it.
  public static func relayHex(_ build: String) -> String? {
    let b = oneLine(build).trimmingCharacters(in: .whitespaces).lowercased()
    func hex(_ s: String) -> Bool { (7...40).contains(s.count) && s.allSatisfy { $0.isASCII && $0.isHexDigit } }
    if hex(b) { return b }
    let core = b.hasSuffix("-dirty") ? String(b.dropLast(6)) : b
    guard let r = core.range(of: "-g", options: .backwards) else { return nil }
    let tail = String(core[r.upperBound...])
    return hex(tail) ? tail : nil
  }

  public static func postponedLine(_ version: String) -> String {
    "Talos postponed the update to \(oneLine(version)); it tries again when nothing is going on."
  }

  /// The health gate put the previous app back.
  public static func unhealthyLine(_ version: String, old: String) -> String {
    "Talos \(oneLine(version)) didn't start properly, so it went back to \(oneLine(old)). The update is paused for a week."
  }

  /// The health gate could not put the previous app back: the kept copy is still there.
  public static func rollbackFailedLine(_ version: String, old: String) -> String {
    "Talos \(oneLine(version)) didn't start properly, and going back to \(oneLine(old)) failed. The previous version is kept as "
      + ".Talos.app.previous beside Talos.app in your Applications folder; the update is paused for a week."
  }

  public static func noticeLine(_ version: String) -> String {
    "Talos will update to \(oneLine(version)) in 2 minutes; send anything to postpone."
  }

  /// Said once when the running app is a translocated copy (`isTranslocated`): no update is tried until it is moved and reopened.
  public static let translocatedLine =
    "Talos is running from a temporary copy; move it to Applications and reopen it, then updates can install."

  /// macOS runs a downloaded app that still carries its download flag from a read-only temporary copy (App Translocation:
  /// `.../AppTranslocation/<id>/d/Talos.app`). An update swapped into the folder that copy came from would never be the app that runs,
  /// and start at login would point at the temporary path. Decided by the bundle's path: one folder in it named `AppTranslocation`.
  public static func isTranslocated(_ bundlePath: String) -> Bool {
    let parts = (bundlePath as NSString).standardizingPath.split(separator: "/", omittingEmptySubsequences: true)
    return parts.dropLast().contains { $0 == "AppTranslocation" }
  }

  public static func failedLine(_ version: String, why: Failure, old: String) -> String {
    "Talos couldn't update to \(oneLine(version)): \(why.words). It's still on \(oneLine(old))."
  }

  /// Why an update did not happen, in the owner's words. The raw value is what the audit log, the apply script's result file and the
  /// once-per-version record carry.
  public enum Failure: String, Sendable, CaseIterable {
    case signature, manifest, fetch, download, sha256, notarized = "app_check", tooOld = "too_old", dirty, checkout, deps, relay, commit
    case install, notQuit = "not_quit", identity, stopped, location, busy, unhealthy, rollbackFailed = "rollback_failed"
    public var words: String {
      switch self {
      case .signature: return "the release's signature did not check out"
      case .manifest: return "the release's description could not be read"
      case .fetch: return "the release could not be fetched"
      case .download: return "the download failed"
      case .sha256: return "the download is not the file the release names"
      case .notarized: return "the app in the release is not signed and notarized by its publisher"
      case .tooOld: return "this version is too old to update itself; install the new one by hand"
      case .dirty: return "the Talos code folder has changes of its own"
      case .checkout: return "the Talos code folder could not be moved to the new version"
      case .commit: return "the new version's code is not in the public repository yet"
      case .deps: return "the new version's packages could not be installed"
      case .relay: return "the relay is not on the new version yet"
      case .install: return "the new app could not be put in place"
      case .notQuit: return "Talos did not quit for the update"
      case .identity: return "the new app is signed by another identity"
      case .stopped: return "the update stopped before it finished"
      case .location: return "Talos is not installed in your own Applications folder"
      case .busy: return "it waited 2 hours and Talos was never idle"
      case .unhealthy: return "the new version didn't start properly"
      case .rollbackFailed: return "the new version didn't start properly, and going back failed"
      }
    }
  }

  /// install.sh's exit codes as a failure (its header lists them).
  public static func installFailure(exit code: Int32) -> Failure {
    switch code {
    case 2: return .location
    case 3, 6: return .notQuit
    case 8: return .relay
    case 9: return .notarized
    case 10: return .identity
    default: return .install
    }
  }

  /// A value on one line: each run of CR, LF, U+2028 and U+2029 is one space.
  static func oneLine(_ s: String) -> String { UpdateRestartLine.oneLine(s) }

  // MARK: the records

  /// Written before the apply script starts (0600): what the update moves from and to. A launch that finds it settles it: the app's
  /// own version says whether the new one is running.
  public struct Pending: Codable, Equatable, Sendable {
    public var v: Int = 1
    public var version: String
    public var old_version: String
    public var checkout: String
    /// What the checkout was on: a branch name, or a commit.
    public var old_ref: String
    public var old_head: String
    public var helper_pid: Int32
    /// The swap process's own start time (seconds since 1970, the kernel's), so a pid used again by another process is never it.
    public var helper_started: Double?
    /// The release's commit (the public one), which the new app's bridge must run before it counts as healthy.
    public var commit: String?
    public var started_at: String
    public init(
      version: String, old_version: String, checkout: String, old_ref: String, old_head: String, helper_pid: Int32, started_at: String,
      helper_started: Double? = nil
    ) {
      self.helper_started = helper_started
      self.version = version
      self.old_version = old_version
      self.checkout = checkout
      self.old_ref = old_ref
      self.old_head = old_head
      self.helper_pid = helper_pid
      self.started_at = started_at
    }
  }

  /// Written by the apply script at its end (`auto-update-apply.sh`): its own outcome.
  public struct Result: Codable, Equatable, Sendable {
    public var v: Int = 1
    public var ok: Bool
    /// A `Failure` raw value when not ok.
    public var why: String?
    public var restored: Bool?
    public init(ok: Bool, why: String? = nil, restored: Bool? = nil) {
      self.ok = ok
      self.why = why
      self.restored = restored
    }
  }

  public enum Settled: Equatable, Sendable {
    /// The apply script is still at work: look again later.
    case waiting
    case updated
    /// `restoreCheckout`: the script did not say it put the checkout back (it was stopped outright), so the app does.
    case failed(Failure, restoreCheckout: Bool)
  }

  /// Whether the swap process of a pending update is still at work: its pid alive with the start time recorded for it, and the update
  /// younger than `applyCap`. `processStart`: the kernel's start time of a pid (nil: gone).
  public static func helperAlive(_ p: Pending, now: Double, processStart: (Int32) -> Double?) -> Bool {
    guard p.helper_pid > 1, let want = p.helper_started, let got = processStart(p.helper_pid), abs(got - want) < 0.001 else { return false }
    guard let started = ISOTime.parse(p.started_at) else { return false }
    return now - started < applyCap
  }

  /// A failed release is not tried again within `retryFailedAfter` of its failure. `record`: version to when it failed (seconds).
  public static func recentlyFailed(_ record: [String: Double], version: String, now: Double) -> Bool {
    guard let at = record[version] else { return false }
    return now - at < retryFailedAfter && now >= at
  }

  /// What a pending update came to. The running version decides success; the script's result only says why it did not.
  /// The swap's result decides, once there is one: ok only after the new app reported healthy (the health gate), so the new app
  /// never calls itself updated before that. `healthy`: this app's own health report for the pending version is written.
  public static func settle(pending: Pending, result: Result?, running: String?, helperAlive: Bool, healthy: Bool = false) -> Settled {
    let isNew = running.map { ReleaseManifest.compare($0, pending.version) == 0 } ?? false
    if let result {
      // ok, yet this app is not the new version: the swap said done and something else is running; the checkout matches the app on disk
      if result.ok { return isNew ? .updated : .failed(.install, restoreCheckout: false) }
      let why = result.why.flatMap(Failure.init(rawValue:)) ?? .stopped
      // restored nil: the checkout never moved; false: the script could not put it back, so the app tries once more. Never after a
      // failed rollback: the checkout then belongs with the app that is still installed.
      return .failed(why, restoreCheckout: result.restored == false && why != .rollbackFailed)
    }
    if helperAlive { return .waiting }
    // the new version running with its swap gone and no result (the swap was killed): it counts once it reports healthy itself
    if isNew { return healthy ? .updated : .waiting }
    return .failed(.stopped, restoreCheckout: true)
  }

  /// The new app's own report that it came up healthy, named for its version (the swap waits for it; no other version's counts).
  public static func healthFileName(_ version: String) -> String { "healthy-\(version).json" }

  /// Healthy now: the supervisor has Main running (started, past its start-up questions), and the live bridge's fresh status.json
  /// says it is connected to the relay (it had the relay's `ready`). `bridge` is nil when unreadable. The old app must be this right
  /// before a swap: one that is not could not tell a bad release from its own trouble.
  public static func healthy(mainRunning: Bool, bridge: BridgeStatus?, now: Date, pidAlive: (Int32) -> Bool) -> Bool {
    guard mainRunning, let b = bridge else { return false }
    return b.health(now: now, pidAlive: pidAlive) == .healthy
  }

  /// Healthy after an update, as the NEW app judges itself: healthy now, AND the live bridge runs the release's code (its
  /// `bridge_commit` is the release's commit), started after the swap began (a Main left running across the swap, as tmux keeps it,
  /// is not it), under this app's own Main (`bridgeUnderMain`: its process is the supervisor's child or below it).
  public static func healthyAfterUpdate(
    mainRunning: Bool, bridge: BridgeStatus?, now: Date, pidAlive: (Int32) -> Bool, commit: String, since: Date, bridgeUnderMain: Bool
  ) -> Bool {
    guard healthy(mainRunning: mainRunning, bridge: bridge, now: now, pidAlive: pidAlive), let b = bridge, bridgeUnderMain else { return false }
    guard let c = b.bridgeCommit, c.count >= 7, commit.lowercased().hasPrefix(c.lowercased()) else { return false }
    guard let started = b.startedAt, started > since else { return false }
    return true
  }

  /// The bridge's commit is not the release's yet: Main still runs older code and must restart onto it.
  public static func bridgeOnOlderCode(_ bridge: BridgeStatus?, commit: String) -> Bool {
    guard let c = bridge?.bridgeCommit, c.count >= 7 else { return true }
    return !commit.lowercased().hasPrefix(c.lowercased())
  }

  /// What asking the supervisor to restart Main onto the checkout's code came to.
  public enum MainRestart: Equatable, Sendable { case started, notNeeded, notYet, refused }

  /// The health gate put the app back while Main may still run the release's bridge: the line says so when Main could not be
  /// restarted onto the previous code.
  public static func restartByHandLine(_ line: String) -> String { line + " Restart Talos from the menu to finish going back." }

  /// A version the health gate rolled back is skipped this long, then tried once more.
  public static let skipFor: Double = 7 * 24 * 3600

  public static func skipped(_ record: [String: Double], version: String, now: Double) -> Bool {
    guard let at = record[version] else { return false }
    return now >= at && now - at < skipFor
  }
}

/// Waiting for quiet: `quietLooks` quiet looks in a row start the update; past `cap` since the wait began (the release was ready, or
/// the first look) it gives up until the next check. On the awake clock, so a sleep does not use the wait up.
public struct QuietWait: Equatable, Sendable {
  public var since: Double?
  public var streak = 0
  /// How many looks so far.
  public var looked = 0
  public init(since: Double? = nil) { self.since = since }

  public enum Step: Equatable, Sendable { case go, wait, gaveUp }

  public mutating func look(quiet: Bool, now: Double, cap: Double = AutoUpdate.quietCap, looks: Int = AutoUpdate.quietLooks) -> Step {
    let start = since ?? now
    since = start
    looked += 1
    streak = quiet ? streak + 1 : 0
    if streak >= looks { return .go }
    return now - start >= cap ? .gaveUp : .wait
  }
}

/// Live background work under a session's pane: anything there other than claude and what claude runs for itself (its MCP servers,
/// its own helpers). A shell that claude started is the Bash tool, a command still running (in the background or not), and so is
/// everything under it; anything under the pane that is not claude's is too.
public enum BackgroundWork {
  public struct Proc: Equatable, Sendable {
    public var pid: Int32
    public var ppid: Int32
    /// The executable's own name (the kernel's `p_comm`, at most 16 bytes).
    public var name: String
    /// Read only for the names that can be claude (`wantsArgv`); nil otherwise.
    public var argv: [String]?
    public init(pid: Int32, ppid: Int32, name: String, argv: [String]? = nil) {
      self.pid = pid
      self.ppid = ppid
      self.name = name
      self.argv = argv
    }
  }

  static let shells: Set<String> = ["sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh", "nu", "elvish"]
  /// Names whose argv is read to see whether they are claude.
  public static let runtimes: Set<String> = ["node", "bun"]

  static func base(_ s: String) -> String {
    let b = (s as NSString).lastPathComponent
    return b.hasPrefix("-") ? String(b.dropFirst()) : b
  }

  /// A name made of numbers and dots ("2.1.325"). Claude Code's native install runs a file named for its version
  /// (`~/.local/share/claude/versions/2.1.325`, reached through the `~/.local/bin/claude` link), so that is the name the kernel
  /// gives the process, not "claude". Measured on a real session on 2026-11-15.
  static func isVersionName(_ s: String) -> Bool {
    let parts = s.split(separator: ".", omittingEmptySubsequences: false)
    return parts.count >= 2 && parts.allSatisfy { !$0.isEmpty && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }
  }

  /// Whether the process table reads this process's argv: a runtime that may be running claude, or a native install's version name.
  public static func wantsArgv(_ name: String) -> Bool { runtimes.contains(base(name)) || isVersionName(base(name)) }

  public static func isClaude(_ p: Proc) -> Bool {
    if base(p.name) == "claude" { return true }
    if isVersionName(base(p.name)) {
      // the native install: its argv[0] is the path it was started by (the `claude` link), or the versions file itself
      guard let first = p.argv?.first else { return false }
      return base(first) == "claude" || first.contains("/claude/versions/")
    }
    guard runtimes.contains(base(p.name)), let argv = p.argv else { return false }
    return argv.dropFirst().prefix(3).contains { $0.hasSuffix("/claude") || $0.hasSuffix("claude-code/cli.js") }
  }

  public static func isShell(_ p: Proc) -> Bool { shells.contains(base(p.name)) }

  /// The processes that are live work, under each pane root (the pane's own process). Each offender is named once, at the top of its
  /// own subtree. A root that is gone gives nothing.
  public static func offenders(_ table: [Proc], panes: [Int32]) -> [Proc] {
    var kids: [Int32: [Proc]] = [:]
    for p in table where p.pid != p.ppid { kids[p.ppid, default: []].append(p) }
    for k in kids.keys { kids[k]?.sort { $0.pid < $1.pid } }
    let byPid = Dictionary(table.map { ($0.pid, $0) }, uniquingKeysWith: { a, _ in a })
    var out: [Proc] = []
    func underClaude(_ c: Proc) {
      for k in kids[c.pid] ?? [] where isShell(k) || isClaude(k) { out.append(k) }
    }
    func underPane(_ p: Proc) {
      for k in kids[p.pid] ?? [] {
        if isClaude(k) { underClaude(k) } else if isShell(k) { underPane(k) } else { out.append(k) }
      }
    }
    for root in Set(panes).sorted() {
      guard root > 1, let r = byPid[root] else { continue }
      if isClaude(r) { underClaude(r) } else { underPane(r) }
    }
    return out
  }
}
