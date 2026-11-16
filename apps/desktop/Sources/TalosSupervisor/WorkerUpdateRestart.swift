import Foundation
import TalosDesktopCore

/// Restart on update (the Mac's half; the Linux twin is apps/bridge/src/supervisor/update-restart.ts). Right after the app starts (once
/// the running sessions are adopted), and whenever the release the app sees (its own build, the bridge's commit and the guards' settings
/// as Main's start refreshed them, `releaseId`) differs
/// from the one recorded at the last check, each running thread session whose launch spec changed (the hash a dry plan gives now,
/// `dryPlan`, against `WorkersFile.Launched.spec_hash`) is restarted ONCE for that spec, resuming its conversation, one at a time, and
/// never by cutting into the owner: only while it is quiet (no turn, nothing owed or held for it, nothing on the pane asking the owner,
/// no draft in its box, no key in an attached client lately, the pane silent and readable), so one that is always busy just waits. The
/// spec is written down BEFORE the try (`update_tried_hash`, kept across the start it gives, published at once), so no spec is tried
/// twice. It holds while the bridge's fresh status.json does not say the usage governor is `ok` or `off`, and does nothing while
/// `dedicated.restart_on_update` is off. A dry plan refused, a start that fails or a restart that never comes back leaves the session
/// alone (never retried). The owner gets one line in the default thread (`UpdateRestartLine`, the protocol's words), and a result after
/// that line gets a line of its own. None of these restarts count as crashes.
public struct UpdateRestartWiring: Sendable {
  /// The release the app runs now (nil: cannot be told; the poll looks again). nil closure: the app's build (`TalosGitSha`, else its
  /// version), the bridge's commit from status.json and the hash of the guards' settings file (`WorkerManager.releaseId`).
  public var releaseId: (@Sendable () -> String?)?
  /// The usage governor as a live bridge's fresh status.json says it (nil: not known). nil closure: `$TALOS_APP_HOME/status.json`.
  public var governor: (@Sendable () -> String?)?
  /// `desktop.json` `env` as it is now: the launch spec's `launch-env`.
  public var launchEnv: (@Sendable () -> [String: String])?
  /// How often the release is compared with the last check's.
  public var releasePoll: Double = 60
  /// A key in an attached client this recently: the owner may be typing (the screen may not show it).
  public var keysQuiet: Double = 120
  /// A restart not back after the park's grace and the start's ready time plus this is given up (said as failed, never retried).
  public var giveUpExtra: Double = 60
  /// A session not quiet for this long is named in the line as waiting for its turn: one that is busy for a moment (a session just
  /// adopted reads busy at its first look) is not.
  public var waitingAfter: Double = 5
  public init() {}
}

struct UpdateRestartState {
  var started = false
  var lastPoll: Double?
  var queue: [(id: String, hash: String)] = []
  var current: (id: String, startedAt: String?, since: Double)?
  var restarted: [String] = []
  var failed: [String] = []
  /// Given up: stopped for the restart and never started again (said as not restarted, never as failed).
  var notRestarted: [String] = []
  var waitingNow: [String] = []
  var waitingSaid = Set<String>()
  /// Since when (awake clock) each queued session has been found not quiet.
  var notQuietSince: [String: Double] = [:]
  var offSaid = false
  var heldSaid: String?
  /// The refusal each thread's dry plan last gave, audited once.
  var refusedSaid: [String: String] = [:]
  /// The line not yet sent after a clear failure: tried three times.
  var line: (text: String, tries: Int, at: Double)?
  /// Sessions whose guard hook names a bun or a cli.ts that is gone: queued at once, whatever the release and the setting say.
  var hookGone = Set<String>()
  /// `thread|pin` already said (audit and owner line), once each.
  var hookGoneSaid = Set<String>()
  var hookCheckedAt: Double?
}

