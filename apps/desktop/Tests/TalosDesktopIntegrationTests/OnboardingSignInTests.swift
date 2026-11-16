import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// The first-run steps against FAKE claude, bun, tmux and brew executables in a temp folder. The real `claude` is never run.
/// The fakes are shell scripts driven by files in their own folder (`auth-ok`, `login-runs`), so a test reads what they saw.
final class FakeTools {
  let dir = TestTemp.base + "onboarding-fakes-\(UUID().uuidString)"
  var bin: String { dir + "/bin" }
  var claude: String { bin + "/claude" }
  var env: [String: String] { ["PATH": bin + ":/usr/bin:/bin", "FAKE_DIR": dir] }

  init(claude: String? = FakeTools.defaultClaude, bun: String? = "echo 1.4.4", tmux: String? = "echo 'tmux 3.5a'", brew: String? = nil) throws {
    try FileManager.default.createDirectory(atPath: bin, withIntermediateDirectories: true)
    for (name, body) in [("claude", claude), ("bun", bun), ("tmux", tmux), ("brew", brew)] {
      guard let body else { continue }
      try ("#!/bin/bash\n" + body + "\n").write(toFile: bin + "/" + name, atomically: true, encoding: .utf8)
      chmod(bin + "/" + name, 0o755)
    }
  }

  func remove() { try? FileManager.default.removeItem(atPath: dir) }
  func exists(_ name: String) -> Bool { FileManager.default.fileExists(atPath: dir + "/" + name) }
  func read(_ name: String) -> String { (try? String(contentsOfFile: dir + "/" + name, encoding: .utf8)) ?? "" }
  func signOut() { try? FileManager.default.removeItem(atPath: dir + "/auth-ok") }
  func signIn() { FileManager.default.createFile(atPath: dir + "/auth-ok", contents: Data()) }

  /// `--version`; `auth status [--json]` exits 0 with {"loggedIn":true} only when `auth-ok` exists (FAKE_STATUS_HANG=1: it never
  /// answers); `auth login` runs in a pty like the real one and, per FAKE_LOGIN: `ok` (browser redirect: signs in after
  /// FAKE_LOGIN_DELAY), `url` (prints the sign-in URL, signs in once the file `opened` exists), `paste` (prints the URL and a
  /// "Paste code here" prompt, reads a line, writes it to `code-received`, signs in only for GOODCODE), `fail`, `hang`. It prints
  /// a fake secret and starts a background child, to show neither is read and the child dies with the group. `urlfail` prints the URL
  /// and fails once the file `url-seen` exists (the test writes it when the link reached the screen; 15 s at most), so the link is
  /// on the screen for as long as a busy machine needs to show it, and the login still ends.
  static let defaultClaude = """
    case "$1 $2" in
      "--version "*) echo "2.1.312 (Claude Code)"; exit 0 ;;
      "auth status") echo status >> "$FAKE_DIR/events"; [ "${FAKE_STATUS_HANG:-}" = 1 ] && exec sleep 60
        [ -f "$FAKE_DIR/auth-ok" ] && { echo '{"loggedIn":true,"token":"SECRET-TOKEN-123"}'; exit 0; }
        echo '{"loggedIn":false}'; exit 1 ;;
      "auth login") echo $$ > "$FAKE_DIR/login-runs"; echo x >> "$FAKE_DIR/login-starts"; sleep 60 & echo $! > "$FAKE_DIR/child-pid"
        URL='https://claude.ai/oauth/authorize?code=true&client_id=abc&state=SECRETSTATE'
        case "${FAKE_LOGIN:-ok}" in
          ok) echo "Opening browser to sign in..."; sleep "${FAKE_LOGIN_DELAY:-0.3}"; touch "$FAKE_DIR/auth-ok"; exit 0 ;;
          url) echo "Opening browser to sign in..."; echo "If the browser did not open, visit:"; echo "$URL"
            while [ ! -f "$FAKE_DIR/opened" ]; do sleep 0.1; done; touch "$FAKE_DIR/auth-ok"; exit 0 ;;
          paste) echo "Opening browser to sign in..."; echo "$URL"; printf 'Paste code here if prompted > '
            read -r code; echo "$code" > "$FAKE_DIR/code-received"
            [ "$code" = GOODCODE ] && { touch "$FAKE_DIR/auth-ok"; exit 0; }; exit 1 ;;
          fail) echo login-ended >> "$FAKE_DIR/events"; exit 1 ;;
          urlfail) echo "$URL"; n=0; while [ ! -f "$FAKE_DIR/url-seen" ] && [ $n -lt 300 ]; do sleep 0.05; n=$((n+1)); done; exit 1 ;;
          hang) exec sleep 60 ;;
        esac ;;
    esac
    exit 2
    """
}

