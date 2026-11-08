import Foundation
import Testing
@testable import TalosDesktopCore

/// The Terminal screen's tabs: what the page may name (`terminal_view.session`, `terminal_resume`), the list the shell sends it
/// (`terminal_sessions`), and which tmux session a tab means. The page is the less trusted side.
@Suite("Terminal screen tabs")
struct TerminalSessionsTests {
  let rect: [String: Any] = ["x": 240, "y": 0, "width": 880, "height": 780]
  let running = SessionSwitcher.MainFacts(state: .running, hasScreen: true)
  let hostile = ["=agent", "t-trip", "../x", "all", "Trip", "", "a b", "trip\n", "$(id)", "1trip", String(repeating: "x", count: 33)]

  func file(_ entries: [String: (state: String, error: String?)]) -> WorkersFile {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-05T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    for (id, v) in entries {
      var e = WorkersFile.Entry(threadId: id, cwd: "/home/alex/proj-\(id)")
      e.state = v.state
      if let code = v.error { e.error = .init(code: code, detail: "it exited at once", at: "2026-11-05T00:00:00Z") }
      f.threads[id] = e
    }
    return f
  }

  // MARK: page -> shell

  @Test func terminalViewSessionIsOptionalMainOrAThreadId() {
    #expect(WebToNative.decode(["type": "terminal_view", "rect": rect]) == .terminalView(TerminalViewRect(x: 240, y: 0, width: 880, height: 780), session: "main"))
    #expect(WebToNative.decode(["type": "terminal_view", "rect": rect, "session": "main"]) != nil)
    #expect(WebToNative.decode(["type": "terminal_view", "rect": NSNull(), "session": "trip"]) == .terminalView(nil, session: "trip"))
  }

  @Test func aHostileSessionRefusesTheWholeMessageNotJustTheField() {
    for bad in hostile {
      #expect(WebToNative.decode(["type": "terminal_view", "rect": rect, "session": bad]) == nil, "session \(bad.debugDescription)")
      #expect(WebToNative.decode(["type": "terminal_resume", "thread_id": bad]) == nil, "resume \(bad.debugDescription)")
    }
    for bad in [NSNull(), 7, ["trip"], ["id": "trip"]] as [Any] {
      #expect(WebToNative.decode(["type": "terminal_view", "rect": rect, "session": bad]) == nil)
    }
    #expect(WebToNative.decode(["type": "terminal_resume", "thread_id": "main"]) != nil, "decodes: whether it may resume is the list's call")
    #expect(WebToNative.decode(["type": "terminal_resume"]) == nil)
    #expect(WebToNative.decode(["type": "terminal_resume", "thread_id": "trip", "keys": "ls"]) == nil)
  }

  // MARK: shell -> page

