import CryptoKit
import Darwin
import Foundation
import TalosDesktopCore

/// The Mac app's own updater (the decisions are `AutoUpdate` and `ReleaseManifest` in the core). A look every `quietPoll` seconds on
/// its own queue:
///   1. A pending update from before (`pending.json`) is settled first: the running version says whether it took; the line is posted.
///   2. With `desktop.json` `auto_update` off nothing is fetched, and a release waiting for its moment is dropped.
///   3. On launch (after `firstCheckAfter`) and every `checkEvery`, unless this app runs from a translocated copy (then one line, once,
///      says to move it to Applications and reopen it, and nothing is fetched): latest.json and its signature from the feed (size caps, timeouts),
///      checked against the key pinned in this build; a newer release's zip downloaded and checked (its size and sha256 here, then
///      install.sh --check-only: codesign, Gatekeeper, the Developer ID team), the bridge checkout checked clean and the release's
///      public commit fetched into it (nothing moves yet). All the slow work happens here, while the sessions may be busy. A refusal
///      is said once per version and reason, and a failed release is not tried again for a day; a fetch that fails is only logged.
///   4. It waits for quiet (`look`: every session quiet, no background work), `quietLooks` looks in a row, for at most `quietCap`.
///   5. The 2-minute notice in the default thread. A message from the owner in it (`ownerActivity` changes) or a look that is not
///      quiet postpones the update by `postponeFor`; then it waits for quiet again.
///   6. `auto-update-apply.sh --prepare` (a copy) moves the checkout to the release's commit and installs its packages; the app waits.
///   7. Quiet again, `quietLooks` looks in a row, and no owner message. Anything else puts the checkout back (`--restore`) and
///      postpones. Then `--swap` runs in a session of its own: install.sh --from-release quits this app, swaps it and opens the new
///      one; the swap writes its result before Talos opens again.
/// Every step's outcome is one audit row (`auto_update <event> ...`). Nothing before the swap changes the app; nothing before step 6
/// changes the checkout, and any way out of steps 6 and 7 but the swap puts it back.
public final class AutoUpdater: @unchecked Sendable {
  public struct Options: Sendable {
    public var talosHome: String
    /// The running bundle; the swap installs into its folder.
    public var appPath: String
    /// The running version (`CFBundleShortVersionString`); nil installs nothing.
    public var appVersion: String?
    /// The release keys pinned in this build (`ReleaseTrust.keys`); empty installs nothing.
    public var keys: [ReleaseKey]
    /// Tests only: a file:// or loopback http feed.
    public var allowLocalFeed = false
    public var firstCheckAfter: Double = 60
    public var checkEvery: Double = AutoUpdate.checkEvery
    public var quietPoll: Double = AutoUpdate.quietPoll
    public var quietCap: Double = AutoUpdate.quietCap
    public var noticeFor: Double = AutoUpdate.noticeFor
    public var postponeFor: Double = AutoUpdate.postponeFor
    public var fetchTimeout: Double = 30
    public var downloadTimeout: Double = 900
    /// install.sh --check-only (Gatekeeper may ask Apple online).
    public var checkTimeout: Double = 300
    public var gitTimeout: Double = 120
    /// The prepare step: the checkout move and `pnpm install`.
    public var prepareTimeout: Double = 1200
    /// The health gate: how long the swap waits for the new app's own healthy report before it puts the previous app back.
    public var healthWait: Double = 300
    /// The apply script to copy and run; nil: the checkout's own.
    public var applyScript: String?
    public var auditLogPath: String?
    public init(talosHome: String, appPath: String, appVersion: String?, keys: [ReleaseKey]) {
      self.talosHome = talosHome
      self.appPath = appPath
      self.appVersion = appVersion
      self.keys = keys
    }
  }