final class ScreenLog: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [ClaudeLoginScreen] = []
  func add(_ s: ClaudeLoginScreen) { lock.withLock { items.append(s) } }
  var all: [ClaudeLoginScreen] { lock.withLock { items } }
  var url: String? { all.compactMap(\.url).last }
  var wantsCode: Bool { all.contains { $0.wantsCode } }
}

@Suite("Onboarding: Sign in to Claude", .serialized)
struct OnboardingSignInTests {
  private func env(_ t: FakeTools, _ extra: [String: String] = [:]) -> [String: String] { t.env.merging(extra) { _, new in new } }

  @Test func alreadySignedInIsDoneWithoutOpeningALogin() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    t.signIn()
    let o = await ClaudeSignIn.run(claude: t.claude, env: env(t), interval: 0.1, limit: 5)
    #expect(o == .alreadySignedIn)
    #expect(!t.exists("login-runs"), "no login was started")
  }

  @Test func notSignedInRunsLoginThenPollsUntilStatusSaysYes() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let o = await ClaudeSignIn.run(claude: t.claude, env: env(t, ["FAKE_LOGIN": "ok", "FAKE_LOGIN_DELAY": "0.5"]), interval: 0.1, limit: 20)
    #expect(o == .signedIn)
    #expect(t.exists("login-runs"))
    #expect(!o.message.contains("SECRET"))
  }

  @Test func theLoginEndingWithoutSigningInIsAClearErrorNotAWait() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    // "Not a wait" is counted, not timed: the fake writes down each status check and the moment the login ended, in order, and a run
    // that says so at once makes at most two checks after that moment (one that was already on its way when the login ended, and the
    // one made because it ended). A run that waited would make one more every 0.1 s. The old bound was 10 s of wall clock for three or
    // four child processes, which a busy machine can take with the whole suite running beside it; the time is still checked, against
    // the limit itself (half of 120 s), so a run that sat on the right answer for most of the limit fails too.
    let limit = 120.0
    let start = Date()
    let o = await ClaudeSignIn.run(claude: t.claude, env: env(t, ["FAKE_LOGIN": "fail"]), interval: 0.1, limit: limit)
    #expect(o == .loginEndedNotSignedIn)
    let events = t.read("events").split(separator: "\n").map(String.init)
    let ended = try #require(events.firstIndex(of: "login-ended"), "control: the login ran and ended: \(events)")
    let after = events[(ended + 1)...].filter { $0 == "status" }.count
    #expect((1...2).contains(after), "\(after) status checks after the login had ended: it waited instead of saying so (\(events))")
    #expect(Date().timeIntervalSince(start) < limit / 2, "does not wait out the clock")
    #expect(!o.message.contains("SECRET"))
  }

  @Test func theTimeLimitEndsThePollAndTheLoginProcess() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let o = await ClaudeSignIn.run(claude: t.claude, env: env(t, ["FAKE_LOGIN": "hang"]), interval: 0.1, limit: 1.0)
    #expect(o == .timedOut)
    let pid = Int32(t.read("login-runs").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    #expect(pid > 0)
    try await Task.sleep(nanoseconds: 500_000_000)
    #expect(kill(pid, 0) != 0, "the login this started is not left running")
  }

  @Test func aStatusThatNeverAnswersIsTimedOutAsUnknownNotSignedOut() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let o = await ClaudeSignIn.run(
      claude: t.claude, env: env(t, ["FAKE_STATUS_HANG": "1", "FAKE_LOGIN": "hang"]), interval: 0.1, limit: 1.5, statusTimeout: 0.4)
    #expect(o == .statusUnknown)
    #expect(ClaudeSignIn.check(claude: t.claude, env: env(t, ["FAKE_STATUS_HANG": "1"]), timeout: 0.4) == .unknown)
  }

  @Test func cancelStopsThePollAndTheLogin() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let e = env(t, ["FAKE_LOGIN": "hang"])
    let claude = t.claude
    let task = Task { await ClaudeSignIn.run(claude: claude, env: e, interval: 0.1, limit: 60) }
    for _ in 0..<100 where !t.exists("login-runs") { try await Task.sleep(nanoseconds: 50_000_000) }
    #expect(t.exists("login-runs"))
    task.cancel()
    #expect(await task.value == .cancelled)
    let pid = Int32(t.read("login-runs").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    try await Task.sleep(nanoseconds: 500_000_000)
    #expect(kill(pid, 0) != 0, "cancel ends the login this started")
  }

  // MARK: the three ways the real login goes (the login runs in a pty; the screen is read, never logged)

  @Test func browserRedirectJustFlipsStatus() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let log = ScreenLog()
    let o = await ClaudeSignIn.run(
      claude: t.claude, env: env(t, ["FAKE_LOGIN": "ok", "FAKE_LOGIN_DELAY": "0.5"]), interval: 0.1, limit: 20,
      session: ClaudeLoginSession(claude: t.claude, env: env(t, ["FAKE_LOGIN": "ok", "FAKE_LOGIN_DELAY": "0.5"])), onScreen: { log.add($0) })
    #expect(o == .signedIn)
    #expect(t.exists("login-runs"))
    #expect(!log.wantsCode, "no code was asked for")
  }

  @Test func urlOnlyShowsTheUrlTheOwnerOpensAndStatusFlips() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let e = env(t, ["FAKE_LOGIN": "url"])
    let log = ScreenLog()
    let claude = t.claude
    let dir = t.dir
    let task = Task {
      await ClaudeSignIn.run(
        claude: claude, env: e, interval: 0.1, limit: 30, session: ClaudeLoginSession(claude: claude, env: e),
        onScreen: { s in
          log.add(s)
          if s.url != nil { FileManager.default.createFile(atPath: dir + "/opened", contents: Data()) }  // the owner opened it
        })
    }
    #expect(await task.value == .signedIn)
    #expect(log.url == "https://claude.ai/oauth/authorize?code=true&client_id=abc&state=SECRETSTATE")
    #expect(!log.wantsCode)
    for s in log.all { #expect(!"\(s)".contains("SECRETSTATE") && !"\(s)".contains("client_id"), "the URL's query never reaches a log line") }
  }

  @Test func pasteCodeIsTypedIntoThePtyThenStatusFlips() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let e = env(t, ["FAKE_LOGIN": "paste"])
    let log = ScreenLog()
    let session = ClaudeLoginSession(claude: t.claude, env: e)
    let claude = t.claude
    let typed = ScreenLog()
    let task = Task {
      await ClaudeSignIn.run(
        claude: claude, env: e, interval: 0.1, limit: 30, session: session,
        onScreen: { s in
          log.add(s)
          if s.wantsCode, typed.all.isEmpty {
            typed.add(s)
            session.submit(code: "GOODCODE")
          }
        })
    }
    #expect(await task.value == .signedIn)
    #expect(log.wantsCode && log.url != nil)
    #expect(t.read("code-received").trimmingCharacters(in: .whitespacesAndNewlines) == "GOODCODE", "the code reached the CLI through the pty")
    for s in log.all { #expect(!"\(s)".contains("GOODCODE")) }
  }

  @Test func aWrongCodeEndsTheLoginAsNotSignedIn() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let e = env(t, ["FAKE_LOGIN": "paste"])
    let session = ClaudeLoginSession(claude: t.claude, env: e)
    let claude = t.claude
    let sent = ScreenLog()
    let o = await ClaudeSignIn.run(
      claude: claude, env: e, interval: 0.1, limit: 30, session: session,
      onScreen: { s in if s.wantsCode, sent.all.isEmpty { sent.add(s); session.submit(code: "WRONG") } })
    #expect(o == .loginEndedNotSignedIn)
  }

  @Test func cancelAndTimeoutKillThePtyAndItsWholeGroup() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let e = env(t, ["FAKE_LOGIN": "hang"])
    let claude = t.claude
    let task = Task { await ClaudeSignIn.run(claude: claude, env: e, interval: 0.1, limit: 60, session: ClaudeLoginSession(claude: claude, env: e)) }
    for _ in 0..<100 where !t.exists("child-pid") { try await Task.sleep(nanoseconds: 50_000_000) }
    let pid = Int32(t.read("login-runs").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    let child = Int32(t.read("child-pid").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    #expect(pid > 0 && child > 0 && kill(pid, 0) == 0)
    task.cancel()
    #expect(await task.value == .cancelled)
    try await Task.sleep(nanoseconds: 700_000_000)
    #expect(kill(pid, 0) != 0 && kill(child, 0) != 0, "the login and its background child are gone")

    let t2 = try FakeTools()
    defer { t2.remove() }
    let e2 = env(t2, ["FAKE_LOGIN": "hang"])
    let o = await ClaudeSignIn.run(claude: t2.claude, env: e2, interval: 0.1, limit: 1.0, session: ClaudeLoginSession(claude: t2.claude, env: e2))
    #expect(o == .timedOut)
    let child2 = Int32(t2.read("child-pid").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    try await Task.sleep(nanoseconds: 700_000_000)
    #expect(child2 > 0 && kill(child2, 0) != 0, "a timeout kills the group too")
  }

  // MARK: one sign-in for the whole app, gone when the app quits

  @Test func reopeningTheWindowFindsTheSameSignInAndNeverStartsASecondLogin() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let c = ClaudeSignInCoordinator()
    defer { c.stopNow() }
    let e = env(t, ["FAKE_LOGIN": "hang"])
    #expect(c.start(claude: t.claude, env: e, interval: 0.1, limit: 60))
    for _ in 0..<100 where !t.exists("login-runs") { try await Task.sleep(nanoseconds: 50_000_000) }
    // the window closes and a new one opens: it asks again
    #expect(!c.start(claude: t.claude, env: e, interval: 0.1, limit: 60), "a second start is refused")
    #expect(c.isRunning)
    if case .waiting = c.state {} else { Issue.record("the reopened window sees a sign-in in progress: \(c.state)") }
    try await Task.sleep(nanoseconds: 500_000_000)
    #expect(t.read("login-starts").split(separator: "\n").count == 1, "one login only")
  }

  @Test func aFinishedSignInIsClearedAndCanStartAgain() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    t.signIn()
    let c = ClaudeSignInCoordinator()
    defer { c.stopNow() }
    #expect(c.start(claude: t.claude, env: env(t), interval: 0.1, limit: 5))
    for _ in 0..<200 where c.isRunning { try await Task.sleep(nanoseconds: 20_000_000) }
    #expect(c.state == .finished(.alreadySignedIn))
    c.reset()
    #expect(c.state == .idle, "a stale result can be dropped")
    t.signOut()
    #expect(c.start(claude: t.claude, env: env(t, ["FAKE_LOGIN": "hang"]), interval: 0.1, limit: 60), "and a new sign-in starts")
  }

  @Test func aLoginStoppedBeforeItStartsNeverLaunches() throws {
    let t = try FakeTools()
    defer { t.remove() }
    let s = ClaudeLoginSession(claude: t.claude, env: env(t, ["FAKE_LOGIN": "hang"]))
    s.stop()  // the quit came first
    #expect(throws: (any Error).self) { try s.start() }
    #expect(!t.exists("login-runs"), "claude auth login was never run")
  }

  @Test func aStatusThatCannotAnswerAfterTheLoginEndedIsNotReportedAsAFailedSignIn() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let o = await ClaudeSignIn.run(
      claude: t.claude, env: env(t, ["FAKE_STATUS_HANG": "1", "FAKE_LOGIN": "fail"]), interval: 0.1, limit: 2, statusTimeout: 0.3)
    #expect(o == .statusUnknown, "the login ended but status never said no: keep asking, then say it could not tell")
  }

  @Test func aLoginThatEndedShowsNoLinkOrCodeBoxWhileStatusStaysSilent() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let log = ScreenLog()
    // Status never answers, so the run lasts exactly `limit`, and the last screen it shows is the one at the limit. The login prints
    // the link and ends once the link has been on the screen (`url-seen`), which must be well before the limit, or that last screen is
    // still the link. It was a fixed 0.6 s and a 3 s limit: beside the whole suite, where every 0.3 s status check that never answers
    // holds up the next look at the screen, the link could come and go between two looks, or the login outlive the limit.
    let seen = t.dir + "/url-seen"
    let o = await ClaudeSignIn.run(
      claude: t.claude, env: env(t, ["FAKE_STATUS_HANG": "1", "FAKE_LOGIN": "urlfail"]), interval: 0.1, limit: 10, statusTimeout: 0.3,
      onScreen: { s in
        log.add(s)
        if s.url != nil { FileManager.default.createFile(atPath: seen, contents: nil) }
      })
    #expect(o == .statusUnknown)
    #expect(log.url != nil, "the link showed while the login ran")
    #expect(log.all.last == ClaudeLoginScreen(), "and is gone once it ended")
  }

  @Test func quittingEndsTheLoginAndItsGroup() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let c = ClaudeSignInCoordinator()
    #expect(c.start(claude: t.claude, env: env(t, ["FAKE_LOGIN": "hang"]), interval: 0.1, limit: 60))
    for _ in 0..<100 where !t.exists("child-pid") { try await Task.sleep(nanoseconds: 50_000_000) }
    let pid = Int32(t.read("login-runs").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    let child = Int32(t.read("child-pid").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    #expect(pid > 0 && child > 0 && kill(pid, 0) == 0)
    c.stopNow()  // what willTerminate calls: gone before it returns
    #expect(kill(pid, 0) != 0 && kill(child, 0) != 0, "the login and its child are gone when stopNow returns")
  }

  @Test func cancelDoesNotWaitOutARunningStatusCheck() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let e = env(t, ["FAKE_STATUS_HANG": "1", "FAKE_LOGIN": "hang"])
    let claude = t.claude
    let task = Task { await ClaudeSignIn.run(claude: claude, env: e, interval: 0.1, limit: 60, statusTimeout: 10) }
    try await Task.sleep(nanoseconds: 300_000_000)
    let start = Date()
    task.cancel()
    #expect(await task.value == .cancelled)
    #expect(Date().timeIntervalSince(start) < 3, "cancel returned without waiting for the 10 s check")
  }

  @Test func retryAfterAFailureWorks() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    #expect(await ClaudeSignIn.run(claude: t.claude, env: env(t, ["FAKE_LOGIN": "fail"]), interval: 0.1, limit: 10) == .loginEndedNotSignedIn)
    #expect(await ClaudeSignIn.run(claude: t.claude, env: env(t, ["FAKE_LOGIN": "ok", "FAKE_LOGIN_DELAY": "0.3"]), interval: 0.1, limit: 10) == .signedIn)
  }

  @Test func claudeIsNeverRunByABareNameOrWhenMissing() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    #expect(await ClaudeSignIn.run(claude: nil, env: env(t)) == .noClaude)
    #expect(await ClaudeSignIn.run(claude: "claude", env: env(t)) == .noClaude, "a bare name would be found on PATH: refused")
    #expect(await ClaudeSignIn.run(claude: t.dir + "/nope", env: env(t)) == .noClaude)
    #expect(ClaudeSignIn.check(claude: "claude", env: env(t)) == .unknown)
    #expect(!t.exists("login-runs"))
  }

  @Test func nothingTheCliPrintsReachesTheOutcomeOrTheSupervisorLog() async throws {
    let t = try FakeTools()
    defer { t.remove() }
    let outcomes: [ClaudeSignInPlan.Outcome] = [
      await ClaudeSignIn.run(claude: t.claude, env: env(t, ["FAKE_LOGIN": "fail"]), interval: 0.1, limit: 10),
      await ClaudeSignIn.run(claude: t.claude, env: env(t, ["FAKE_LOGIN": "ok", "FAKE_LOGIN_DELAY": "0.2"]), interval: 0.1, limit: 10),
    ]
    for o in outcomes { #expect(!"\(o)".contains("SECRET") && !o.message.contains("SECRET")) }
  }
}

