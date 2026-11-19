import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// Restart on update (WorkerUpdateRestart.swift, WorkerLaunchPlan.swift) against a real private tmux server and the fake claude: the
/// spec hash a start records, the dry plan that gives the same hash and touches nothing, and the queue that restarts a session whose
/// spec changed once, resuming it, only while it is quiet, one at a time, held by the governor and the setting, and says so in one line.
final class UpdateBox<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var v: T
  init(_ v: T) { self.v = v }
  var value: T {
    get { lock.withLock { v } }
    set { lock.withLock { v = newValue } }
  }
}

extension WorkerRig {
  var auditPath: String { root + "/audit.log" }
  /// The audit lines whose text (after the time) starts with `prefix`.
  func audits(_ prefix: String) -> [String] {
    auditLines.compactMap { l in l.firstIndex(of: " ").map { String(l[l.index(after: $0)...]) } }.filter { $0.hasPrefix(prefix) }
  }

  /// A live bridge's status.json (this test process's pid, written now) with `governor`; `age` seconds old.
  func status(governor: String?, age: Double = 0) throws {
    let g = governor.map { ",\"governor\":\"\($0)\"" } ?? ""
    try #"{"v":1,"pid":\#(getpid()),"mode":"live","relay":{"connected":true},"bridge_commit":"abc1234","updated_at":"\#(ISOTime.string(Date().timeIntervalSince1970 - age))"\#(g)}"#
      .write(toFile: talosHome + "/status.json", atomically: true, encoding: .utf8)
  }

  /// The thread's own instructions (WORKER.md): what a session's spec holds, so a change to it is a changed spec.
  func instructions(_ id: String, _ text: String) throws {
    let d = agentDir + "/threads/" + id
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    try text.write(toFile: d + "/WORKER.md", atomically: true, encoding: .utf8)
  }

  func config(_ threads: [String], restartOnUpdate: String? = nil, extra: String = "") throws {
    let list = threads.map { "{\"id\":\"\($0)\",\"name\":\"\($0)\",\"kind\":\"fixed\",\"session\":\"dedicated\"\(extra)}" }.joined(separator: ",")
    let flag = restartOnUpdate.map { ",\"restart_on_update\":\($0)" } ?? ""
    try #"{"default_thread":"general","dedicated":{"enabled":true,"max_live":3\#(flag)},"threads":[{"id":"general","kind":"fixed"},\#(list)]}"#
      .write(toFile: talosHome + "/config.json", atomically: true, encoding: .utf8)
  }

  func dry(_ id: String) -> WorkerManager.DryPlan? {
    mgr.queue.sync {
      guard let s = mgr.loadSettings()?.threads[id] else { return nil }
      return mgr.dryPlan(id, s)
    }
  }

  /// A manager as the app makes it after an update: the audit log, a line poster, the release and the governor as given.
  @discardableResult
  func updatingManager(release: UpdateBox<String>, lines: UpdateBox<[String]>, poll: Double = 0.3, giveUpExtra: Double = 60) -> WorkerManager {
    let m = makeManager()
    m.tune { $0.auditLogPath = auditPath }
    m.updateRestart.releaseId = { release.value }
    m.updateRestart.releasePoll = poll
    m.updateRestart.giveUpExtra = giveUpExtra
    m.postNotice = { _, text in
      if text.hasPrefix("Updated or instructions changed") { lines.value.append(text) }
      return .sent
    }
    return m
  }

  func launched(_ id: String) -> WorkersFile.Launched? { entry(id)?.launched }

  /// Every file under the rig's folder, with its size, time and mode: what a dry plan must leave exactly as it was.
  func tree() -> [String: String] {
    var out: [String: String] = [:]
    let fm = FileManager.default
    for case let rel as String in fm.enumerator(atPath: root)?.allObjects ?? [] {
      var st = stat()
      guard lstat(root + "/" + rel, &st) == 0 else { continue }
      out[rel] = "\(st.st_size) \(st.st_mtimespec.tv_sec).\(st.st_mtimespec.tv_nsec) \(st.st_mode)"
    }
    return out
  }
}

