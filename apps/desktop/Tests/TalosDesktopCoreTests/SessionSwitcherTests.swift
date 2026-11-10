import Foundation
import Testing
@testable import TalosDesktopCore

/// ITEM 1: the Terminals window's list, the pure half.
@Suite("Session switcher model")
struct SessionSwitcherTests {
  func file(_ entries: [String: (state: String, error: String?)]) -> WorkersFile {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-05T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    for (id, v) in entries {
      var e = WorkersFile.Entry(threadId: id, cwd: "/home/alex/proj-\(id)")
      e.state = v.state
      if let code = v.error { e.error = .init(code: code, detail: "boom", at: "2026-11-05T00:00:00Z") }
      f.threads[id] = e
    }
    return f
  }
  let running = SessionSwitcher.MainFacts(state: .running, hasScreen: true)

  @Test func listsMainFirstThenEveryThreadByNameWithItsBadge() {
    let f = file([
      "b": ("busy", nil), "a": ("live", nil), "c": ("parked", nil), "d": ("stopping", nil), "e": ("failed", "crash_loop"),
      "g": ("parking", nil),
    ])
    let es = SessionSwitcher.entries(main: running, workers: f, names: ["a": "Zeta", "b": "alpha", "c": "Mid", "d": "Dee", "e": "Eve"])
    #expect(es.map(\.title) == ["Main", "alpha", "Dee", "Eve", "g", "Mid", "Zeta"])
    let byId = Dictionary(uniqueKeysWithValues: es.map { ($0.id, $0.badge) })
    #expect(byId["main"] == .live)
    #expect(byId["b"] == .working)
    #expect(byId["a"] == .idle)
    #expect(byId["c"] == .parked)
    #expect(byId["d"] == .stopping)
    #expect(byId["g"] == .stopping)
    #expect(byId["e"] == .failed)
    #expect(es.map(\.badge.text).contains("Needs you") == false)
  }

  @Test func aWorkerWaitingOnAPromptShowsNeedsYouAndAStoppedDialogDoes() {
    let f = file(["q": ("starting", nil), "r": ("failed", "needs_mac"), "s": ("parked", nil)])
    let es = SessionSwitcher.entries(main: running, workers: f, needsYou: ["q": "trust this folder", "s": "stale"])
    let byId = Dictionary(uniqueKeysWithValues: es.map { ($0.id, $0) })
    #expect(byId["q"]?.badge == .needsYou)
    #expect(byId["q"]?.detail.contains("trust this folder") == true)
    #expect(byId["r"]?.badge == .needsYou)
    // a flag for a worker with no process behind it is stale: shown as what it is
    #expect(byId["s"]?.badge == .parked)
    let main = SessionSwitcher.entries(main: .init(state: .running, hasScreen: true, needsYou: "dev-channel warning"), workers: nil)
    #expect(main.first?.badge == .needsYou)
  }

  @Test func mainStatesAndNoWorkersFile() {
    #expect(SessionSwitcher.entries(main: .init(state: .notStarted, hasScreen: false), workers: nil).map(\.badge) == [.notStarted])
    #expect(SessionSwitcher.entries(main: .init(state: .stopped(failure: "Talos couldn't start"), hasScreen: true), workers: nil)[0].badge == .failed)
    #expect(SessionSwitcher.entries(main: .init(state: .stopped(failure: nil), hasScreen: true), workers: nil)[0].badge == .parked)
  }

  /// One entry that can't be read costs that entry only.
  @Test func oneBadEntryNeverCostsTheList() {
    var f = file(["a": ("live", nil)])
    f.threads["Not A Thread"] = WorkersFile.Entry(threadId: "ok", cwd: "/x")
    var unknown = WorkersFile.Entry(threadId: "u", cwd: "/x")
    unknown.state = "hovering"  // a state a newer copy might write
    f.threads["u"] = unknown
    let es = SessionSwitcher.entries(main: running, workers: f)
    #expect(es.map(\.id) == ["main", "a", "u"])
    #expect(es.last?.badge == .unknown)
    #expect(es.last?.canAttach == true, "an unknown state may be running")
  }

  /// R1-7: the session an entry attaches to is derived from the thread id; the `tmux` field in workers.json is never used.
  @Test func theSessionNameComesFromTheIdNeverFromTheFile() throws {
    var f = file(["trip": ("live", nil), "garden": ("live", nil)])
    f.threads["trip"]?.tmux = "agent"  // a file that points trip at main's session
    f.threads["garden"]?.tmux = "bad name; rm -rf"
    let es = SessionSwitcher.entries(main: running, workers: f)
    let trip = try #require(es.first { $0.id == "trip" })
    let garden = try #require(es.first { $0.id == "garden" })
    #expect(trip.tmuxSession == "t-trip")
    #expect(garden.tmuxSession == "t-garden")
    #expect(SessionSwitcher.attachArgv(for: trip, tmux: "/t", socket: "s", configPath: "/c")?.last == "=t-trip")
    #expect(ThreadSessions.rows(from: f).first { $0.threadId == "trip" }?.tmuxSession == "t-trip")
    #expect(SessionSwitcher.content(for: trip, workers: f) == .attach(session: "t-trip"))
  }