  @Test func theListIsMainFirstWithKeysStatesAndWhatEachTabShows() throws {
    let f = file(["trip": ("busy", nil), "p": ("parked", nil), "o": ("off", nil), "f": ("failed", "start_failed"), "g": ("live", nil)])
    let es = SessionSwitcher.entries(main: running, workers: f, names: ["trip": "OC Test", "p": "Parked", "o": "Off", "f": "Broken", "g": "Garden"])
    let items = TerminalSessions.items(entries: es, workers: f)
    #expect(items.map(\.id) == ["main", "f", "g", "o", "trip", "p"].sorted { a, b in
      // same order as the Terminals window: Main, then by lower-cased name
      let order = ["main": "", "f": "broken", "g": "garden", "o": "off", "trip": "oc test", "p": "parked"]
      return order[a]! < order[b]!
    })
    #expect(items.map(\.key) == ["1", "2", "3", "4", "5", "6"])
    let by = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
    #expect(by["main"]?.state == "live" && by["main"]?.panel == "terminal")
    #expect(by["trip"]?.state == "working" && by["trip"]?.panel == "terminal" && by["trip"]?.action == nil)
    #expect(by["g"]?.state == "idle")
    #expect(by["p"]?.state == "parked" && by["p"]?.panel == "resume" && by["p"]?.action == "resume")
    #expect(by["o"]?.state == "not_started" && by["o"]?.panel == "resume" && by["o"]?.action == "start")
    let failed = try #require(by["f"])
    #expect(failed.state == "failed" && failed.panel == "error" && failed.action == nil)
    #expect(failed.detail.contains("start_failed") && failed.detail.contains("it exited at once"))
  }

  @Test func needsYouAndMainsOwnStatesUseThePagesWords() {
    let f = file(["q": ("live", nil)])
    let es = SessionSwitcher.entries(main: .init(state: .stopped(failure: "Main crashed."), hasScreen: false), workers: f, needsYou: ["q": "trust this folder"])
    let items = TerminalSessions.items(entries: es, workers: f)
    #expect(items.first { $0.id == "q" }?.state == "needs_you")
    let main = items[0]
    #expect(main.state == "failed" && main.panel == "note" && main.detail == "Main crashed.")
    #expect(TerminalSessions.stateWord(.notStarted) == "not_started")
    let every: [SwitcherEntry.Badge] = [.live, .working, .idle, .starting, .parked, .stopping, .failed, .needsYou, .notStarted, .unknown]
    let words = ["live", "working", "idle", "starting", "parked", "stopping", "failed", "needs_you", "not_started", "unknown"]
    #expect(every.map(TerminalSessions.stateWord) == words, "the words TERMINAL_SESSION_STATES lists, one per badge")
  }

  @Test func onlyNineTabsGetAKeyAndATenthStillListsWithoutOne() {
    let ids = (1...11).map { "t\($0)" }
    let f = file(Dictionary(uniqueKeysWithValues: ids.map { ($0, ("live", nil as String?)) }))
    let items = TerminalSessions.items(entries: SessionSwitcher.entries(main: running, workers: f), workers: f)
    #expect(items.count == 12)
    #expect(items.prefix(9).map(\.key) == (1...9).map { String($0) })
    #expect(items.dropFirst(9).allSatisfy { $0.key == nil })
    // the same entry gets the same number the Terminals window gives ⌘1 to ⌘9
    #expect(SessionSwitcher.entry(forShortcut: 9, in: SessionSwitcher.entries(main: running, workers: f))?.id == items[8].id)
  }

  @Test func aThreadCalledMainIsLeftOutSoItCanNeverStandInForMain() {
    let f = file(["main": ("live", nil), "trip": ("live", nil)])
    let items = TerminalSessions.items(entries: SessionSwitcher.entries(main: running, workers: f), workers: f)
    #expect(items.map(\.id) == ["main", "trip"])
    #expect(items[0].name == "Main")
  }

  @Test func textFromAFileIsCleanedAndCappedBeforeItReachesThePage() {
    var f = file(["f": ("failed", "boom")])
    f.threads["f"]?.error = .init(code: "boom", detail: "\u{1B}[2Jbad\n" + String(repeating: "é", count: 900), at: "2026-11-05T00:00:00Z")
    let items = TerminalSessions.items(entries: SessionSwitcher.entries(main: running, workers: f), workers: f)
    let d = items.first { $0.id == "f" }!.detail
    #expect(!d.contains("\u{1B}") && !d.contains("\n"))
    #expect(d.utf16.count <= 600)
    #expect(NativeToWeb.validated(.terminalSessions(items)) != nil, "what we build passes our own check of the page's rules")
  }

  @Test func theMessageCarriesTheFieldsTheTypeScriptSchemaNames() throws {
    let f = file(["p": ("parked", nil)])
    let items = TerminalSessions.items(entries: SessionSwitcher.entries(main: running, workers: f), workers: f)
    let o = NativeToWeb.terminalSessions(items).object
    #expect(o["type"] as? String == "terminal_sessions")
    let list = try #require(o["items"] as? [[String: Any]])
    #expect(Set(list[1].keys) == ["id", "name", "state", "key", "panel", "action", "detail"])
    let json = try #require(NativeToWeb.terminalSessions(items).jsonString())
    #expect(json.contains("\"action\":\"resume\"") && json.contains("\"key\":\"2\""))
    #expect(NativeToWeb.validated(.terminalSessions(Array(repeating: items[0], count: 102))) == nil)
    var bad = items[0]
    bad.id = "=agent"
    #expect(NativeToWeb.validated(.terminalSessions([bad])) == nil)
    #expect(NativeToWeb.validated(.terminalResumeResult(threadId: "../x", outcome: .asked)) == nil)
    #expect(NativeToWeb.terminalResumeResult(threadId: "p", outcome: .parkPending).object["outcome"] as? String == "park_pending")
  }

  // MARK: which session a tab means

  @Test func aSessionNamedByThePageIsFoundInTheListOrNotAtAll() {
    let f = file(["trip": ("live", nil)])
    let es = SessionSwitcher.entries(main: running, workers: f)
    #expect(TerminalSessions.entry(forSession: "trip", in: es)?.tmuxSession == "t-trip")
    #expect(TerminalSessions.entry(forSession: "main", in: es)?.tmuxSession == "agent")
    for bad in hostile + ["ghost"] { #expect(TerminalSessions.entry(forSession: bad, in: es) == nil, "\(bad)") }
  }

  @Test func theTargetIsTheListsSessionNeverAnythingThePageSent() {
    let f = file(["trip": ("live", nil), "p": ("parked", nil), "x": ("failed", "boom")])
    let es = SessionSwitcher.entries(main: running, workers: f)
    func target(_ id: String) -> TerminalSessions.ThreadTarget {
      TerminalSessions.threadTarget(id, entries: es, workers: f) {
        SessionSwitcher.attachArgv(for: $0, tmux: "/opt/tmux", socket: "talos-test-9", configPath: "/c/tmux.conf")
      }
    }
    guard case .attach(let argv) = target("trip") else { Issue.record("a live thread attaches"); return }
    #expect(argv.suffix(3) == ["attach-session", "-t", "=t-trip"])
    #expect(argv.starts(with: ["/opt/tmux", "-L", "talos-test-9"]))
    if case .note(let n) = target("p") { #expect(n.contains("arked")) } else { Issue.record("a parked thread has no pane") }
    if case .note = target("x") {} else { Issue.record("a failed thread has no pane") }
    // a thread that happens to be called "agent" is t-agent: the page's word never becomes Main's session
    let g = file(["agent": ("live", nil)])
    let ge = SessionSwitcher.entries(main: running, workers: g)
    guard case .attach(let a) = TerminalSessions.threadTarget("agent", entries: ge, workers: g, attach: { SessionSwitcher.attachArgv(for: $0, tmux: "/t", socket: "s", configPath: "/c") }) else {
      Issue.record("a thread called agent attaches")
      return
    }
    #expect(a.last == "=t-agent")
    #expect(target("ghost") == .gone)
    #expect(target("main") == .gone, "Main has its own path")
    #expect(target("=agent") == .gone)
    #expect(TerminalSessions.threadTarget("trip", entries: nil, workers: nil) { _ in nil } == .gone)
    if case .note = TerminalSessions.threadTarget("trip", entries: es, workers: f, attach: { _ in nil }) {} else { Issue.record("no tmux argv = a line, not a crash") }
  }

  @Test func resumeIsHonouredOnlyForAThreadTheListShowsAsResumable() {
    let f = file(["trip": ("live", nil), "p": ("parked", nil), "o": ("off", nil), "x": ("failed", "boom"), "b": ("busy", nil)])
    let es = SessionSwitcher.entries(main: running, workers: f)
    func may(_ id: String) -> Bool { TerminalSessions.mayResume(id, entries: es, workers: f) }
    #expect(may("p") && may("o"))
    #expect(!may("trip") && !may("x") && !may("b"), "a running or failed session is never woken from the page")
    #expect(!may("main") && !may("ghost"))
    for bad in hostile { #expect(!may(bad), "\(bad)") }
  }

  // MARK: review round 1

  @Test func aNameLongInUTF16UnitsIsCutToTheProtocolLimitNotDroppedWithTheWholeList() {
    // 40 characters is the switcher's own limit, but a letter with ten combining accents is 11 UTF-16 units: 40 of them are far past 80
    let accented = String(repeating: "e" + String(repeating: "\u{0301}", count: 10), count: 40)
    let f = file(["a": ("live", nil), "b": ("live", nil)])
    let es = SessionSwitcher.entries(main: running, workers: f, names: ["a": accented, "b": "Fine"])
    let items = TerminalSessions.items(entries: es, workers: f)
    #expect((es.first { $0.id == "a" }?.title.utf16.count ?? 0) > 80, "the switcher's own 40-character cut leaves this over the page's limit")
    #expect(items.count == 3, "one long name costs no tab")
    #expect(items.allSatisfy { $0.name.utf16.count <= 80 && !$0.name.isEmpty })
    #expect(NativeToWeb.validated(.terminalSessions(items)) != nil, "the whole message still passes the page's rules")
    #expect(items.first { $0.id == "b" }?.name == "Fine")
  }

  @Test func oneItemThePageWouldRefuseIsLeftOutAndTheRestIsSent() {
    let good = TerminalSessions.Item(id: "trip", name: "OC", state: "live", key: "2", panel: "terminal", action: nil, detail: "")
    var bad = good
    bad.name = String(repeating: "x", count: 200)
    #expect(TerminalSessions.sendable([good, bad]) == [good])
  }

  @Test func keysFollowThePositionInTheListAsSentNotTheEntriesIndex() {
    // a thread called "main" sorts first among threads and is left out; the keys must not skip a number
    let f = file(["main": ("live", nil), "b": ("live", nil), "c": ("live", nil)])
    let es = SessionSwitcher.entries(main: running, workers: f, names: ["main": "A first", "b": "B", "c": "C"])
    let items = TerminalSessions.items(entries: es, workers: f)
    #expect(items.map(\.id) == ["main", "b", "c"])
    #expect(items.map(\.key) == ["1", "2", "3"])
  }
}