  public struct Hooks: Sendable {
    /// `auto_update` and `update_feed_url` as desktop.json says now (off whenever it cannot be read).
    public var settings: @Sendable () -> (on: Bool, feed: String?)
    /// The bridge checkout (the owner's clone of the public repo); nil when none can be used.
    public var checkout: @Sendable () -> String?
    /// Why the Mac is not quiet now (empty: quiet): sessions and background work.
    public var look: @Sendable () -> [String]
    /// One line into the default thread.
    public var post: @Sendable (String) -> Void
    /// The environment the scripts run with (the login shell's PATH).
    public var env: @Sendable () -> [String: String]
    /// Changes whenever the owner sends a message (the bridge's status.json `last_owner_at`); nil when it cannot be read.
    public var ownerActivity: @Sendable () -> String? = { nil }
    /// This app is healthy now (`AutoUpdate.healthy`: Main running, the bridge live on the relay). Only the version a pending update
    /// is for ever reports it.
    public var healthy: @Sendable () -> Bool = { false }
    /// This app is healthy after an update to `commit` that began at `since` (wall seconds): `AutoUpdate.healthyAfterUpdate`, the
    /// bridge running the release's code, started after the swap, under this app's Main.
    public var healthyAfterUpdate: @Sendable (_ commit: String, _ since: Double) -> Bool = { _, _ in false }
    /// Main still runs older bridge code than `commit`: restart it onto the release (the supervisor's own restart, once per commit,
    /// when nobody is typing and the restart check says it comes back).
    public var restartMainForUpdate: @Sendable (_ commit: String) -> Void = { _ in }
    /// After a rollback: whether the live bridge still runs other code than `commit` (the checkout's HEAD now).
    public var bridgeNotOn: @Sendable (_ commit: String) -> Bool = { _ in false }
    /// Main cold-restarted onto the checkout's `commit` (`Supervisor.restartMain(onto:)`).
    public var restartMainOnto: @Sendable (_ commit: String) -> AutoUpdate.MainRestart = { _ in .notNeeded }
    /// Before a swap: Main can be restarted onto the release afterwards (`Supervisor.mainCanRestartForUpdate`).
    public var mainCanRestart: @Sendable () -> Bool = { true }
    public var run: @Sendable (_ argv: [String], _ env: [String: String], _ timeout: Double) -> RunResult = { a, e, t in
      ProcessRunner.run(a, env: e, timeout: t)
    }
    /// Starts the swap in a session of its own (it outlives this app); its pid, or nil.
    public var spawn: @Sendable (_ argv: [String], _ env: [String: String], _ log: String) -> Int32? = AutoUpdater.spawnDetached
    /// The body of `url` if it is at most `max` bytes; nil on any failure.
    public var fetch: @Sendable (_ url: URL, _ max: Int, _ timeout: Double) -> Data? = CappedFetch.data
    /// `url` saved to `path`, at most `max` bytes; false on any failure.
    public var download: @Sendable (_ url: URL, _ path: String, _ max: Int, _ timeout: Double) -> Bool = CappedFetch.file
    public var awake: @Sendable () -> Double = { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1e9 }
    public var wall: @Sendable () -> Double = { Date().timeIntervalSince1970 }
    /// The kernel's start time of a process (nil: gone): the swap is known by its pid AND this.
    public var processStart: @Sendable (Int32) -> Double? = { ProcessInspect.basic($0)?.startTime }
    /// Stops the swap's process group (its own session) once it is over its time.
    public var stopGroup: @Sendable (Int32) -> Void = { _ = killpg($0, SIGTERM) }
    public init(
      settings: @escaping @Sendable () -> (on: Bool, feed: String?), checkout: @escaping @Sendable () -> String?,
      look: @escaping @Sendable () -> [String], post: @escaping @Sendable (String) -> Void,
      env: @escaping @Sendable () -> [String: String]
    ) {
      self.settings = settings
      self.checkout = checkout
      self.look = look
      self.post = post
      self.env = env
    }
  }

  struct Ready: Equatable {
    var manifest: ReleaseManifest
    var zip: String
    var checkout: String
    var dest: String
    var checkedAt: Double
    /// When it became ready: the 2-hour cap counts from here, postponements included.
    var readyAt: Double
  }

  enum Phase: Equatable {
    case idle(next: Double)
    /// Waiting for quiet; nothing is tried before `notBefore` (after a postponement).
    case waiting(Ready, QuietWait, notBefore: Double)
    /// The 2-minute notice is out; `owner` is the owner's activity when it went out.
    case notice(Ready, until: Double, owner: String?)
    /// The checkout is on the release's commit; quiet once more, then the swap. `ref`: where the checkout was.
    case final(Ready, QuietWait, owner: String?, ref: String)
    case applying(pid: Int32)
  }

  public let options: Options
  let hooks: Hooks
  let queue = DispatchQueue(label: "talos.auto-update")
  var phase: Phase
  private var timer: DispatchSourceTimer?
  private var saidOff = false
  private var saidNoKey = false
  /// When the swap of this process's own pending update was asked to stop (over `applyCap`).
  private var stopAskedAt: Double?
  /// Since when (awake) a rollback has waited for Main to be restartable onto the previous code.
  private var goingBackSince: Double?

  public init(options: Options, hooks: Hooks) {
    self.options = options
    self.hooks = hooks
    self.phase = .idle(next: hooks.awake() + options.firstCheckAfter)
  }

  var dir: String { options.talosHome + "/" + AutoUpdate.folder }
  var pendingPath: String { dir + "/pending.json" }
  var resultPath: String { dir + "/result.json" }
  var preparePath: String { dir + "/prepare.json" }
  var saidPath: String { dir + "/said.json" }
  var failedPath: String { dir + "/failed.json" }
  var scriptPath: String { dir + "/auto-update-apply.sh" }
  var skippedPath: String { dir + "/skipped.json" }
  var keysPath: String { dir + "/keys.json" }

  /// The keys trusted now: the pinned ones, plus what verified rotations added, minus every kid retired. Only a build that pins at
  /// least one key gets here.
  func keyring() -> ReleaseKeyring {
    var stored = ReleaseKeyring(keys: [], retired: [])
    if let d = FileManager.default.contents(atPath: keysPath), d.count < 65_536,
      let r = try? JSONDecoder().decode(ReleaseKeyring.self, from: d)
    {
      stored = r
    }
    var all = options.keys
    for k in stored.keys where !all.contains(where: { $0.kid == k.kid }) && ReleaseKey.kid(of: k.publicKey) == k.kid { all.append(k) }
    let retired = Set(stored.retired)
    return ReleaseKeyring(keys: all.filter { !retired.contains($0.kid) }, retired: retired.sorted())
  }