extension WorkerManager {
  /// The queue's own record (0600): the release seen at the last check that ran.
  static let updateStateFile = "mac-update-restart.json"
  /// A restart not back by then is given up, never retried: the park's grace, the start's ready time, and a minute.
  var updateGiveUp: Double { options.parkGrace + options.readyTimeout + updateRestart.giveUpExtra }

  /// One round, inside the tick, after the sessions have advanced. `fresh`: config.json read whole this tick.
  func updateRestartTick(settings: DedicatedSettings, fresh: Bool) {
    retryUpdateLine()
    guard fresh else { return }  // config.json cannot be read: nothing this round
    guardHookCheck(settings)
    guard settings.restartOnUpdate else {
      if !updateState.offSaid { audit("update_restart_off") }
      updateState.offSaid = true
      // a session whose guard hook cannot start is blocked: it is restarted whatever this setting says
      updateState.queue = updateState.queue.filter { updateState.hookGone.contains($0.id) }
      updateState.waitingNow = []
      defer { if !updateState.queue.isEmpty || updateState.current != nil { runUpdateQueue(settings) } }
      // no burst when it is switched on again: the release running now counts as checked, so only the next one is looked at
      let w = awake()
      if !updateState.started || w - (updateState.lastPoll ?? -.infinity) >= updateRestart.releasePoll {
        updateState.started = true
        updateState.lastPoll = w
        if let release = (updateRestart.releaseId ?? { [weak self] in self?.defaultReleaseId() })(), release != recordedRelease() { recordRelease(release) }
      }
      return
    }
    updateState.offSaid = false
    settleUpdate(settings)
    maybeCheckUpdate(settings)
    runUpdateQueue(settings)
  }

  /// The restart under way settled, and the next one started once quiet and the governor allows.
  private func runUpdateQueue(_ settings: DedicatedSettings) {
    settleUpdate(settings)
    if updateState.current != nil || updateState.queue.isEmpty { return sayUpdate(settings) }
    // the governor: only while a live bridge says ok or off (a paused governor must not have sessions started into it)
    let g = (updateRestart.governor ?? { [weak self] in self?.statusGovernor() })() ?? "missing"
    guard g == "ok" || g == "off" else {
      if updateState.heldSaid != g { audit("update_restart_held governor=\(g)") }
      updateState.heldSaid = g
      return
    }
    updateState.heldSaid = nil
    nextUpdate(settings)
  }

  /// Right after the app starts, then whenever the release differs from the last check's.
  private func maybeCheckUpdate(_ settings: DedicatedSettings) {
    let w = awake()
    if updateState.started, let last = updateState.lastPoll, w - last < updateRestart.releasePoll { return }
    updateState.lastPoll = w
    let release = (updateRestart.releaseId ?? { [weak self] in self?.defaultReleaseId() })()
    if updateState.started, release == nil || release == recordedRelease() { return }
    // recorded only once a check really ran: one that could not run is tried again at the next poll
    guard checkUpdate(settings) else { return }
    updateState.started = true
    if let release { recordRelease(release) }
  }

  /// Which running sessions run an older spec than a start would give them now. False: it could not look yet.
  private func checkUpdate(_ settings: DedicatedSettings) -> Bool {
    if rt.values.contains(where: \.adoptPending) { return false }
    if let has = hasLoginEnv, !has() { return false }  // the login PATH is not known: the python3 and claude a start would find are not either
    if updateState.queue.isEmpty, updateState.current == nil { updateState.waitingSaid = [] }  // a new round
    for id in rt.keys.sorted() {
      guard let r = rt[id], r.entry.state == "live" || r.entry.state == "busy", r.entry.session_id != nil, let s = settings.threads[id] else { continue }
      if updateState.queue.contains(where: { $0.id == id }) || updateState.current?.id == id { continue }
      switch dryPlan(id, s) {
      case .refused(let why):
        // left as it is: a start now would be refused too
        if updateState.refusedSaid[id] != why { audit("update_check_skipped thread=\(id) why=\"\(WorkerNotice.logValue(why))\"") }
        updateState.refusedSaid[id] = why
      case .hash(nil): continue
      case .hash(let hash?):
        updateState.refusedSaid[id] = nil
        if r.entry.launched?.spec_hash == hash || r.entry.launched?.update_tried_hash == hash { continue }
        updateState.queue.append((id, hash))
        audit("update_restart_queued thread=\(id)")
      }
    }
    return true
  }