extension WorkerRig {
  /// What the manager and tmux hold for each session and for the update queue, printed with a failed wait so a restart that does not
  /// come back says where it is stuck (phase, queue, holds, owed pointer, the park, the panes, the fake's own starts).
  func updateDump(since mark: Int) -> String {
    var out: [String] = []
    mgr.queue.sync {
      let u = mgr.updateState
      out.append(
        "queue \(u.queue.map(\.id)) current \(String(describing: u.current?.id)) restarted \(u.restarted) failed \(u.failed) "
          + "notRestarted \(u.notRestarted) waiting \(u.waitingNow) notQuietSince \(u.notQuietSince) started \(u.started)")
      for id in mgr.rt.keys.sorted() {
        guard let r = mgr.rt[id] else { continue }
        out.append(
          "\(id): state \(r.entry.state) pgid \(r.pgid) pane \(String(describing: r.paneId)) afterPark \(String(describing: r.afterPark)) "
            + "parkDeadline \(String(describing: r.parkDeadline)) heldSince \(String(describing: r.heldSince)) pointer \(r.pendingPointer) "
            + "enterOwed \(r.enterOwed) adoptPending \(r.adoptPending) started_at \(String(describing: r.entry.started_at)) "
            + "error \(String(describing: r.entry.error)) stopped_why \(String(describing: r.entry.stopped_why)) restarts \(r.entry.restarts)")
      }
    }
    out.append("events \(allEvents.dropFirst(mark))")
    out.append("tmux panes \(tmuxCmd(["list-panes", "-a", "-F", "#{session_name} pid=#{pane_pid} dead=#{pane_dead}"]).out)")
    out.append("fake starts \(starts)")
    return out.joined(separator: "\n")
  }
}

@Suite("Restart on update (Mac)", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUpdateRestartTests {
  static let ok = "sha256:"

  @Test func aStartRecordsItsSpecHashAndADryPlanGivesTheSameWhateverTheNonceOrSessionId() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    let h = try #require(r.launched("trip")?.spec_hash)
    #expect(SpecHash.isValid(h))
    #expect(r.dry("trip") == .hash(h))
    // a resume (another nonce, `--resume`) and a fresh start (another session id, `--session-id`): the same spec
    try r.wake("trip", action: "restart", ids: [])
    #expect(r.wait(15) { r.liveCount("trip") == 2 }, "\(r.why("trip"))")
    #expect(r.starts.last?.contains("--resume") == true)
    #expect(r.launched("trip")?.spec_hash == h)
    let sid = r.entry("trip")?.session_id
    try r.wake("trip", action: "fresh", ids: [])
    #expect(r.wait(15) { r.liveCount("trip") == 3 }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.session_id != sid)
    #expect(r.launched("trip")?.spec_hash == h)
    // the thread's instructions and its model are in it
    try r.instructions("trip", "You are the trip thread, version 2.")
    guard case .hash(let h2?)? = r.dry("trip") else { Issue.record("no hash"); return }
    #expect(h2 != h)
    try r.config(["trip"], extra: ",\"session_opts\":{\"model\":\"opus\"}")
    guard case .hash(let h3?)? = r.dry("trip") else { Issue.record("no hash"); return }
    #expect(h3 != h2 && h3 != h)
  }

  @Test func aDryPlanWritesNothingAuditsNothingAndRefusesWhatAStartRefuses() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    // a folder outside the agent folder, whose talos-app MCP entry a start writes: the dry plan works it out and writes none
    let folder = r.root + "/home/proj"
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    try #"{"mcpServers":{"talos-app":{"command":"talos-app","args":["mcp"]}}}"#.write(toFile: r.agentDir + "/.mcp.json", atomically: true, encoding: .utf8)
    try r.config(["trip"], extra: ",\"session_opts\":{\"cwd\":\"\(folder)\"}")
    r.mgr.tune { $0.auditLogPath = r.auditPath }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    let h = try #require(r.launched("trip")?.spec_hash)
    r.mgr.detach()  // nothing else writes while the tree is compared
    usleep(300_000)
    // the files a start writes, gone: a dry plan must not put them back
    for f in ["settings.json", "mcp.json", "nonce"] { unlink(r.talosHome + "/workers/trip/" + f) }
    try FileManager.default.removeItem(atPath: r.talosHome + "/workers/_hook")
    let before = r.tree()
    let audit = r.auditLines
    for _ in 0..<3 { #expect(r.dry("trip") == .hash(h)) }
    #expect(r.tree() == before)
    #expect(r.auditLines == audit)
    // refused where a start is refused (the hook cannot be found), and still nothing written
    r.hookSource = Rig.missingHook
    let m = r.makeManager()
    m.tune { $0.auditLogPath = r.auditPath }
    r.firstTick(m)
    let tree = r.tree()
    let lines = r.auditLines
    guard case .refused(let why)? = r.dry("trip") else { Issue.record("not refused: \(String(describing: r.dry("trip")))"); return }
    #expect(why.contains("permission hook"))
    #expect(r.tree() == tree)
    #expect(r.auditLines == lines)
    // and the real start: refused too
    m.startTicking()
    try r.wake("trip", action: "restart", ids: [])
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "start_failed")
  }