  private func saveKeyring(_ k: ReleaseKeyring) {
    guard !k.keys.isEmpty, let d = try? JSONEncoder().encode(k) else { return }
    do {
      try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try AtomicFile.write(d, to: keysPath, mode: 0o600)
      audit("keys_updated", ["keys": k.keys.map(\.kid).joined(separator: ","), "retired": k.retired.joined(separator: ",")])
    } catch {
      audit("keys_not_written")
    }
  }
  func healthPath(_ version: String) -> String { dir + "/" + AutoUpdate.healthFileName(version) }

  public func start() {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + 5, repeating: options.quietPoll)
    t.setEventHandler { [weak self] in self?.tickLocked() }
    timer = t
    t.resume()
  }

  public func stop() {
    queue.sync {
      timer?.cancel()
      timer = nil
    }
  }

  /// One look, now (tests, and the timer).
  public func tick() { queue.sync { tickLocked() } }

  func audit(_ event: String, _ fields: [String: String] = [:]) {
    guard let path = options.auditLogPath else { return }
    let kv = fields.keys.sorted().map { "\($0)=\(WorkerNotice.logValue(fields[$0] ?? ""))" }.joined(separator: " ")
    let line = "\(ISO8601DateFormatter().string(from: Date())) auto_update \(event)\(kv.isEmpty ? "" : " " + kv)\n"
    AuditLog.append(line, to: path)
  }

  /// This process moved the checkout (or is about to) and has not handed it to the swap yet: its pending record is its own.
  private var ownsPending: Bool {
    switch phase {
    case .final: return true
    default: return false
    }
  }

  private func tickLocked() {
    reportHealthIfDue()
    if !ownsPending { guard settlePending() else { return } }
    let s = hooks.settings()
    guard s.on else {
      if !saidOff { audit("off") }
      saidOff = true
      switch phase {
      case .waiting(let r, _, _), .notice(let r, _, _):
        audit("dropped", ["version": r.manifest.version, "why": "switched off"])
        dropDownload(r)
      case .final(let r, _, _, let ref):
        audit("dropped", ["version": r.manifest.version, "why": "switched off"])
        restore(r, ref: ref)
        dropDownload(r)
      case .applying: return
      case .idle: break
      }
      phase = .idle(next: hooks.awake())  // switched on again: a check at once
      return
    }
    saidOff = false
    let now = hooks.awake()
    switch phase {
    case .idle(let next):
      if now >= next { check(feed: s.feed) }
    case .waiting(let ready, var wait, let notBefore):
      guard now >= notBefore else { return }
      let why = hooks.look()
      let first = wait.looked == 0
      switch wait.look(quiet: why.isEmpty, now: now, cap: options.quietCap) {
      case .go:
        // the notice, and the owner's activity as it is now: any change in the next 2 minutes postpones
        let owner = hooks.ownerActivity()
        hooks.post(AutoUpdate.noticeLine(ready.manifest.version))
        audit("notice", ["version": ready.manifest.version])
        phase = .notice(ready, until: now + options.noticeFor, owner: owner)
      case .wait:
        if first, !why.isEmpty { audit("waiting", ["version": ready.manifest.version, "why": why.joined(separator: "; ")]) }
        phase = .waiting(ready, wait, notBefore: notBefore)
      case .gaveUp:
        audit("gave_up_waiting", ["version": ready.manifest.version, "why": why.joined(separator: "; ")])
        dropDownload(ready)
        phase = .idle(next: ready.checkedAt + options.checkEvery)
      }
    case .notice(let ready, let until, let owner):
      if let why = interrupted(owner: owner) { return postpone(ready, why: why) }
      if now >= until { prepare(ready, owner: owner) }
    case .final(let ready, var wait, let owner, let ref):
      if let why = interrupted(owner: owner) {
        restore(ready, ref: ref)
        return postpone(ready, why: why)
      }
      // the same rule as before the notice: `quietLooks` quiet looks in a row (`interrupted` has just made this one)
      if case .go = wait.look(quiet: true, now: now, cap: .infinity) {
        // this app must pass the health check itself right before the swap: one that does not (Main stopped, the relay or the
        // network down) could not tell a bad release from its own trouble. Postponed, nothing said; the next window tries again.
        guard hooks.healthy() else {
          restore(ready, ref: ref)
          return postpone(ready, why: "this app is not healthy itself", say: false)
        }
        // and Main must be able to restart onto the release afterwards, or every good release would fail its health gate
        guard hooks.mainCanRestart() else {
          restore(ready, ref: ref)
          return postpone(ready, why: "Main would not come back from a restart", say: false)
        }
        swap(ready, ref: ref)
      } else {
        phase = .final(ready, wait, owner: owner, ref: ref)
      }
    case .applying:
      break  // settled by `settlePending` once the swap has ended
    }
  }

  /// The health gate's signal, from the NEW app only: a pending update for this very version, and this app healthy. Written once,
  /// whole; the swap (in its own session) waits for it, and puts the previous app back without it.
  private func reportHealthIfDue() {
    guard let v = options.appVersion, let p = readPending(), ReleaseManifest.compare(p.version, v) == 0 else { return }
    let path = healthPath(v)
    guard !FileManager.default.fileExists(atPath: path), let commit = p.commit, let since = ISOTime.parse(p.started_at) else { return }
    // Main left running across the swap (tmux keeps it) still runs the old bridge: it restarts onto the release first
    hooks.restartMainForUpdate(commit)
    guard hooks.healthyAfterUpdate(commit, since) else { return }
    let o: [String: Any] = ["v": 1, "version": v, "pid": Int(getpid()), "at": ISOTime.string(hooks.wall())]
    guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
    do {
      try AtomicFile.write(d, to: path, mode: 0o600)
      audit("healthy", ["version": v])
    } catch {
      audit("healthy_not_written", ["version": v])
    }
  }

  /// Versions the health gate rolled back, to when (wall seconds): skipped for `AutoUpdate.skipFor`, then tried once more.
  private func skippedVersions() -> [String: Double] {
    guard let d = FileManager.default.contents(atPath: skippedPath), d.count < 16_384,
      let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    else { return [:] }
    return o.compactMapValues { ($0 as? NSNumber)?.doubleValue }
  }

  private func skip(_ version: String) {
    var s = skippedVersions()
    s[version] = hooks.wall()
    if s.count > 20 { s = [version: s[version]!] }
    if let d = try? JSONSerialization.data(withJSONObject: s, options: [.sortedKeys]) {
      try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try? AtomicFile.write(d, to: skippedPath, mode: 0o600)
    }
  }

  /// Why the update must not go on now: the owner wrote since the notice, or a look is not quiet. nil: go on.
  private func interrupted(owner: String?) -> String? {
    let nowOwner = hooks.ownerActivity()
    if nowOwner != owner, nowOwner != nil { return "the owner wrote" }
    let why = hooks.look()
    return why.isEmpty ? nil : why.joined(separator: "; ")
  }

  private func postpone(_ ready: Ready, why: String, say: Bool = true) {
    audit("postponed", ["version": ready.manifest.version, "why": why])
    if say { hooks.post(AutoUpdate.postponedLine(ready.manifest.version)) }
    phase = .waiting(ready, QuietWait(since: ready.readyAt), notBefore: hooks.awake() + options.postponeFor)
  }

  private func dropDownload(_ r: Ready) {
    try? FileManager.default.removeItem(atPath: (r.zip as NSString).deletingLastPathComponent)
  }

  // MARK: the check

  private func check(feed: String?) {
    let now = hooks.awake()
    phase = .idle(next: now + options.checkEvery)
    guard !options.keys.isEmpty else {
      if !saidNoKey { audit("no_release_key") }
      saidNoKey = true
      return
    }
    guard let running = options.appVersion else { return audit("no_running_version") }
    // a translocated copy (the download flag was left on): nothing is fetched or swapped, and the owner is told once how to fix it
    if AutoUpdate.isTranslocated(options.appPath) {
      audit("translocated")
      return sayOnce("translocated", AutoUpdate.translocatedLine)
    }
    guard let base = AutoUpdate.feedBase(feed, allowLocal: options.allowLocalFeed),
      let mURL = AutoUpdate.fileURL(base, AutoUpdate.manifestName), let sURL = AutoUpdate.fileURL(base, AutoUpdate.sigName)
    else { return audit("bad_feed") }
    audit("check")
    guard let bytes = hooks.fetch(mURL, ReleaseManifest.maxBytes, options.fetchTimeout),
      let sig = hooks.fetch(sURL, ReleaseManifest.maxSigBytes, options.fetchTimeout)
    else { return audit("fetch_failed") }
    let m: ReleaseManifest
    let ring = keyring()
    switch ReleaseManifest.verify(bytes, sig: sig, trust: ring) {
    case .failure(let r):
      audit("refused", ["why": "\(r)"])
      let what: AutoUpdate.Failure =
        [.badSignature, .badSignatureEncoding, .nonCanonicalSignature, .unknownKid, .retiredKid].contains(r) ? .signature : .manifest
      return sayOnce("unsigned:" + SpecHash.hex(bytes), AutoUpdate.failedLine("a new version", why: what, old: running))
    case .success(let v): m = v
    }
    // a rotation, signed by a key trusted now: kept (never empty), and a retired kid is refused from then on
    if let u = m.keys {
      switch ring.applying(u) {
      case .success(let next):
        if next != ring { saveKeyring(next) }
      case .failure(let why):
        audit("keys_update_refused", ["why": why.rawValue, "version": m.version])
      }
    }
    let d = m.decision(running: running)
    audit("manifest", ["version": m.version, "decision": d.rawValue])
    switch d {
    case .install: break
    case .tooOld: return refuse(m, .tooOld)
    case .upToDate, .downgrade, .unknownRunning: return
    }
    if AutoUpdate.skipped(skippedVersions(), version: m.version, now: hooks.wall()) {
      return audit("skipped_version", ["version": m.version])
    }
    if AutoUpdate.recentlyFailed(failedRecord(), version: m.version, now: hooks.wall()) {
      return audit("recently_failed", ["version": m.version])
    }
    // where the swap would go: install.sh refuses system folders, so a copy there is said now, not after a wait
    let dest = (options.appPath as NSString).deletingLastPathComponent
    let canon = PathUtil.canonical(dest)
    if ["/Applications", "/System", "/Library", "/usr"].contains(where: { canon == $0 || canon.hasPrefix($0 + "/") }) {
      return refuse(m, .location)
    }
    guard let co = hooks.checkout() else { return refuse(m, .checkout) }
    guard let clean = checkoutClean(co) else { return refuse(m, .checkout) }
    guard clean else { return refuse(m, .dirty) }
    // the release's public commit, fetched now (nothing moves): the swap later needs no network for the code
    guard fetchCommit(co, m.gitSha) else { return refuse(m, .commit) }
    // the zip, into a folder of the updater's own, from the same feed as the manifest
    let folder = dir + "/" + m.version
    try? FileManager.default.removeItem(atPath: folder)
    do {
      try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      chmod(dir, 0o700)
    } catch {
      return audit("no_folder")
    }
    let zip = folder + "/" + m.zipName
    guard let zURL = AutoUpdate.fileURL(base, m.zipName), hooks.download(zURL, zip, m.size, options.downloadTimeout) else {
      try? FileManager.default.removeItem(atPath: folder)
      audit("download_failed", ["version": m.version])
      return
    }
    guard Self.fileSize(zip) == m.size, Self.sha256(zip) == m.zipSha256 else {
      try? FileManager.default.removeItem(atPath: folder)
      return refuse(m, .sha256)
    }
    let install = co + "/apps/desktop/scripts/install.sh"
    let r = hooks.run(
      ["/bin/bash", install, "--from-release", zip, "--sha256", m.zipSha256, "--team", m.teamId, "--check-only"], scriptEnv(),
      options.checkTimeout)
    guard r.ok else {
      try? FileManager.default.removeItem(atPath: folder)
      audit("app_check_failed", ["exit": "\(r.status)", "timed_out": r.timedOut ? "1" : "0"])
      return refuse(m, r.status == 9 ? .notarized : AutoUpdate.installFailure(exit: r.status))
    }
    audit("ready", ["version": m.version])
    // the 2 hours count from here, the moment it could have gone
    let at = hooks.awake()
    let ready = Ready(manifest: m, zip: zip, checkout: co, dest: dest, checkedAt: now, readyAt: at)
    phase = .waiting(ready, QuietWait(since: at), notBefore: at)
  }

  /// A failed release: said once per version and reason, and not tried again for a day.
  private func refuse(_ m: ReleaseManifest, _ why: AutoUpdate.Failure) {
    audit("refused", ["version": m.version, "why": why.rawValue])
    noteFailed(m.version)
    sayOnce(m.version + "|" + why.rawValue, AutoUpdate.failedLine(m.version, why: why, old: options.appVersion ?? "this version"))
  }

  /// A line said once per key (a check runs every 6 hours); the log has every one.
  private func sayOnce(_ key: String, _ line: String) {
    var said = (FileManager.default.contents(atPath: saidPath).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    if said[key] != nil { return }
    said[key] = ISOTime.string(hooks.wall())
    if said.count > 50 { said = [key: said[key]!] }
    if let d = try? JSONSerialization.data(withJSONObject: said, options: [.sortedKeys]) {
      try? AtomicFile.write(d, to: saidPath, mode: 0o600)
    }
    hooks.post(line)
  }

  /// Version to when it last failed (wall seconds).
  private func failedRecord() -> [String: Double] {
    guard let d = FileManager.default.contents(atPath: failedPath), d.count < 16_384,
      let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    else { return [:] }
    return o.compactMapValues { ($0 as? NSNumber)?.doubleValue }
  }

  private func noteFailed(_ version: String) {
    var r = failedRecord()
    r[version] = hooks.wall()
    if r.count > 20 { r = [version: r[version]!] }
    if let d = try? JSONSerialization.data(withJSONObject: r, options: [.sortedKeys]) {
      try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try? AtomicFile.write(d, to: failedPath, mode: 0o600)
    }
  }

  /// nil: not a git checkout that git can read.
  private func checkoutClean(_ co: String) -> Bool? {
    let r = hooks.run(["/usr/bin/env", "git", "-C", co, "status", "--porcelain"], scriptEnv(), options.gitTimeout)
    guard r.ok else { return nil }
    return r.stdout.isEmpty
  }

  /// The commit in the checkout's object store, fetched from its origin (the public repo) if it is not there yet.
  private func fetchCommit(_ co: String, _ sha: String) -> Bool {
    let has = { self.hooks.run(["/usr/bin/env", "git", "-C", co, "cat-file", "-e", sha + "^{commit}"], self.scriptEnv(), 30).ok }
    if has() { return true }
    _ = hooks.run(["/usr/bin/env", "git", "-C", co, "fetch", "--quiet", "origin", sha], scriptEnv(), options.gitTimeout)
    if has() { return true }
    _ = hooks.run(["/usr/bin/env", "git", "-C", co, "fetch", "--quiet", "--tags", "origin"], scriptEnv(), options.gitTimeout)
    return has()
  }

  private func git(_ co: String, _ args: [String]) -> String? {
    let r = hooks.run(["/usr/bin/env", "git", "-C", co] + args, scriptEnv(), options.gitTimeout)
    guard r.ok else { return nil }
    let s = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    return s.isEmpty ? nil : s
  }

  /// The login environment without any session's identity (as install.sh scrubs its relaunch), and with git never prompting.
  private func scriptEnv() -> [String: String] {
    var e = hooks.env()
    for k in e.keys where k.hasPrefix("TALOS_APP_WORKER") || k.hasPrefix("CLAUDE_CODE_") || k == "CLAUDECODE" || k == "TALOS_SESSION_ROLE" {
      e[k] = nil
    }
    e["GIT_TERMINAL_PROMPT"] = "0"
    return e
  }

  // MARK: the prepare, the last look and the swap

  /// After the notice: the checkout moves to the release's commit and its packages install (the app waits), then the last look.
  private func prepare(_ r: Ready, owner: String?) {
    let m = r.manifest
    phase = .idle(next: r.checkedAt + options.checkEvery)
    guard let clean = checkoutClean(r.checkout) else { return refuseApply(m, .checkout) }
    guard clean else { return refuseApply(m, .dirty) }
    guard let head = git(r.checkout, ["rev-parse", "HEAD"]) else { return refuseApply(m, .checkout) }
    let ref = git(r.checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? head
    // a copy of the script: the checkout it moves may hold the original
    let source = options.applyScript ?? (r.checkout + "/apps/desktop/scripts/auto-update-apply.sh")
    try? FileManager.default.removeItem(atPath: scriptPath)
    guard (try? FileManager.default.copyItem(atPath: source, toPath: scriptPath)) != nil else { return refuseApply(m, .install) }
    chmod(scriptPath, 0o700)
    for f in [resultPath, preparePath] { try? FileManager.default.removeItem(atPath: f) }
    // written before the checkout moves: a launch after a crash from here on finds it and puts the checkout back
    var p = AutoUpdate.Pending(
      version: m.version, old_version: options.appVersion ?? "", checkout: r.checkout, old_ref: ref, old_head: head, helper_pid: 0,
      started_at: ISOTime.string(hooks.wall()))
    p.commit = m.gitSha
    guard writePending(p) else { return refuseApply(m, .install) }
    phase = .final(r, QuietWait(), owner: owner, ref: ref)  // owned from here: `settlePending` leaves it alone
    let out = hooks.run(
      ["/bin/bash", scriptPath, "--prepare", "--checkout", r.checkout, "--commit", m.gitSha, "--result", preparePath], scriptEnv(),
      options.prepareTimeout)
    let res = readResult(preparePath)
    guard out.ok, res?.ok == true else {
      // the script puts the checkout back itself; when it could not say so (or never got that far), the app does if it moved
      if res?.restored != true { restoreCheckout(p) }
      removePending()
      phase = .idle(next: r.checkedAt + options.checkEvery)
      let why = res?.why.flatMap(AutoUpdate.Failure.init(rawValue:)) ?? (out.timedOut ? .deps : .checkout)
      return refuseApply(m, why)
    }
    audit("prepared", ["version": m.version, "commit": String(m.gitSha.prefix(12))])
  }

  /// The swap, in a session of its own (it quits this app).
  private func swap(_ r: Ready, ref: String) {
    let m = r.manifest
    let argv = [
      "/bin/bash", scriptPath, "--swap", "--checkout", r.checkout, "--commit", m.gitSha, "--to", ref, "--zip", r.zip, "--sha256",
      m.zipSha256, "--team", m.teamId, "--dest", r.dest, "--result", resultPath,
      "--health-file", healthPath(m.version), "--health-wait", String(Int(options.healthWait)), "--version", m.version,
    ]
    guard var p = readPending(), let pid = hooks.spawn(argv, scriptEnv(), dir + "/apply.log") else {
      restore(r, ref: ref)
      removePending()
      phase = .idle(next: r.checkedAt + options.checkEvery)
      return refuseApply(m, .install)
    }
    p.helper_pid = pid
    p.helper_started = hooks.processStart(pid)
    // the 30-minute cap is the swap's own: it counts from here, not from the prepare before it
    p.started_at = ISOTime.string(hooks.wall())
    _ = writePending(p)
    stopAskedAt = nil
    audit("applying", ["version": m.version, "pid": "\(pid)", "from": options.appVersion ?? ""])
    phase = .applying(pid: pid)
  }

  /// The checkout back where it was (`--restore`), its packages installed again.
  private func restore(_ r: Ready, ref: String) {
    let out = hooks.run(
      ["/bin/bash", scriptPath, "--restore", "--checkout", r.checkout, "--to", ref, "--result", dir + "/restore.json"], scriptEnv(),
      options.prepareTimeout)
    audit("restore", ["ok": out.ok ? "1" : "0", "exit": "\(out.status)"])
    // called only while this process owns the record; one that could not be put back stays, and the next look settles it
    if out.ok { removePending() }
  }

  private func refuseApply(_ m: ReleaseManifest, _ why: AutoUpdate.Failure) {
    audit("apply_refused", ["version": m.version, "why": why.rawValue])
    noteFailed(m.version)
    sayOnce(m.version + "|" + why.rawValue, AutoUpdate.failedLine(m.version, why: why, old: options.appVersion ?? "this version"))
  }

  private func writePending(_ p: AutoUpdate.Pending) -> Bool {
    guard let d = try? JSONEncoder().encode(p) else { return false }
    return (try? AtomicFile.write(d, to: pendingPath, mode: 0o600)) != nil
  }

  private func readPending() -> AutoUpdate.Pending? {
    guard let d = FileManager.default.contents(atPath: pendingPath), d.count < 8192 else { return nil }
    return try? JSONDecoder().decode(AutoUpdate.Pending.self, from: d)
  }

  private func removePending() { try? FileManager.default.removeItem(atPath: pendingPath) }

  private func readResult(_ path: String) -> AutoUpdate.Result? {
    FileManager.default.contents(atPath: path).flatMap { $0.count < 4096 ? $0 : nil }
      .flatMap { try? JSONDecoder().decode(AutoUpdate.Result.self, from: $0) }
  }

  /// True when nothing is pending (any more). A pending update is settled at most once: its record goes when its line is posted.
  private func settlePending() -> Bool {
    guard FileManager.default.contents(atPath: pendingPath) != nil else { return true }
    guard let p = readPending() else {
      audit("pending_unreadable")
      removePending()
      return true
    }
    let result = readResult(resultPath)
    let wall = hooks.wall()
    var alive = AutoUpdate.helperAlive(p, now: wall, processStart: hooks.processStart)
    // over its time with the swap still there: its group is asked to stop (its trap puts the checkout back), then it gets two minutes
    // never when this app IS the new version and has reported healthy: the swap is about to say ok, and stopping it then would roll back
    let reportedHealthy = options.appVersion.map { ReleaseManifest.compare($0, p.version) == 0 } == true
      && FileManager.default.fileExists(atPath: healthPath(p.version))
    if !alive, !reportedHealthy, result == nil, p.helper_pid > 1, let want = p.helper_started, let got = hooks.processStart(p.helper_pid),
      abs(got - want) < 0.001
    {
      let now = hooks.awake()
      if stopAskedAt == nil {
        stopAskedAt = now
        hooks.stopGroup(p.helper_pid)
        audit("apply_over_time", ["version": p.version, "pid": "\(p.helper_pid)"])
      }
      alive = now - (stopAskedAt ?? now) < 120
    }
    let healthy = FileManager.default.fileExists(atPath: healthPath(p.version))
    switch AutoUpdate.settle(pending: p, result: result, running: options.appVersion, helperAlive: alive, healthy: healthy) {
    case .waiting:
      return false
    case .updated:
      audit("updated", ["version": p.version, "from": p.old_version])
      hooks.post(AutoUpdate.updatedLine(p.version))
    case .failed(let why, let restore):
      if restore { restoreCheckout(p) }
      audit("failed", ["version": p.version, "why": why.rawValue, "result": result == nil ? "none" : "read"])
      noteFailed(p.version)
      let old = p.old_version.isEmpty ? (options.appVersion ?? "the previous version") : p.old_version
      switch why {
      case .unhealthy:
        // the previous app is back; Main may still run the release's bridge (the new app restarted it onto it): back onto the
        // checkout's code too, before the line, or the line says how to finish
        var line = AutoUpdate.unhealthyLine(p.version, old: old)
        if let head = git(p.checkout, ["rev-parse", "HEAD"]), hooks.bridgeNotOn(head) {
          let r = hooks.restartMainOnto(head)
          audit("rollback_restart_main", ["answer": "\(r)"])
          if r == .notYet {
            let now = hooks.awake()
            goingBackSince = goingBackSince ?? now
            if now - (goingBackSince ?? now) < 300 { return false }  // Main starting, or someone typing: settled at a later look
          }
          if r == .refused || r == .notYet { line = AutoUpdate.restartByHandLine(line) }
        }
        goingBackSince = nil
        // the health gate put the previous app back: this version is skipped for a week
        skip(p.version)
        sayOnce(p.version + "|" + why.rawValue, line)
      case .rollbackFailed:
        skip(p.version)
        sayOnce(p.version + "|" + why.rawValue, AutoUpdate.rollbackFailedLine(p.version, old: old))
      default:
        sayOnce(p.version + "|" + why.rawValue, AutoUpdate.failedLine(p.version, why: why, old: options.appVersion ?? p.old_version))
      }
    }
    for f in [pendingPath, resultPath, preparePath, scriptPath, dir + "/" + p.version, healthPath(p.version)] {
      try? FileManager.default.removeItem(atPath: f)
    }
    stopAskedAt = nil
    phase = .idle(next: hooks.awake() + options.checkEvery)
    return true
  }

  /// The swap was stopped before it could say how it ended: the checkout goes back to where it was, if it moved.
  private func restoreCheckout(_ p: AutoUpdate.Pending) {
    guard git(p.checkout, ["rev-parse", "HEAD"]) != p.old_head || git(p.checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]) != p.old_ref
    else { return audit("restore_not_needed") }
    // the copy that ran, else the app's own, else the checkout's
    let script = [scriptPath, options.applyScript, p.checkout + "/apps/desktop/scripts/auto-update-apply.sh"]
      .compactMap { $0 }.first { FileManager.default.fileExists(atPath: $0) } ?? ""
    let r = hooks.run(
      ["/bin/bash", script, "--restore", "--checkout", p.checkout, "--to", p.old_ref, "--result", dir + "/restore.json"], scriptEnv(), 900)
    audit("restore", ["ok": r.ok ? "1" : "0", "exit": "\(r.status)"])
  }

  // MARK: helpers

  static func fileSize(_ path: String) -> Int? {
    (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.intValue
  }

  /// Lowercase hex sha256 of a file, read in pieces.
  static func sha256(_ path: String) -> String? {
    guard let h = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? h.close() }
    var hasher = SHA256()
    while true {
      // nil or empty: the end of the file; a read that throws is no hash
      let chunk: Data?
      do { chunk = try h.read(upToCount: 1 << 20) } catch { return nil }
      guard let chunk, !chunk.isEmpty else { break }
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// posix_spawn in a new session (it outlives this app and gets no signal meant for its group), stdin from /dev/null, output to `log`.
  public static func spawnDetached(_ argv: [String], _ env: [String: String], _ log: String) -> Int32? {
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
    var fa: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&fa)
    defer { posix_spawn_file_actions_destroy(&fa) }
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&fa, 1, log, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    posix_spawn_file_actions_adddup2(&fa, 1, 2)
    let cArgs = argv.map { strdup($0) } + [nil]
    let cEnv = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { (cArgs + cEnv).forEach { free($0) } }
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, argv[0], &fa, &attr, cArgs, cEnv)
    return rc == 0 ? pid : nil
  }
}

