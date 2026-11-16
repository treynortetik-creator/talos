import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// The login-shell read a test hands `WorkerLaunchEnv`: how many times it ran, how long each takes and what it answers.
private final class FakeLogin: @unchecked Sendable {
  private let lock = NSLock()
  private var _calls = 0
  private var _answer: [String: String]?
  private var _delay: Double
  init(answer: [String: String]?, delay: Double = 0) {
    _answer = answer
    _delay = delay
  }
  var calls: Int { lock.withLock { _calls } }
  func set(answer: [String: String]?, delay: Double = 0) { lock.withLock { _answer = answer; _delay = delay } }
  var probe: LiveSystem {
    LiveSystem(loginEnv: { [self] in
      let (a, d) = lock.withLock { _calls += 1; return (_answer, _delay) }
      if d > 0 { Thread.sleep(forTimeInterval: d) }
      return a
    })
  }
}

private final class FakeClock: @unchecked Sendable {
  private let lock = NSLock()
  private var t: Double = 1000
  var now: Double { lock.withLock { t } }
  func advance(_ s: Double) { lock.withLock { t += s } }
}

private final class Overrides: @unchecked Sendable {
  private let lock = NSLock()
  private var v: [String: String]
  init(_ v: [String: String]) { self.v = v }
  var value: [String: String] { get { lock.withLock { v } } set { lock.withLock { v = newValue } } }
}

/// Runs `body` on a thread that is not the main one and hands back what it returned and how long it took.
private func offMain<T: Sendable>(_ body: @escaping @Sendable () -> T) async -> (T, Double) {
  await withCheckedContinuation { c in
    Thread.detachNewThread {
      let t0 = Date()
      let v = body()
      c.resume(returning: (v, Date().timeIntervalSince(t0)))
    }
  }
}

private func waitUntil(_ timeout: Double, _ cond: () -> Bool) -> Bool {
  let until = Date().addingTimeInterval(timeout * waitScale)
  while Date() < until {
    if cond() { return true }
    usleep(20_000)
  }
  return cond()
}

private let barePath = "/usr/bin:/bin"  // what launchd gives an app opened from Finder
private let pinnedPath = "/home/alex/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"
private let loginPath = "/home/alex/login/bin:/usr/bin:/bin"

@Suite("Thread sessions: the environment of each start (review R1-7)")
struct WorkerLoginEnvTests {
  private func scratchLog() -> String {
    (TestTemp.base as NSString).appendingPathComponent("talos-wle-\(UUID().uuidString.prefix(8)).log")
  }
  private func log(_ p: String) -> String { (try? String(contentsOfFile: p, encoding: .utf8)) ?? "" }

  // MARK: the main thread never waits

  @MainActor @Test func aSlowLoginShellNeverHoldsTheMainThreadAndDesktopJsonIsAlreadyOnTop() {
    #expect(Thread.isMainThread, "precondition: this test is on the main thread")
    let login = FakeLogin(answer: ["PATH": loginPath], delay: 1.5)
    let e = WorkerLaunchEnv(
      probe: login.probe, appEnv: ["PATH": barePath, "HOME": "/home/alex"],
      overrides: { ["PATH": pinnedPath, "PINNED": "yes"] }, auditLogPath: nil)
    let t0 = Date()
    e.refresh()
    let env = e.env()
    let took = Date().timeIntervalSince(t0)
    #expect(took < 0.5, "refresh() and env() held the main thread for \(took) s while the login shell was being read")
    #expect(env["PATH"] == pinnedPath && env["PINNED"] == "yes", "desktop.json env is on top before the login shell answers: \(env)")
    #expect(env["HOME"] == "/home/alex", "the app's own environment stands in underneath")
    #expect(waitUntil(5) { e.hasLoginEnv }, "the read finishes in the background")
    #expect(login.calls == 1)
  }

  // MARK: a start waits for the first read, not for the bare PATH

  @Test func aStartOffTheMainThreadWaitsForTheFirstReadInsteadOfTakingTheBarePath() async {
    let login = FakeLogin(answer: ["PATH": loginPath, "FROM_LOGIN": "1"], delay: 0.4)
    let e = WorkerLaunchEnv(probe: login.probe, appEnv: ["PATH": barePath], overrides: { ["PINNED": "yes"] }, auditLogPath: nil)
    let (env, _) = await offMain { e.env() }
    #expect(env["PATH"] == loginPath && env["FROM_LOGIN"] == "1", "the start got the login shell's PATH: \(env)")
    #expect(env["PINNED"] == "yes")
    #expect(login.calls == 1)
  }