  /// The head of the queue, restarted once it is quiet; a busy one waits (and is named) without holding the others.
  private func nextUpdate(_ settings: DedicatedSettings) {
    guard let head = updateState.queue.first else { return }
    let name = updateName(head.id)
    guard let r = rt[head.id], !r.adoptPending, r.entry.state == "live" || r.entry.state == "busy", settings.threads[head.id] != nil else {
      updateState.queue.removeFirst()  // gone, parked or stopped meanwhile: its next start takes the new spec anyway
      updateState.waitingNow.removeAll { $0 == name }
      return
    }
    guard updateQuiet(head.id) else {
      let since = updateState.notQuietSince[head.id] ?? awake()
      updateState.notQuietSince[head.id] = since
      if awake() - since >= updateRestart.waitingAfter, !updateState.waitingNow.contains(name) { updateState.waitingNow.append(name) }
      if updateState.queue.count > 1 { updateState.queue.append(updateState.queue.removeFirst()) }
      return sayUpdate(settings)
    }
    updateState.queue.removeFirst()
    updateState.hookGone.remove(head.id)
    updateState.waitingNow.removeAll { $0 == name }
    updateState.notQuietSince[head.id] = nil
    // the spec this restart is for, written down and published BEFORE the try: never a second try for the same spec (an entry with no
    // launch record, from an older build, has nowhere to keep it: its restart writes one with the new spec, which then matches)
    if rt[head.id]?.entry.launched != nil {
      rt[head.id]?.entry.launched?.update_tried_hash = head.hash
      writeFile()
    }
    updateState.current = (head.id, r.entry.started_at, awake())
    audit("update_restart thread=\(head.id)")
    // parked, then started again on the same conversation: the owner's Restart (`perform("restart")` resumes it), never fresh
    rt[head.id]?.afterPark = "restart"
    beginPark(head.id, reason: "update")
  }

  /// Each poll: a running thread session whose own settings name a guard hook bun or cli.ts that is gone (a `brew upgrade bun`) has
  /// every guarded call denied (the hook fails closed). One audit row and one owner line per session and pin, and the session is
  /// queued for a restart at once (not only at a release change, and with restart on update off too) when a start now would pin a
  /// bun that is there (the guards' own file, as Main's start refreshed it). Otherwise it waits for that refresh.
  func guardHookCheck(_ settings: DedicatedSettings) {
    let w = awake()
    if let at = updateState.hookCheckedAt, w - at < updateRestart.releasePoll { return }
    updateState.hookCheckedAt = w
    let current = GuardsRefresh.pins(settings: FileManager.default.contents(atPath: GuardsSettings.path(talosHome: options.talosHome)))
    let currentWorks = current.map { FileManager.default.isExecutableFile(atPath: $0.bun) && FileManager.default.fileExists(atPath: $0.cli) } ?? false
    for id in rt.keys.sorted() {
      guard let r = rt[id], r.entry.state == "live" || r.entry.state == "busy", !r.adoptPending, let s = settings.threads[id] else { continue }
      let file = options.talosHome + "/workers/\(id)/settings.json"
      guard let pins = GuardsRefresh.pins(settings: FileManager.default.contents(atPath: file)) else { continue }
      if FileManager.default.isExecutableFile(atPath: pins.bun) && FileManager.default.fileExists(atPath: pins.cli) { continue }
      let key = id + "|" + pins.bun + "|" + pins.cli
      if !updateState.hookGoneSaid.contains(key) {
        updateState.hookGoneSaid.insert(key)
        audit("guard_hook_gone thread=\(id)")
        let text = GuardsRefresh.threadHookGoneLine(updateName(id))
        if let post = postNotice {
          let thread = settings.defaultThread
          Thread.detachNewThread { _ = post(thread, text) }
        }
      }
      guard currentWorks, updateState.current?.id != id, !updateState.queue.contains(where: { $0.id == id }) else { continue }
      guard case .hash(let hash?) = dryPlan(id, s), r.entry.launched?.update_tried_hash != hash else { continue }
      updateState.hookGone.insert(id)
      updateState.queue.append((id, hash))
      audit("update_restart_queued thread=\(id) why=guard_hook_gone")
    }
  }