/// A GET with a byte cap and a time limit; redirects followed only to https (or, for a local test feed, nowhere else).
public enum CappedFetch {
  final class Box: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let max: Int
    let out: FileHandle?
    var data = Data()
    var count = 0
    var failed = false
    let done = DispatchSemaphore(value: 0)
    init(max: Int, out: FileHandle?) {
      self.max = max
      self.out = out
    }
    func urlSession(
      _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void
    ) {
      if request.url?.scheme?.lowercased() == "https" { completionHandler(request) } else {
        failed = true
        completionHandler(nil)
      }
    }
    func urlSession(
      _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
      completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
      if let h = response as? HTTPURLResponse, h.statusCode != 200 { failed = true }
      if response.expectedContentLength > Int64(max) { failed = true }
      completionHandler(failed ? .cancel : .allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive d: Data) {
      count += d.count
      guard count <= max, !failed else {
        failed = true
        dataTask.cancel()
        return
      }
      if let out { out.write(d) } else { data.append(d) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      if error != nil { failed = true }
      done.signal()
    }
  }

  static func get(_ url: URL, max: Int, timeout: Double, out: FileHandle?) -> Box? {
    let box = Box(max: max, out: out)
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = min(timeout, 60)
    config.timeoutIntervalForResource = timeout
    config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    let session = URLSession(configuration: config, delegate: box, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    session.dataTask(with: url).resume()
    // the resource limit ends the task; this wait is only a floor under it
    guard box.done.wait(timeout: .now() + timeout + 30) == .success, !box.failed else { return nil }
    return box
  }

  public static func data(_ url: URL, _ max: Int, _ timeout: Double) -> Data? {
    get(url, max: max, timeout: timeout, out: nil)?.data
  }

  public static func file(_ url: URL, _ path: String, _ max: Int, _ timeout: Double) -> Bool {
    guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]),
      let h = FileHandle(forWritingAtPath: path)
    else { return false }
    let ok = get(url, max: max, timeout: timeout, out: h) != nil
    try? h.close()
    if !ok { try? FileManager.default.removeItem(atPath: path) }
    return ok
  }
}