  @Test func anUpdateRestartsEachStaleSessionOnceOneAtATimeResumingItAndNeverAsACrash() throws {
    let r = try WorkerRig(threads: ["trip", "garden"])
    defer { r.teardown() }
    let release = UpdateBox("r1")
    let said = UpdateBox<[String]>([])
    try r.status(governor: "ok")
    r.updatingManager(release: release, lines: said)
    r.mgr.startTicking()
    try r.wake("trip")
    try r.wake("garden")
    #expect(r.wait(15) { r.liveCount("trip") == 1 && r.liveCount("garden") == 1 }, "\(r.why("trip")) \(r.why("garden"))")
    let sids = (r.entry("trip")?.session_id, r.entry("garden")?.session_id)
    let old = try #require(r.launched("trip")?.spec_hash)
    usleep(1_500_000)
    #expect(r.starts.count == 2, "no restart for a spec that did not change")
    // the update: both threads' instructions changed, and the app restarted with a new release
    try r.instructions("trip", "Trip, after the update.")
    try r.instructions("garden", "Garden, after the update.")
    guard case .hash(let new?)? = r.dry("trip") else { Issue.record("no hash"); return }
    // The app quits before the new release exists. The old manager must not tick while the box says r2: it would see the release
    // change itself, queue both threads and park one (SIGTERM) just before `updatingManager` detaches it, so the new manager
    // adopts a session that was parked for a restart nobody finishes (the restart is only in the old manager's memory).
    r.mgr.detach()
    release.value = "r2"
    try r.status(governor: "ok")
    let mark = r.allEvents.count
    r.updatingManager(release: release, lines: said)
    r.mgr.startTicking()
    #expect(
      r.wait(40) { r.liveCount("trip") == 2 && r.liveCount("garden") == 2 && r.starts.count == 4 },
      "\(r.why("trip")) \(r.why("garden")) \(r.auditLines)\n\(r.updateDump(since: mark))")
    // Which goes first is the session that is quiet first (one still busy from its adoption waits and the next goes ahead of it), so
    // the order is read from the events, not assumed.
    let ev = Array(r.allEvents.dropFirst(mark))
    func down(_ t: String) -> Int? { ev.firstIndex { $0 == .parked(thread: t, reason: "update") } }
    let order = ["garden", "trip"].sorted { (down($0) ?? .max) < (down($1) ?? .max) }
    #expect(r.wait(5) { said.value == ["Updated or instructions changed: restarted \(order[0]), \(order[1])."] }, "\(said.value)")
    // resumed (never fresh), and not counted as a crash
    #expect(r.entry("trip")?.session_id == sids.0 && r.entry("garden")?.session_id == sids.1)
    #expect(r.starts.suffix(2).allSatisfy { $0.contains("--resume") })
    #expect(r.entry("trip")?.restarts == [] && r.entry("garden")?.restarts == [])
    #expect(r.launched("trip")?.spec_hash == new && r.launched("trip")?.update_tried_hash == new && new != old)
    // one at a time: the second went down only once the first was live again
    let firstBack = try #require(ev.firstIndex { $0 == .live(thread: order[0]) })
    let secondDown = try #require(down(order[1]))
    #expect(firstBack < secondDown, "\(ev)")
    #expect(r.audits("update_restart thread=").count == 2)
    // the release seen is recorded in the app's own file, readable by the owner only
    let state = r.talosHome + "/" + WorkerManager.updateStateFile
    #expect((try? String(contentsOfFile: state, encoding: .utf8))?.contains("\"r2\"") == true)
    var st = stat()
    #expect(stat(state, &st) == 0 && st.st_mode & 0o777 == 0o600)
    // once per spec: another app restart and another release change restart nothing
    r.mgr.detach()  // as above: the old manager never runs against a release the new one is made for
    release.value = "r3"
    try r.status(governor: "ok")
    r.updatingManager(release: release, lines: said)
    r.mgr.startTicking()
    usleep(2_500_000)
    #expect(r.starts.count == 4)
    // a tried spec stays tried across a real start the owner asks for
    try r.wake("trip", action: "restart", ids: [])
    #expect(r.wait(15) { r.liveCount("trip") == 2 }, "\(r.why("trip"))")
    #expect(r.launched("trip")?.update_tried_hash == new && r.launched("trip")?.spec_hash == new)
  }

  @Test func theGovernorHoldsTheQueueUnlessAFreshStatusSaysOkOrOff() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let release = UpdateBox("r1")
    let said = UpdateBox<[String]>([])
    r.updatingManager(release: release, lines: said)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    try r.instructions("trip", "changed")
    try r.status(governor: "paused")
    release.value = "r2"
    #expect(r.wait(5) { r.audits("update_restart_queued").count == 1 })
    #expect(r.wait(5) { r.audits("update_restart_held governor=paused").count == 1 }, "\(r.auditLines)")
    for (g, age, want) in [("park_all", 0.0, "park_all"), ("ok", 120.0, "missing"), ("unknown", 0.0, "unknown")] {
      try r.status(governor: g, age: age)
      #expect(r.wait(5) { r.audits("update_restart_held governor=\(want)").count == 1 }, "\(g): \(r.auditLines)")
    }
    unlink(r.talosHome + "/status.json")
    usleep(1_000_000)
    #expect(r.starts.count == 1, "held: nothing restarted")
    try r.status(governor: "off")
    #expect(r.wait(15) { r.liveCount("trip") == 2 }, "\(r.why("trip")) \(r.auditLines)")
  }

  @Test func switchedOffNothingRestartsAndSwitchedOnItWaitsForTheNextRelease() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let release = UpdateBox("r1")
    let said = UpdateBox<[String]>([])
    try r.status(governor: "ok")
    try r.config(["trip"], restartOnUpdate: "false")
    // poll 0: every tick looks at the release. The test drives the ticks it needs itself (`tickOnce` returns once a whole tick has
    // run), so what a round did is read after it ran, never after a time that a loaded machine may not have given the timer.
    r.updatingManager(release: release, lines: said, poll: 0)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    func idle() -> Bool { r.mgr.queue.sync { r.mgr.updateState.queue.isEmpty && r.mgr.updateState.current == nil } }
    let state = r.talosHome + "/" + WorkerManager.updateStateFile
    func recorded(_ rel: String) -> Bool { (try? String(contentsOfFile: state, encoding: .utf8))?.contains("\"\(rel)\"") == true }
    try r.instructions("trip", "changed")
    release.value = "r2"
    r.mgr.tickOnce()
    #expect(recorded("r2"), "the release it was off through counts as checked")
    #expect(idle() && r.starts.count == 1)
    #expect(r.audits("update_restart_off").count == 1, "said once: \(r.auditLines)")
    // on again: no burst for the release it was off through
    try r.config(["trip"], restartOnUpdate: "true")
    try r.status(governor: "ok")
    r.mgr.tickOnce()
    r.mgr.tickOnce()
    #expect(idle() && r.starts.count == 1, "\(r.auditLines)")
    // config.json that cannot be read: nothing this round, whatever the release does. Both changes are made between two ticks of the
    // manager's queue: a tick already under way has read the config whole (a round runs on its own read) and would then see r3.
    r.mgr.queue.sync {
      try? "{not json".write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
      release.value = "r3"
    }
    r.mgr.tickOnce()
    #expect(idle() && r.starts.count == 1, "\(r.auditLines)")
    #expect(!recorded("r3"))
    try r.config(["trip"], restartOnUpdate: "true")
    try r.status(governor: "ok")
    #expect(r.wait(15) { r.liveCount("trip") == 2 }, "\(r.why("trip")) \(r.auditLines)")
  }

  @Test func neverWhileTheOwnerIsAtItAndTheWaitingThreadIsNamedOnce() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    // a tmux that reports an attached client's key now while `keys-now` exists (the owner typing in the pane)
    let wrapper = r.root + "/tmux-keys"
    try """
    #!/bin/sh
    case " $* " in *" list-clients "*) if [ -f '\(r.root)/keys-now' ]; then date +%s; exit 0; fi ;; esac
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: wrapper, atomically: true, encoding: .utf8)
    chmod(wrapper, 0o755)
    r.tmuxBin = wrapper
    let release = UpdateBox("r1")
    let said = UpdateBox<[String]>([])
    try r.status(governor: "ok")
    r.updatingManager(release: release, lines: said)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    let quiet = { r.mgr.queue.sync { r.mgr.updateQuiet("trip") } }
    // one thing changed, looked at, and put back, all in one turn of the manager's queue (a tick in between would see it)
    func quietWith(_ edit: (inout WorkerManager.Runtime) -> Void) -> Bool {
      r.mgr.queue.sync {
        guard let was = r.mgr.rt["trip"] else { return true }
        var changed = was
        edit(&changed)
        r.mgr.rt["trip"] = changed
        defer { r.mgr.rt["trip"] = was }
        return r.mgr.updateQuiet("trip")
      }
    }
    #expect(r.wait(5) { quiet() }, "quiet once its turn is over")
    // each of these alone is not quiet
    FileManager.default.createFile(atPath: r.root + "/keys-now", contents: nil)
    #expect(!quiet(), "a key in an attached client")
    unlink(r.root + "/keys-now")
    #expect(quiet())
    #expect(!quietWith { $0.entry.turn_started_at = ISOTime.string(Date().timeIntervalSince1970) }, "a turn under way")
    #expect(!quietWith { $0.pendingPointer = true }, "a pointer owed")
    #expect(!quietWith { $0.needsYouPrompt = "trust" }, "waiting on the owner")
    #expect(!quietWith { $0.entry.state = "busy" }, "busy")
    #expect(!quietWith { $0.draftSince = 1 }, "a pointer held by a draft")
    #expect(!quietWith { $0.afterPark = "restart" }, "a restart already asked for")
    #expect(r.wait(5) { quiet() })
    // a draft in the box: the update waits for it, and the thread is named once as waiting
    let pane = try #require(r.mgr.queue.sync { r.mgr.rt["trip"]?.paneId })
    _ = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "send-keys", "-t", pane, "-l", "half a thought"], env: r.env, timeout: 5)
    #expect(r.wait(5) { !quiet() }, "a draft in the box")
    try r.instructions("trip", "changed")
    release.value = "r2"
    #expect(r.wait(10) { said.value == ["Updated or instructions changed: trip restarts when its turn ends."] }, "\(said.value) \(r.auditLines)")
    usleep(1_500_000)
    #expect(r.starts.count == 1, "never into the owner's draft")
    #expect(said.value.count == 1, "named once")
    // the draft goes: the restart runs, and its result gets a line of its own
    _ = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "send-keys", "-t", pane, "C-u"], env: r.env, timeout: 5)
    for _ in 0..<20 { _ = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "send-keys", "-t", pane, "BSpace"], env: r.env, timeout: 5) }
    #expect(r.wait(20) { r.liveCount("trip") == 2 }, "\(r.why("trip")) \(r.auditLines)")
    #expect(r.wait(5) { said.value.last == "Updated or instructions changed: restarted trip." }, "\(said.value)")
  }

  /// Fable R1-3: the round runs on the tick's own read of config.json. A tick whose read failed runs no round, even when something later
  /// in the same tick reads it again (a start's `threadFolders`) and that read works: the settings the round has are the stale ones.
  @Test func aRoundRunsOnTheTicksOwnReadNotOnOneMadeLaterInTheTick() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    try r.instructions("trip", "changed")
    // the app restarts with a new release: ticked by hand, the governor held at first so the queue only fills
    let release = UpdateBox("r2")
    let governor = UpdateBox("paused")
    let midTick = UpdateBox(false)
    let said = UpdateBox<[String]>([])
    let m = r.updatingManager(release: release, lines: said)
    m.updateRestart.governor = { governor.value }
    let off = #"{"default_thread":"general","dedicated":{"enabled":true,"max_live":3,"restart_on_update":false},"threads":[{"id":"general","kind":"fixed"},{"id":"trip","name":"trip","kind":"fixed","session":"dedicated"}]}"#
    // a reader later in the tick: the config is saved with the switch off, and read again
    m.mainRunsNarrowed = { [weak m] in
      if midTick.value {
        midTick.value = false
        try? off.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
        _ = m?.loadSettings()
      }
      return nil
    }
    r.firstTick(m)
    for _ in 0..<15 { m.tickOnce(); usleep(100_000) }  // past the busy window of the first look
    #expect(r.audits("update_restart_queued thread=trip").count == 1, "\(r.auditLines)")
    // this tick's read fails; the reader after it sees the switch off
    try "{half saved".write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    governor.value = "ok"
    midTick.value = true
    m.tickOnce()
    #expect(!midTick.value, "the reader ran inside the tick")
    for _ in 0..<5 { m.tickOnce(); usleep(100_000) }
    #expect(r.audits("update_restart thread=").isEmpty, "no restart on stale settings: \(r.auditLines)")
    #expect(!r.allEvents.contains(.parked(thread: "trip", reason: "update")))
    #expect(r.audits("update_restart_off").count == 1)
  }

  @Test func aRestartWhoseStartFailsStaysFailedAndIsSaid() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let release = UpdateBox("r1")
    let said = UpdateBox<[String]>([])
    try r.status(governor: "ok")
    r.updatingManager(release: release, lines: said)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    // the conversation cannot be resumed any more: the update's restart fails, and the session stays failed
    try r.instructions("trip", "changed")
    r.env["FAKE_RESUME_MISSING"] = "1"
    release.value = "r2"
    try r.status(governor: "ok")
    r.updatingManager(release: release, lines: said)
    r.mgr.startTicking()
    #expect(r.wait(20) { said.value == ["Updated or instructions changed: trip failed."] }, "\(said.value) \(r.why("trip")) \(r.auditLines)")
    #expect(r.state("trip") == "failed")
    #expect(r.audits("update_restart_failed thread=trip state=failed").count == 1, "\(r.auditLines)")
    let starts = r.starts.count
    release.value = "r3"
    try r.status(governor: "ok")
    usleep(2_000_000)
    #expect(r.starts.count == starts, "never retried")
    #expect(r.state("trip") == "failed")
  }

  @Test func aRestartThatFailsOrNeverComesBackIsSaidAndNeverTriedAgain() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let release = UpdateBox("r1")
    let said = UpdateBox<[String]>([])
    try r.status(governor: "ok")
    r.updatingManager(release: release, lines: said)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    // the next start sits on a trust dialog nobody answers: never live, so given up after the park, the ready time and the extra
    try r.instructions("trip", "changed")
    r.env["FAKE_SCENARIO"] = "worker-trust.sh"
    release.value = "r2"
    try r.status(governor: "ok")
    r.updatingManager(release: release, lines: said, giveUpExtra: 1)
    r.mgr.startTicking()
    // given up: said as not restarted, never as failed
    #expect(
      r.wait(40) { said.value == ["Updated or instructions changed: trip was not restarted (it did not start again)."] },
      "\(said.value) \(r.why("trip")) \(r.auditLines)")
    #expect(r.audits("update_restart_given_up thread=trip").count == 1)
    #expect(r.audits("update_restart_failed thread=trip").isEmpty)
    let tried = r.launched("trip")?.update_tried_hash
    #expect(tried != nil)
    // another release with the same spec: not tried again
    r.mgr.stopAll()
    r.env["FAKE_SCENARIO"] = "worker.sh"
    try r.wake("trip", action: "restart", ids: [])
    r.updatingManager(release: release, lines: said)
    r.mgr.startTicking()
    #expect(r.wait(15) { r.state("trip") == "live" }, "\(r.why("trip"))")
    let starts = r.starts.count
    release.value = "r3"
    try r.status(governor: "ok")
    usleep(2_500_000)
    #expect(r.starts.count == starts)
    #expect(r.audits("update_restart thread=").count == 1)
  }
}

/// The guards' refresh at Main's start (SupervisorGuardsRefresh.swift) re-pins the guards' hook after a bun upgrade, with no new release
/// of the app or the bridge. The thread sessions started under the old hook must still be restarted onto the new one.
@Suite("Restart on update: a guards refresh counts as a release (Mac)", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUpdateRestartGuardsTests {
  /// The guards' settings file as `install-guards` writes it, its hook pinned to `bun`.
  static func guardsSettings(bun: String, cli: String = "/home/alex/talos-app/apps/bridge/src/cli.ts") -> String {
    let cmd = "\"\(bun)\" \"\(cli)\" guard-hook --config \"/home/alex/.config/talos/guards/guards.json\" --sha \(String(repeating: "a", count: 64))"
    let o: [String: Any] = [
      "permissions": ["deny": ["Bash(claude plugin:*)"]],
      "hooks": ["PreToolUse": [["matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit", "hooks": [["type": "command", "command": cmd]]]]],
    ]
    return String(decoding: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
  }

  @Test func theReleaseIdCarriesTheGuardsSettings() {
    let a = Data(Self.guardsSettings(bun: "/opt/homebrew/Cellar/bun/1.3.11/bin/bun").utf8)
    let b = Data(Self.guardsSettings(bun: "/opt/homebrew/Cellar/bun/1.4.4/bin/bun").utf8)
    let ra = WorkerManager.releaseId(app: "app1", bridge: "abc1234", guards: a)
    #expect(ra != nil && ra == WorkerManager.releaseId(app: "app1", bridge: "abc1234", guards: a))
    #expect(ra != WorkerManager.releaseId(app: "app1", bridge: "abc1234", guards: b), "a re-pinned bun is a new release")
    #expect(ra != WorkerManager.releaseId(app: "app1", bridge: "abc1234", guards: nil), "installed or removed is too")
    #expect(WorkerManager.releaseId(app: "app1", bridge: nil, guards: a) == nil, "no bridge commit: not known yet, as before")
    #expect(ra?.contains("1.3.11") == false, "the file's hash, not its text")
  }

  @Test func aBunRePinnedByTheRefreshAloneQueuesTheStaleSessionAndRestartsItOntoTheNewHook() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let guards = GuardsSettings.path(talosHome: r.talosHome)
    try FileManager.default.createDirectory(atPath: r.talosHome + "/guards", withIntermediateDirectories: true)
    try Self.guardsSettings(bun: "/opt/homebrew/Cellar/bun/1.3.11/bin/bun").write(toFile: guards, atomically: true, encoding: .utf8)
    try r.status(governor: "ok")
    // the app's own release id (its build, the bridge's commit, the guards): nothing given in its place
    let said = UpdateBox<[String]>([])
    let m = r.makeManager()
    m.tune { $0.auditLogPath = r.auditPath }
    m.updateRestart.releasePoll = 0.3
    m.postNotice = { _, text in
      if text.hasPrefix("Updated or instructions changed") { said.value.append(text) }
      return .sent
    }
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    let old = try #require(r.launched("trip")?.spec_hash)
    let state = r.talosHome + "/" + WorkerManager.updateStateFile
    #expect(r.wait(5) { (try? String(contentsOfFile: state, encoding: .utf8))?.contains("guards:") == true }, "a check ran and recorded the release")
    let sessionSettings = r.talosHome + "/workers/trip/settings.json"
    #expect((try? String(contentsOfFile: sessionSettings, encoding: .utf8))?.contains("1.3.11") == true, "the guards ride in the session's settings")
    try r.status(governor: "ok")
    usleep(1_500_000)
    #expect(r.starts.count == 1, "same release, same spec: nothing restarts")
    // `brew upgrade bun`, then Main's start: the refresh re-pins the hook. The app and the bridge are the same release.
    try Self.guardsSettings(bun: "/opt/homebrew/Cellar/bun/1.4.4/bin/bun").write(toFile: guards, atomically: true, encoding: .utf8)
    guard case .hash(let new?)? = r.dry("trip") else { Issue.record("no hash"); return }
    #expect(new != old, "the thread's launch spec holds the hook")
    try r.status(governor: "ok")
    #expect(r.wait(20) { r.liveCount("trip") == 2 }, "\(r.why("trip")) \(r.auditLines)")
    #expect(r.audits("update_restart_queued thread=trip").count == 1, "\(r.auditLines)")
    #expect(r.launched("trip")?.spec_hash == new)
    #expect(r.starts.last?.contains("--resume") == true, "resumed, never fresh")
    #expect((try? String(contentsOfFile: sessionSettings, encoding: .utf8))?.contains("1.4.4") == true)
    #expect(r.wait(5) { said.value == ["Updated or instructions changed: restarted trip."] }, "\(said.value)")
  }

  /// A bun that is there, in a scratch folder, and the fake checkout's cli.ts: a hook whose pins exist.
  static let cli: String = Rig.realPath(Rig.fixtures + "/../fake-checkout/apps/bridge/src/cli.ts")
  static func scratchBun(_ name: String) throws -> String {
    let p = TestTemp.base + "/\(name)-\(UUID().uuidString.prefix(8))"
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: URL(fileURLWithPath: p))
    chmod(p, 0o755)
    return p
  }

  func hookManager(_ r: WorkerRig, notices: UpdateBox<[String]>) -> WorkerManager {
    let m = r.makeManager()
    m.tune { $0.auditLogPath = r.auditPath }
    m.updateRestart.releaseId = { "r1" }  // no release change at all: the gone bun alone
    m.updateRestart.releasePoll = 0.3
    m.postNotice = { _, text in
      notices.value.append(text)
      return .sent
    }
    return m
  }

  @Test func aThreadWhoseBunIsGoneIsToldOnceAndRestartedAtOnceEvenWithRestartOnUpdateOff() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let old = try Self.scratchBun("old-bun")
    let new = try Self.scratchBun("new-bun")
    defer { for p in [old, new] { try? FileManager.default.removeItem(atPath: p) } }
    let guards = GuardsSettings.path(talosHome: r.talosHome)
    try FileManager.default.createDirectory(atPath: r.talosHome + "/guards", withIntermediateDirectories: true)
    try Self.guardsSettings(bun: old, cli: Self.cli).write(toFile: guards, atomically: true, encoding: .utf8)
    try r.config(["trip"], restartOnUpdate: "false")
    try r.status(governor: "ok")
    let notices = UpdateBox<[String]>([])
    hookManager(r, notices: notices).startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    usleep(1_000_000)
    #expect(r.starts.count == 1 && !r.auditLines.contains { $0.contains("guard_hook_gone") }, "its bun is there")
    // brew upgrade bun, and Main's start re-pinned the guards to the new one
    try FileManager.default.removeItem(atPath: old)
    try Self.guardsSettings(bun: new, cli: Self.cli).write(toFile: guards, atomically: true, encoding: .utf8)
    #expect(r.wait(20) { r.liveCount("trip") == 2 }, "\(r.why("trip")) \(r.auditLines)")
    #expect(r.audits("guard_hook_gone thread=trip").count == 1, "\(r.auditLines)")
    #expect(r.audits("update_restart_queued thread=trip why=guard_hook_gone").count == 1)
    #expect(r.starts.last?.contains("--resume") == true, "resumed, never fresh")
    #expect(r.wait(5) { notices.value.contains { $0.contains("Thread trip's guard hook can't start (its Bun moved)") } }, "\(notices.value)")
    // the session's settings (JSON may write `/` as `\/`) name the new bun by its file name, unique to this test
    #expect((try? String(contentsOfFile: r.talosHome + "/workers/trip/settings.json", encoding: .utf8))?.contains((new as NSString).lastPathComponent) == true)
    usleep(1_500_000)
    #expect(r.starts.count == 2, "restarted once")
    #expect(notices.value.filter { $0.contains("guard hook can't start") }.count == 1)
  }

  @Test func whenTheGuardsBunIsGoneTooTheThreadIsToldAboutButNotRestartedIntoTheSameGoneBun() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let old = try Self.scratchBun("old-bun")
    let guards = GuardsSettings.path(talosHome: r.talosHome)
    try FileManager.default.createDirectory(atPath: r.talosHome + "/guards", withIntermediateDirectories: true)
    try Self.guardsSettings(bun: old, cli: Self.cli).write(toFile: guards, atomically: true, encoding: .utf8)
    try r.status(governor: "ok")
    let notices = UpdateBox<[String]>([])
    hookManager(r, notices: notices).startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    try FileManager.default.removeItem(atPath: old)
    #expect(r.wait(10) { r.audits("guard_hook_gone thread=trip").count == 1 }, "\(r.auditLines)")
    #expect(r.wait(5) { notices.value.contains { $0.contains("Thread trip's guard hook can't start") } })
    usleep(2_000_000)
    #expect(r.starts.count == 1, "a restart would pin the same gone bun: it waits for Main's refresh")
    #expect(r.audits("guard_hook_gone thread=trip").count == 1, "said once")
  }
}