@Suite("Onboarding: the tools Talos needs", .serialized)
struct OnboardingPrereqTests {
  private func probe(_ t: FakeTools, home: String? = nil) -> PrereqProbe.Found {
    // Only the fake folder counts as executable: this Mac's real tmux, bun and brew must not be found.
    PrereqProbe.probe(env: t.env, home: home ?? t.dir + "/home", isExecutable: { $0.hasPrefix(t.bin + "/") && FileManager.default.isExecutableFile(atPath: $0) })
  }

  @Test func allThreeAreFoundByAbsolutePathWithVersions() throws {
    let t = try FakeTools()
    defer { t.remove() }
    let f = probe(t)
    #expect(f.claude == .init(path: t.bin + "/claude", version: "2.1.312"))
    #expect(f.bun == .init(path: t.bin + "/bun", version: "1.4.4"))
    #expect(f.tmux == .init(path: t.bin + "/tmux", version: "3.5a"))
    #expect(f.brew == nil)
    for p in [f.claude?.path, f.bun?.path, f.tmux?.path] { #expect(p?.hasPrefix("/") == true) }
  }

  @Test func bunMissingIsAFixWithAPageNotACommand() throws {
    let t = try FakeTools(bun: nil)
    defer { t.remove() }
    let f = probe(t)
    #expect(f.bun == nil && f.claude != nil && f.tmux != nil)
    let rows = FirstRun.rows(.init(claudeVersion: f.claude?.version, bunPath: f.bun?.path, tmuxVersionOutput: "tmux 3.5a", home: "/u"))
    guard case .fix(let m)? = rows.first(where: { $0.id == "bun" })?.state else { Issue.record("bun should be a fix"); return }
    #expect(m.contains("bun.sh"))
    #expect(PrereqPlan.fix(for: "bun", brew: nil) == .openPage(label: OnboardingText.openBunPage, url: "https://bun.sh"))
  }

  @Test func tmuxMissingOffersBrewWhenThereIsBrewElseTheBrewPage() throws {
    let t = try FakeTools(tmux: nil, brew: "echo $@ > \"$FAKE_DIR/brew-args\"; exit 0")
    defer { t.remove() }
    let f = probe(t)
    #expect(f.tmux == nil && f.brew == t.bin + "/brew")
    let fix = try #require(PrereqPlan.fix(for: "tmux", brew: f.brew))
    #expect(PrereqProbe.runFix(fix, env: t.env) == nil)
    #expect(t.read("brew-args").trimmingCharacters(in: .whitespacesAndNewlines) == "install tmux")
    let t2 = try FakeTools(tmux: nil)
    defer { t2.remove() }
    #expect(PrereqPlan.fix(for: "tmux", brew: probe(t2).brew) == .openPage(label: OnboardingText.openBrewPage, url: "https://brew.sh"))
  }

  @Test func homebrewsOwnFolderBeatsAnythingOnThePath() throws {
    let t = try FakeTools(brew: "exit 0")
    defer { t.remove() }
    let f = PrereqProbe.probe(
      env: t.env, home: t.dir + "/home", isExecutable: { $0 == "/opt/homebrew/bin/brew" || $0.hasPrefix(t.bin + "/") })
    #expect(f.brew == "/opt/homebrew/bin/brew", "not a brew that happens to be first on the login PATH")
  }

  @Test func aFailedBrewInstallSaysSoAndRootIsRefusedWithoutRunningAnything() throws {
    let t = try FakeTools(tmux: nil, brew: "touch \"$FAKE_DIR/brew-ran\"; exit 1")
    defer { t.remove() }
    let fix = PrereqPlan.Fix.brewInstall(label: "x", brew: t.bin + "/brew", formula: "tmux")
    #expect(PrereqProbe.runFix(fix, env: t.env) == OnboardingText.brewFailed)
    try FileManager.default.removeItem(atPath: t.dir + "/brew-ran")
    #expect(PrereqProbe.runFix(fix, env: t.env, uid: 0) == OnboardingText.brewRefusedRoot)
    #expect(!t.exists("brew-ran"), "never run as root")
  }

  @Test func claudeMissingMeansNoSignInAndAnInstallPage() async throws {
    let t = try FakeTools(claude: nil)
    defer { t.remove() }
    let f = probe(t)
    #expect(f.claude == nil)
    #expect(await ClaudeSignIn.run(claude: f.claude?.path, env: t.env) == .noClaude)
    #expect(PrereqPlan.fix(for: "claude", brew: nil) == .openPage(label: OnboardingText.openClaudePage, url: "https://claude.com/claude-code"))
  }
}