/// The live process table for `BackgroundWork`: every process's pid, parent and name (`KERN_PROC_ALL`), and the argv of the few
/// whose name may stand for claude (`BackgroundWork.wantsArgv`: node, bun, a native install's version name).
public enum ProcTable {
  public static func live() -> [BackgroundWork.Proc]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    var size = 0
    guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    size += size / 4  // room for processes started in between
    var procs = [kinfo_proc](repeating: kinfo_proc(), count: size / MemoryLayout<kinfo_proc>.stride)
    guard sysctl(&mib, 4, &procs, &size, nil, 0) == 0 else { return nil }
    let n = size / MemoryLayout<kinfo_proc>.stride
    return procs.prefix(n).map { p in
      var c = p.kp_proc.p_comm
      let name = withUnsafeBytes(of: &c) { raw in
        String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
      }
      let pid = p.kp_proc.p_pid
      let argv = BackgroundWork.wantsArgv(name) ? ProcessInspect.snapshot(pid)?.argv : nil
      return BackgroundWork.Proc(pid: pid, ppid: p.kp_eproc.e_ppid, name: name, argv: argv)
    }
  }

  /// The background work under these pane processes, as one short reason ("background work: zsh (pid 412), ..."); nil when there is
  /// none. A table that cannot be read is a reason too: unknown is not quiet.
  public static func reason(panes: [Int32], table: [BackgroundWork.Proc]? = live()) -> String? {
    guard !panes.isEmpty else { return nil }
    guard let table else { return "the process list could not be read" }
    let found = BackgroundWork.offenders(table, panes: panes)
    guard !found.isEmpty else { return nil }
    return "background work: " + found.prefix(5).map { "\($0.name) (pid \($0.pid))" }.joined(separator: ", ")
  }
}