  @Test func aLoginShellSlowerThanTheWaitGivesDesktopJsonNowAndTheLoginEnvLater() async {
    let login = FakeLogin(answer: ["PATH": loginPath, "FROM_LOGIN": "1"], delay: 1.2)
    var timing = WorkerLaunchEnv.Timing()
    timing.waitLimit = 0.15
    let e = WorkerLaunchEnv(
      probe: login.probe, appEnv: ["PATH": barePath], overrides: { ["PATH": pinnedPath] }, auditLogPath: nil, timing: timing)
    let (env, took) = await offMain { e.env() }
    #expect(took < 0.9, "the wait is bounded by waitLimit, not by the login shell: \(took) s")
    #expect(env["PATH"] == pinnedPath && env["FROM_LOGIN"] == nil, "\(env)")
    #expect(waitUntil(5) { e.hasLoginEnv })
    let (later, _) = await offMain { e.env() }
    #expect(later["FROM_LOGIN"] == "1" && later["PATH"] == pinnedPath, "the late answer is kept, desktop.json PATH still wins: \(later)")
    #expect(login.calls == 1)
  }

  // MARK: a failed read: desktop.json on top, said in the log, tried again, never remembered

  @Test func aFailedReadStillCarriesDesktopJsonsEnvAndTheLogSaysWherePathCameFrom() async {
    let path = scratchLog()
    defer { unlink(path) }
    let login = FakeLogin(answer: nil)
    let e = WorkerLaunchEnv(
      probe: login.probe, appEnv: ["PATH": barePath, "APP_ONLY": "1"], overrides: { ["PATH": pinnedPath, "PINNED": "yes"] },
      auditLogPath: path)
    let (env, _) = await offMain { e.env() }
    #expect(env["PATH"] == pinnedPath && env["PINNED"] == "yes" && env["APP_ONLY"] == "1", "\(env)")
    #expect(waitUntil(5) { log(path).contains(" workers login_env_unreadable path_from=desktop.json\n") }, "log: \(log(path))")
    #expect(!e.hasLoginEnv)
  }

  @Test func withNoPinnedPathTheLogSaysTheAppsOwnPathIsInUse() async {
    let path = scratchLog()
    defer { unlink(path) }
    let e = WorkerLaunchEnv(
      probe: FakeLogin(answer: nil).probe, appEnv: ["PATH": barePath], overrides: { ["PINNED": "yes"] }, auditLogPath: path)
    let (env, _) = await offMain { e.env() }
    #expect(env["PATH"] == barePath && env["PINNED"] == "yes")
    #expect(waitUntil(5) { log(path).contains(" workers login_env_unreadable path_from=app\n") }, "log: \(log(path))")
  }

  @Test func aFailedReadIsTriedAgainAfterTheRetryWaitAndNotBefore() async {
    let path = scratchLog()
    defer { unlink(path) }
    let login = FakeLogin(answer: nil)
    let clock = FakeClock()
    let e = WorkerLaunchEnv(
      probe: login.probe, appEnv: ["PATH": barePath], overrides: { [:] }, auditLogPath: path, clock: { clock.now })
    _ = await offMain { e.env() }
    #expect(waitUntil(5) { log(path).contains("login_env_unreadable") })
    #expect(login.calls == 1)
    // inside the retry wait: asked many times (every tmux call asks), read never
    clock.advance(29)
    for _ in 0..<20 { _ = await offMain { e.env() } }
    #expect(login.calls == 1, "a failing login shell is not run again on every ask")
    // past it: read again, and this time it works
    login.set(answer: ["PATH": loginPath])
    clock.advance(2)
    let (during, _) = await offMain { e.env() }
    #expect(during["PATH"] == barePath, "the ask that starts a retry takes the fallback: \(during)")
    #expect(waitUntil(5) { e.hasLoginEnv }, "the retry runs in the background")
    #expect(login.calls == 2)
    let (env, _) = await offMain { e.env() }
    #expect(env["PATH"] == loginPath, "the fallback was not remembered: \(env)")
    #expect(log(path).components(separatedBy: "login_env_unreadable").count == 2, "one line per failed read: \(log(path))")
  }

