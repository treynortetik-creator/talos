import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Option C worker manager (docs/OPTION-C.md) against a real private tmux server (`talos-test-…`, never `-L talos`) and
/// the fake claude's `worker.sh`. Nothing here touches the owner's tmux, Telegram or bridge.
final class WorkerRig: @unchecked Sendable {
  let root: String
  let talosHome: String
  let agentDir: String
  let log: String
  let typed: String
  let envLog: String
  let socket: String
  var env: [String: String]
  var mgr: WorkerManager!
  private var helpers: [Process] = []
  private let lock = NSLock()
  private var events: [WorkerManager.Event] = []

  init(threads: [String] = ["trip"], maxLive: Int = 3, scenario: String = "worker.sh", extraEnv: [String: String] = [:])
    throws
  {
    let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-oc-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
    root = Rig.realPath(base)
    talosHome = root + "/talos-home"
    agentDir = root + "/agent"
    log = root + "/fake.log"
    typed = root + "/typed.log"
    envLog = root + "/env"
    socket = "talos-test-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    for d in [talosHome, agentDir, root + "/home"] {
      try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    }
    let list = threads.map {
      "{\"id\":\"\($0)\",\"name\":\"\($0)\",\"kind\":\"fixed\",\"session\":\"dedicated\"}"
    }.joined(separator: ",")
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":\(maxLive)},"threads":[{"id":"general","kind":"fixed"},\(list)]}
    """.write(toFile: talosHome + "/config.json", atomically: true, encoding: .utf8)
    env = [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": root + "/home", "LANG": "en_US.UTF-8",
      "FAKE_SCENARIO": scenario, "FAKE_LOG": log, "FAKE_TYPED_LOG": typed, "FAKE_WORKER_ENV_LOG": envLog,
      "FAKE_MAX_LIFETIME": "120",
      // must never reach a worker
      "TELEGRAM_BOT_TOKEN": "123:not-a-real-token", "TALOS_APP_BRIDGE": "1", "MCP_PROTOCOL_NEGOTIATION": "legacy",
    ].merging(extraEnv) { _, b in b }
    makeManager()
  }

  /// The first tick of a manager made right after another one detached. It must win `workers.lock`: the lock is released with
  /// `flock(LOCK_UN)`, so a copy of the old descriptor that a spawn in flight still holds cannot keep it. A tick that did not
  /// win it is a failure here, said plainly, never a reason to tick again.
  @discardableResult
  func firstTick(_ m: WorkerManager? = nil, sourceLocation: SourceLocation = #_sourceLocation) -> Bool {
    let m = m ?? mgr!
    m.tickOnce()
    #expect(m.isActive, "the first tick did not get workers.lock: the previous holder's flock was still held", sourceLocation: sourceLocation)
    return m.isActive
  }

  @discardableResult
  func makeManager(idle: Double? = nil) -> WorkerManager {
    var o = WorkerManager.Options(
      talosHome: talosHome, agentDir: agentDir, claudePath: Rig.fixtures + "/claude",
      permissionFlag: "--dangerously-skip-permissions", tmux: Rig.tmuxPath!, tmuxConf: Rig.tmuxConf)
    o.socket = socket
    o.home = root + "/home"
    o.tick = 0.2
    o.heartbeat = 0.5
    o.readyTimeout = 8
    o.parkGrace = 2
    o.idleSecondsOverride = idle
    o.busyWindow = 0.5
    let e = env
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { e }), baseEnv: { e })
    m.onEvent = { [weak self] ev in self?.lock.withLock { self?.events.append(ev) } }
    mgr?.detach()
    mgr = m
    return m
  }

  var allEvents: [WorkerManager.Event] { lock.withLock { events } }

  func wake(_ id: String, action: String = "pointer", ids: [String] = ["m_01JBF3V7Q8K2M4N6P8R0S2T401"]) throws {
    let d = talosHome + "/workers/" + id
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    let list = ids.map { "\"\($0)\"" }.joined(separator: ",")
    try "{\"v\":1,\"thread_id\":\"\(id)\",\"message_ids\":[\(list)],\"at\":\"2026-10-30T00:00:00.000Z\",\"action\":\"\(action)\"}"
      .write(toFile: d + "/wake", atomically: true, encoding: .utf8)
  }

  /// What a failed wait should say: the state, the error, and the starts the fake saw.
  func why(_ id: String) -> String {
    "state \(String(describing: state(id))), error \(String(describing: entry(id)?.error)), starts \(starts.count)"
  }
  func entry(_ id: String) -> WorkersFile.Entry? { mgr.snapshot().threads[id] }
  func state(_ id: String) -> String? { entry(id)?.state }
  var starts: [String] { lines(log) }
  /// How many times the manager has said this thread went live (once per start). Events are kept, so a brief "live" between
  /// two polls of a busy machine is still seen; the state itself is only a snapshot of one moment.
  func liveCount(_ id: String) -> Int { allEvents.filter { $0 == .live(thread: id) }.count }
  var typedLines: [String] { lines(typed) }
  func lines(_ p: String) -> [String] {
    ((try? String(contentsOfFile: p, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
  }

  @discardableResult
  func wait(_ timeout: Double, _ cond: () -> Bool) -> Bool {
    let until = Date().addingTimeInterval(timeout)
    while Date() < until {
      if cond() { return true }
      usleep(50_000)
    }
    return cond()
  }

  func teardown() {
    mgr?.detach()
    _ = ProcessRunner.run([Rig.tmuxPath!, "-L", socket, "kill-server"], env: env, timeout: 5)
    unlink("/tmp/tmux-\(getuid())/\(socket)")
    for p in lock.withLock({ helpers }) where p.isRunning { kill(p.processIdentifier, SIGKILL) }
    try? FileManager.default.removeItem(atPath: root)
  }
}

@Suite("Option C worker manager", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerManagerTests {
  @Test func startsOnWakeTypesOnePointerAndNeverLeaksChannels() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" || r.state("trip") == "busy" }, "live")
    #expect(r.wait(5) { r.typedLines.count == 1 })
    #expect(r.typedLines.first == "trip \(PointerTyper.text)")
    let start = try #require(r.starts.first)
    for bad in ["--channels", "--dangerously-load-development-channels", " -p ", "--bg", "server:talos-app"] {
      #expect(!start.contains(bad), "\(bad)")
    }
    #expect(start.contains("--session-id"))
    #expect(start.contains("--name talos-trip"))
    let env = r.lines(r.envLog + ".trip")
    #expect(!env.contains { $0.hasPrefix("TELEGRAM_BOT_TOKEN=") || $0.hasPrefix("TALOS_APP_BRIDGE=") })
    #expect(!env.contains { $0.hasPrefix("MCP_PROTOCOL_NEGOTIATION=") })
    #expect(env.contains("TALOS_APP_WORKER_THREAD=trip"))
    #expect(env.contains("TALOS_SESSION_ROLE=worker"))
    #expect(env.contains { $0.hasPrefix("TELEGRAM_STATE_DIR=") && $0.hasSuffix("/workers/_nochannel") })
    // workers.json is written with the heartbeat and the pane pid
    let raw = try #require(FileManager.default.contents(atPath: r.talosHome + "/workers.json"))
    let f = try #require(WorkersFile.decode(raw))
    #expect(f.supervisor.workers_supported)
    #expect(r.wait(3) { (r.entry("trip")?.pane_pid ?? 0) > 1 })
    // a second wake for the same batch types one more line, never two
    try r.wake("trip")
    #expect(r.wait(5) { r.typedLines.count == 2 })
    usleep(600_000)
    #expect(r.typedLines.count == 2)
  }

  @Test func idleParksWithTheGroupGoneAndTheNextWakeResumesTheSameId() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.makeManager(idle: 1.5)
    r.mgr.startTicking()
    try r.wake("trip")
    // the pane pid and the session id are set when the session is spawned and the pid goes at the park, so they are read before
    // it: waiting for the state "live" could miss the short moment between ready and the idle park on a slow machine
    #expect(r.wait(10) { (r.entry("trip")?.pane_pid ?? 0) > 1 && r.entry("trip")?.session_id != nil }, "\(r.why("trip"))")
    let pid = try #require(r.entry("trip")?.pane_pid)
    let sid = try #require(r.entry("trip")?.session_id)
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "it went live before it parked: \(r.why("trip"))")
    #expect(r.wait(10) { r.state("trip") == "parked" }, "parked after idle")
    #expect(r.wait(5) { !ProcessInspect.groupAlive(pid) }, "process group gone")
    try r.wake("trip")
    #expect(r.wait(10) { r.starts.count == 2 })
    #expect(r.starts.last?.contains("--resume \(sid)") == true)
    #expect(r.entry("trip")?.session_id == sid)
  }

  @Test func resumeMissingFailsAndKeepsTheId() throws {
    let r = try WorkerRig(extraEnv: ["FAKE_RESUME_MISSING": "1"])
    defer { r.teardown() }
    r.makeManager(idle: 1)
    r.mgr.startTicking()
    try r.wake("trip")
    // idle is 1 s, so "live" lasts about a second and a loaded machine can step over it: wait on the event, which stays
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    let sid = try #require(r.entry("trip")?.session_id)
    #expect(r.wait(10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "resume_missing")
    #expect(r.entry("trip")?.session_id == sid)
    // a pointer for a failed worker is not typed (main answers); [Start fresh] moves the id and starts over
    try r.wake("trip", action: "fresh", ids: [])
    #expect(
      r.wait(10) { r.liveCount("trip") == 2 },
      "state \(String(describing: r.state("trip"))), error \(String(describing: r.entry("trip")?.error))")
    #expect(r.entry("trip")?.previous_ids == [sid])
    #expect(r.entry("trip")?.session_id != sid)
  }

  @Test func aDialogAtStartIsNeedsMacAndNothingIsTyped() throws {
    let r = try WorkerRig(scenario: "trust-dialog.sh")
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" })
    #expect(r.entry("trip")?.error?.code == "needs_mac")
    #expect(r.typedLines.isEmpty)
  }

  @Test func theCapParksTheLongestIdleWorker() throws {
    let r = try WorkerRig(threads: ["trip", "garden"], maxLive: 1)
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" })
    usleep(800_000)  // past the busy window
    #expect(r.wait(10) { r.state("trip") == "live" }, "idle, not busy")
    try r.wake("garden")
    #expect(r.wait(20) { r.state("garden") == "live" })
    #expect(r.wait(5) { r.state("trip") == "parked" })
    #expect(r.allEvents.contains(.parked(thread: "trip", reason: "cap")))
  }

  @Test func appRelaunchReadoptsLiveWorkersWithoutARestart() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" })
    #expect(r.wait(3) { FileManager.default.fileExists(atPath: r.talosHome + "/workers.json") })
    usleep(600_000)  // one heartbeat with pane_pid
    let pid = r.entry("trip")?.pane_pid
    r.mgr.detach()
    let again = r.makeManager()
    r.firstTick(again)
    #expect(r.state("trip") == "live")
    #expect(r.entry("trip")?.pane_pid == pid)
    #expect(r.starts.count == 1)
    #expect(again.ownedGroups.contains(pid ?? -1))
  }

  @Test func aThreadSwitchedBackToSharedIsParked() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" })
    try "{\"default_thread\":\"general\",\"threads\":[{\"id\":\"trip\",\"kind\":\"fixed\",\"session\":\"dedicated\"}]}"
      .write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    #expect(r.wait(10) { r.state("trip") == "parked" })
  }

  @Test func quitStopsEveryWorkerAndLeavesThemParked() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" })
    let pid = try #require(r.entry("trip")?.pane_pid)
    r.mgr.stopAll()
    #expect(r.state("trip") == "parked")
    #expect(!ProcessInspect.groupAlive(pid))
  }
}