  @Test func hostileNamesAreCleaned() {
    let f = file(["a": ("live", nil)])
    let n = "evil\u{1B}[2J\n" + String(repeating: "x", count: 100)
    let t = SessionSwitcher.entries(main: running, workers: f, names: ["a": n])[1].title
    #expect(!t.contains("\u{1B}") && !t.contains("\n"))
    #expect(t.count <= 40)
    #expect(SessionSwitcher.entries(main: running, workers: f, names: ["a": "\u{7}\u{7}"])[1].title == "a")
  }

  /// Picking an entry: parked offers Resume, failed shows the error, live attaches the right tmux session.
  @Test func whatEachEntryShowsWhenPicked() throws {
    let f = file(["live1": ("live", nil), "p": ("parked", nil), "o": ("off", nil), "x": ("failed", "resume_missing")])
    let es = SessionSwitcher.entries(main: running, workers: f)
    func content(_ id: String) -> SwitcherContent { SessionSwitcher.content(for: es.first { $0.id == id }!, workers: f) }
    #expect(content("main") == .attach(session: "agent"))
    #expect(content("live1") == .attach(session: "t-live1"))
    #expect(content("p") == .resume(thread: "p", label: "Resume"))
    #expect(content("o") == .resume(thread: "o", label: "Start"))
    guard case .failed(let title, let detail) = content("x") else { Issue.record("not failed"); return }
    #expect(title.contains("x") && detail.contains("resume_missing") && detail.contains("boom"))
    let noScreen = SessionSwitcher.entries(main: .init(state: .notStarted, hasScreen: false), workers: nil)
    if case .note(let t) = SessionSwitcher.content(for: noScreen[0], workers: nil) { #expect(t.contains("Start session")) } else {
      Issue.record("main with no session should be a note")
    }
  }

  /// The switch targets the picked entry's own session by exact name, on the Talos socket, never another thread's.
  @Test func theSwitchActionTargetsTheRightTmuxSession() throws {
    let f = file(["trip": ("live", nil), "garden": ("busy", nil), "p": ("parked", nil)])
    let es = SessionSwitcher.entries(main: running, workers: f)
    func argv(_ id: String) -> [String]? {
      SessionSwitcher.attachArgv(for: es.first { $0.id == id }!, tmux: "/opt/tmux", socket: "talos-test-1", configPath: "/c/tmux.conf")
    }
    let trip = try #require(argv("trip"))
    #expect(trip.starts(with: ["/opt/tmux", "-L", "talos-test-1", "-f", "/c/tmux.conf"]))
    #expect(trip.suffix(3) == ["attach-session", "-t", "=t-trip"])
    #expect(try #require(argv("garden")).last == "=t-garden")
    #expect(try #require(argv("main")).last == "=agent")
    #expect(argv("p") == nil, "a parked thread has nothing to attach to")
  }

  @Test func commandNumbersSwitchEntriesOneToNine() {
    let ids = (1...11).map { "t\($0)" }
    let f = file(Dictionary(uniqueKeysWithValues: ids.map { ($0, ("live", nil as String?)) }))
    let es = SessionSwitcher.entries(main: running, workers: f)
    #expect(SessionSwitcher.entry(forShortcut: 1, in: es)?.id == "main")
    #expect(SessionSwitcher.entry(forShortcut: 2, in: es)?.id == es[1].id)
    #expect(SessionSwitcher.entry(forShortcut: 9, in: es)?.id == es[8].id)
    #expect(SessionSwitcher.entry(forShortcut: 10, in: es) == nil)
    #expect(SessionSwitcher.entry(forShortcut: 0, in: es) == nil)
    let few = SessionSwitcher.entries(main: running, workers: nil)
    #expect(SessionSwitcher.entry(forShortcut: 2, in: few) == nil, "a number with no entry does nothing")
    #expect(SessionSwitcher.shortcutLabel(index: 0) == "\u{2318}1")
    #expect(SessionSwitcher.shortcutLabel(index: 9) == nil)
  }

  @Test func namesComeFromTheConfigAndAnUnreadableConfigGivesNone() {
    let d = Data(#"{"threads":[{"id":"trip","name":"OC Test"},{"id":"x"}]}"#.utf8)
    #expect(SessionSwitcher.names(fromConfig: d) == ["trip": "OC Test", "x": "x"])
    #expect(SessionSwitcher.names(fromConfig: Data("{".utf8)).isEmpty)
    #expect(SessionSwitcher.names(fromConfig: nil).isEmpty)
  }

  @Test func theNoticeNamesThePromptAndWhereToAnswerAndIsNotScreenText() {
    #expect(
      WorkerNotice.line(threadName: "OC Test", screen: .trust)
        == "OC Test's session is waiting on a 'trust this folder' prompt; open Terminals \u{2192} OC Test on the Mac to answer.")
    #expect(WorkerNotice.line(threadName: "x\u{1B}[31m\n", screen: .mcpConsent).contains("\u{1B}") == false)
    #expect(WorkerNotice.line(threadName: "\u{7}", screen: .loginExpired).hasPrefix("A thread's session"))
    #expect(WorkerNotice.promptName(.unknownSelection) == "an unknown question")
  }

  /// The thread line for a login prompt says "sign in", as the card and the popup do (not the Mac's own start-at-login wording).
  @Test func theLoginPromptIsNamedSignIn() {
    #expect(WorkerNotice.promptName(.loginExpired) == "sign in")
    #expect(
      WorkerNotice.line(threadName: "OC Test", screen: .loginExpired)
        == "OC Test's session is waiting on a 'sign in' prompt; open Terminals \u{2192} OC Test on the Mac to answer.")
  }
}