  /// Review R1-1: only the first read is waited for. A retry of a login shell that already failed runs in the background, so a
  /// broken shell never holds the workers' tick (or a main-thread call queued behind it) again.
  @Test func aRetryAfterAFailedReadIsNeverWaitedFor() async {
    let login = FakeLogin(answer: nil)
    let clock = FakeClock()
    let e = WorkerLaunchEnv(
      probe: login.probe, appEnv: ["PATH": barePath], overrides: { ["PATH": pinnedPath] }, auditLogPath: nil, clock: { clock.now })
    _ = await offMain { e.env() }
    #expect(waitUntil(5) { login.calls == 1 })
    usleep(60_000)  // the failed read is recorded just after the probe returns
    for round in 2...4 {
      login.set(answer: nil, delay: 0.6)  // the shell hangs, then fails again
      clock.advance(400)
      let (env, took) = await offMain { e.env() }
      #expect(took < 0.3, "retry \(round - 1) held a start for \(took) s")
      #expect(env["PATH"] == pinnedPath)
      #expect(waitUntil(5) { login.calls == round }, "the retry still ran")
      usleep(700_000)
    }
  }

  @Test func theRetryWaitDoublesAndStopsAtTheCap() async {
    let login = FakeLogin(answer: nil)
    let clock = FakeClock()
    let e = WorkerLaunchEnv(probe: login.probe, appEnv: [:], overrides: { [:] }, auditLogPath: nil, clock: { clock.now })
    /// Asks once. `due`: a read is expected, so wait for it to be recorded as failed; otherwise give a wrong one time to show.
    func ask(due: Bool) async -> Int {
      let before = login.calls
      _ = await offMain { e.env() }
      if due { _ = waitUntil(2) { login.calls > before } }
      usleep(60_000)  // the failed read is recorded just after the probe returns
      return login.calls
    }
    #expect(await ask(due: true) == 1)
    for (gap, want) in [(30.0, 2), (60.0, 3), (120.0, 4), (240.0, 5), (300.0, 6), (300.0, 7)] {
      clock.advance(gap - 1)
      #expect(await ask(due: false) == want - 1, "read again \(gap - 1) s after failure \(want - 1)")
      clock.advance(2)
      #expect(await ask(due: true) == want, "not read again \(gap + 1) s after failure \(want - 1)")
    }
  }

  // MARK: the last good read is kept and refreshed

  @Test func aGoodReadIsRefreshedWhenOldAndKeptWhenTheRefreshFails() async {
    let path = scratchLog()
    defer { unlink(path) }
    let login = FakeLogin(answer: ["PATH": loginPath, "GEN": "1"])
    let clock = FakeClock()
    let e = WorkerLaunchEnv(
      probe: login.probe, appEnv: ["PATH": barePath], overrides: { [:] }, auditLogPath: path, clock: { clock.now })
    let (first, _) = await offMain { e.env() }
    #expect(first["GEN"] == "1")
    clock.advance(899)
    _ = await offMain { e.env() }
    #expect(login.calls == 1, "a fresh read is not repeated")
    // old now: the next ask starts a read and still answers at once from the kept one
    login.set(answer: ["PATH": loginPath, "GEN": "2"], delay: 0.3)
    clock.advance(2)
    let (during, took) = await offMain { e.env() }
    #expect(during["GEN"] == "1" && took < 0.25, "a refresh never holds a start: \(took) s, \(during)")
    #expect(waitUntil(5) { e.env()["GEN"] == "2" }, "the new read replaces the old one")
    #expect(login.calls == 2)
    // the login shell breaks: the last good one stays, and the log says so
    login.set(answer: nil)
    clock.advance(901)
    _ = await offMain { e.env() }
    #expect(waitUntil(5) { log(path).contains(" workers login_env_unreadable path_from=last_good\n") }, "log: \(log(path))")
    let (after, _) = await offMain { e.env() }
    #expect(after["GEN"] == "2" && after["PATH"] == loginPath, "never back to the bare PATH once a read has worked: \(after)")
  }