  /// Quiet as the idle park reads it, and more: live and not in a turn, no park or stop under way, nothing on the pane or in its notes
  /// asking the owner, no pointer owed or held, nothing in its input box, no key in an attached client for `keysQuiet`, and the pane
  /// silent. Anything that cannot be read is not quiet.
  func updateQuiet(_ id: String) -> Bool {
    guard let r = rt[id], r.entry.state == "live", !r.adoptPending, r.pgid > 0 else { return false }
    if r.entry.turn_started_at != nil || r.pendingPointer || r.enterOwed || r.owed.leftover || r.heldSince != nil { return false }
    if r.needsYouPrompt != nil || r.promptWatch.current != nil || r.heldPrompt != nil || r.entry.dialog != nil || r.draftSince != nil { return false }
    if r.parkDeadline != nil || r.stopDeadline != nil || r.afterPark != nil { return false }
    let t = now()
    if isBusy(id, now: t) { return false }  // the pane read, and silent on both clocks
    let capture = run(tmux(id).capturePane())
    guard capture.ok else { return false }
    let rows = TmuxCommands.parseCapture(capture.out)
    if guardShape(rows) != .none || PointerTyper.inputBox(rows: rows) == nil || PointerTyper.draftPresent(rows: rows) { return false }
    let clients = run(tmux(id).listClientsActivity())
    guard clients.ok, let keys = TmuxCommands.parseClientActivity(clients.out) else { return false }
    return !keys.contains { t - $0 < updateRestart.keysQuiet }
  }

  /// The restart under way: done once the session started again; failed once its start failed, or it never came back.
  private func settleUpdate(_ settings: DedicatedSettings) {
    guard let c = updateState.current else { return }
    let e = rt[c.id]?.entry
    let s = e?.state ?? "off"
    if s == "failed" || s == "off" {
      updateState.failed.append(updateName(c.id))
      audit("update_restart_failed thread=\(c.id) state=\(s)")
    } else if s == "live" || s == "busy", e?.started_at != c.startedAt {
      updateState.restarted.append(updateName(c.id))
    } else if awake() - c.since >= updateGiveUp {
      // parked and never started again (a start held, a dialog nobody answered): given up, never retried, said as not restarted
      updateState.notRestarted.append(updateName(c.id))
      audit("update_restart_given_up thread=\(c.id) state=\(s) after_s=\(Int(updateGiveUp))")
    } else {
      return  // still on its way down or up
    }
    updateState.current = nil
  }

  /// Once every queued session is restarted, failed or waiting for its turn: one line with what is new since the last one.
  private func sayUpdate(_ settings: DedicatedSettings) {
    guard updateState.current == nil, !updateState.queue.contains(where: { !updateState.waitingNow.contains(updateName($0.id)) }) else { return }
    let waiting = updateState.waitingNow.filter { !updateState.waitingSaid.contains($0) }
    guard
      let text = UpdateRestartLine.line(
        restarted: updateState.restarted, waiting: waiting, failed: updateState.failed, notRestarted: updateState.notRestarted)
    else { return }
    audit(
      "update_restart_said restarted=\(updateState.restarted.count) waiting=\(waiting.count) failed=\(updateState.failed.count) "
        + "not_restarted=\(updateState.notRestarted.count)")
    updateState.waitingSaid.formUnion(waiting)
    updateState.restarted = []
    updateState.failed = []
    updateState.notRestarted = []
    postUpdateLine(text, to: settings.defaultThread, tries: 0)
  }