  @Test func desktopJsonEnvIsReadAtEachAskNotOnce() async {
    let o = Overrides(["PATH": pinnedPath])
    let e = WorkerLaunchEnv(
      probe: FakeLogin(answer: ["PATH": loginPath]).probe, appEnv: [:], overrides: { o.value }, auditLogPath: nil)
    #expect(await offMain { e.env() }.0["PATH"] == pinnedPath)
    o.value = ["ADDED_LATER": "1"]
    let (env, _) = await offMain { e.env() }
    #expect(env["PATH"] == loginPath && env["ADDED_LATER"] == "1", "an edit to desktop.json reaches the next start: \(env)")
  }

  // MARK: one read at a time

  @Test func manyAsksAtOnceRunTheLoginShellOnce() async {
    let login = FakeLogin(answer: ["PATH": loginPath], delay: 0.3)
    let e = WorkerLaunchEnv(probe: login.probe, appEnv: ["PATH": barePath], overrides: { [:] }, auditLogPath: nil)
    let paths = await withTaskGroup(of: String?.self) { g in
      for _ in 0..<12 { g.addTask { await offMain { e.env() }.0["PATH"] } }
      var out: [String?] = []
      for await p in g { out.append(p) }
      return out
    }
    #expect(paths.allSatisfy { $0 == loginPath }, "every start waited for the one read: \(paths)")
    #expect(login.calls == 1, "the login shell ran \(login.calls) times")
  }

  // MARK: what the login shell says is data

  @Test func aSessionMarkerOrWorkerSwitchInTheLoginEnvNeverReachesAStartAndDesktopJsonCannotSetAMarker() async {
    let login = FakeLogin(answer: [
      "PATH": loginPath, "CLAUDECODE": "1", "TMUX": "/tmp/x,1,0", "ENABLE_CLAUDEAI_MCP_SERVERS": "false", "SHLVL": "3",
    ])
    let e = WorkerLaunchEnv(probe: login.probe, appEnv: [:], overrides: { ["CLAUDECODE": "1", "OK": "1"] }, auditLogPath: nil)
    let (env, _) = await offMain { e.env() }
    for k in ["CLAUDECODE", "TMUX", "ENABLE_CLAUDEAI_MCP_SERVERS", "SHLVL"] { #expect(env[k] == nil, "\(k) reached a start") }
    #expect(env["OK"] == "1" && env["PATH"] == loginPath)
  }
}

/// The real worker manager, real tmux and the fake claude, wired the way the Mac app wires them (`baseEnv: { launchEnv.env() }`).
@Suite("Thread sessions: a start with an unreadable login shell (review R1-7)", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerLoginEnvStartTests {
  @Test func aWorkerStartedWhileTheLoginShellCannotBeReadGetsDesktopJsonsPathAndEnvAndTheLogSaysSo() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let audit = r.root + "/supervisor.log"
    let pinned = "/usr/bin:/bin:/usr/sbin:/sbin:/home/alex/pinned"
    // the app's own environment: everything the rig's fake needs, and a PATH nothing can run from
    var app = r.env
    app["PATH"] = "/nonexistent-launchd-path"
    let launchEnv = WorkerLaunchEnv(
      probe: LiveSystem(loginEnv: { nil }), appEnv: app, overrides: { ["PATH": pinned, "TALOS_TEST_PINNED": "from-desktop-json"] },
      auditLogPath: audit)
    var o = r.mgr.options
    o.auditLogPath = audit
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { nil }), baseEnv: { launchEnv.env() })
    r.record(m)
    r.mgr.detach()
    r.mgr = m
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" || r.state("trip") == "busy" }, "live: \(r.why("trip"))")
    let env = r.lines(r.envLog + ".trip")
    #expect(env.contains("PATH=\(pinned)"), "the worker runs with desktop.json's PATH: \(env.filter { $0.hasPrefix("PATH=") })")
    #expect(env.contains("TALOS_TEST_PINNED=from-desktop-json"), "and the rest of desktop.json env")
    let log = (try? String(contentsOfFile: audit, encoding: .utf8)) ?? ""
    #expect(log.contains(" workers login_env_unreadable path_from=desktop.json\n"), "the fallback is in the log: \(log)")
  }

  /// Review R1-6: `desktop.json` `env` is Main's too. What marks a process as Main's bridge must not ride it into a worker.
  @Test func mainOnlyVariablesInDesktopJsonEnvNeverReachAWorker() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    // only desktop.json carries them here
    let app = r.env.filter { !["TALOS_APP_BRIDGE", "MCP_PROTOCOL_NEGOTIATION", "TELEGRAM_BOT_TOKEN"].contains($0.key) }
    let launchEnv = WorkerLaunchEnv(
      probe: LiveSystem(loginEnv: { app }), appEnv: app,
      overrides: {
        ["TALOS_APP_BRIDGE": "1", "MCP_PROTOCOL_NEGOTIATION": "legacy", "TELEGRAM_BOT_TOKEN": "123:not-a-real-token", "TALOS_TEST_PINNED": "yes"]
      }, auditLogPath: nil)
    let m = WorkerManager(options: r.mgr.options, probe: LiveSystem(loginEnv: { app }), baseEnv: { launchEnv.env() })
    r.record(m)
    r.mgr.detach()
    r.mgr = m
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" || r.state("trip") == "busy" }, "live: \(r.why("trip"))")
    let env = r.lines(r.envLog + ".trip")
    #expect(env.contains("TALOS_TEST_PINNED=yes"), "precondition: desktop.json env reached the worker: \(env)")
    for k in ["TALOS_APP_BRIDGE", "MCP_PROTOCOL_NEGOTIATION", "TELEGRAM_BOT_TOKEN"] {
      #expect(!env.contains { $0.hasPrefix(k + "=") }, "\(k) from desktop.json env is in the worker's environment")
    }
  }

  /// Review R1-2: the first login-shell read failed and `desktop.json` pins no PATH, so the only PATH is the app's bare one and
  /// claude is not on it. The start is held, not launched into a crash loop, and goes ahead once the login shell answers.
  @Test func withNoLoginEnvAndNoClaudeOnThePathAStartIsHeldUntilTheLoginShellAnswers() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let audit = r.root + "/supervisor.log"
    var app = r.env
    app["PATH"] = "/nonexistent-launchd-path"
    var good = r.env
    good["PATH"] = Rig.fixtures + ":/usr/bin:/bin:/usr/sbin:/sbin"
    let login = FakeLogin(answer: nil)
    let clock = FakeClock()
    let launchEnv = WorkerLaunchEnv(probe: login.probe, appEnv: app, overrides: { [:] }, auditLogPath: audit, clock: { clock.now })
    var o = r.mgr.options
    o.auditLogPath = audit
    o.claudePath = "claude"  // "auto" before the login shell has said where claude is
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { nil }), baseEnv: { launchEnv.env() })
    m.hasLoginEnv = { launchEnv.hasLoginEnv }
    r.record(m)
    r.mgr.detach()
    r.mgr = m
    m.startTicking()
    try r.wake("trip")
    usleep(1_500_000)  // several ticks
    let started: (WorkerManager.Event) -> Bool = { if case .started = $0 { return true } else { return false } }
    #expect(!r.allEvents.contains(where: started), "launched on the bare PATH: \(r.allEvents)")
    #expect(r.state("trip") != "failed", "a held start is not a failure: \(r.why("trip"))")
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/launch.sh"), "nothing is written for a held start")
    let log = { (try? String(contentsOfFile: audit, encoding: .utf8)) ?? "" }
    #expect(log().components(separatedBy: " worker_start_held thread=trip ").count == 2, "said once, with why: \(log())")
    // the login shell comes back: the held start goes ahead by itself, with the login PATH
    login.set(answer: good)
    clock.advance(31)
    #expect(r.wait(15) { r.state("trip") == "live" || r.state("trip") == "busy" }, "live: \(r.why("trip")), log: \(log())")
    #expect(r.lines(r.envLog + ".trip").contains("PATH=" + good["PATH"]!))
  }

  /// The other half: a claude that does resolve (an absolute path, or one on a pinned PATH) starts without the login shell.
  @Test func withNoLoginEnvAClaudeThatResolvesStillStarts() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let app = r.env
    let launchEnv = WorkerLaunchEnv(probe: LiveSystem(loginEnv: { nil }), appEnv: app, overrides: { [:] }, auditLogPath: nil)
    let m = WorkerManager(options: r.mgr.options, probe: LiveSystem(loginEnv: { nil }), baseEnv: { launchEnv.env() })
    m.hasLoginEnv = { launchEnv.hasLoginEnv }
    r.record(m)
    r.mgr.detach()
    r.mgr = m
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" || r.state("trip") == "busy" }, "live: \(r.why("trip"))")
  }
}