  /// The line into the default thread, off the queue. A clear failure is tried again `noticeRetry` later, three times, then said in the log.
  private func postUpdateLine(_ text: String, to thread: String, tries: Int) {
    updateState.line = nil
    guard let post = postNotice else { return audit("update_restart_line_not_sent reason=no_poster") }
    Thread.detachNewThread { [weak self] in
      let outcome = post(thread, text)
      self?.queue.async {
        guard let self, outcome == .failed else { return }
        if tries + 1 >= 3 { return self.audit("update_restart_line_failed tries=3") }
        self.updateState.line = (text, tries + 1, self.awake() + self.options.noticeRetry)
      }
    }
  }

  private func retryUpdateLine() {
    guard let l = updateState.line, awake() >= l.at else { return }
    postUpdateLine(l.text, to: loadSettings()?.defaultThread ?? "general", tries: l.tries)
  }

  /// The thread's name as config.json gives it, else its id (as the Linux line names it; `UpdateRestartLine` keeps it on one line).
  func updateName(_ id: String) -> String {
    ThreadChoices.read(FileManager.default.contents(atPath: configJson)).threads.first { $0.id == id }?.name ?? id
  }

  /// The governor in a live bridge's fresh status.json (its pid alive, written under 45 s ago, mode live); nil for anything else.
  func statusGovernor() -> String? {
    guard let s = currentBridgeStatus() else { return nil }
    return s.governor
  }

  private func currentBridgeStatus() -> BridgeStatus? {
    guard let d = FileManager.default.contents(atPath: options.talosHome + "/status.json"), let s = BridgeStatus.decode(d) else { return nil }
    let h = s.health(now: Date(timeIntervalSince1970: now()), pidAlive: { kill($0, 0) == 0 || errno == EPERM })
    return h == .healthy || h == .relayDown ? s : nil
  }

  /// This app's build, the bridge's commit and the guards' settings as they are now; nil while the bridge's commit cannot be read.
  func defaultReleaseId() -> String? {
    let info = Bundle.main.infoDictionary
    let app = (info?["TalosGitSha"] as? String) ?? (info?["CFBundleVersion"] as? String) ?? "none"
    return Self.releaseId(
      app: app, bridge: currentBridgeStatus()?.bridgeCommit,
      guards: FileManager.default.contents(atPath: GuardsSettings.path(talosHome: options.talosHome)))
  }

  /// The release a check is made for: the app's build, the bridge's commit, and the hash of the guards' settings file (`none` when
  /// there is none). The guards ride in every thread session's settings, and Main's start refreshes them (`talos-app guards refresh`)
  /// with no release of the app or the bridge: after a bun upgrade the hook is re-pinned to the new bun. That file changing is a
  /// release here, so the sessions still started under the old hook are looked at (their spec hash differs) and restarted.
  static func releaseId(app: String, bridge: String?, guards: Data?) -> String? {
    guard let bridge else { return nil }
    return "\(app)|\(bridge)|guards:\(guards.map(SpecHash.hex) ?? "none")"
  }

  private func recordedRelease() -> String? {
    guard let d = FileManager.default.contents(atPath: options.talosHome + "/" + Self.updateStateFile), d.count <= 4096,
      let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], (o["v"] as? NSNumber)?.intValue == 1
    else { return nil }
    return o["release"] as? String
  }

  private func recordRelease(_ release: String) {
    guard let d = try? JSONSerialization.data(withJSONObject: ["v": 1, "release": release], options: [.sortedKeys]) else { return }
    do {
      try AtomicFile.write(d, to: options.talosHome + "/" + Self.updateStateFile, mode: 0o600)
    } catch {
      audit("update_restart_state_not_written")
    }
  }
}
