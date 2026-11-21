import Foundation
import Testing

@testable import TalosDesktopCore

/// The menu's line for thread sessions is judged by what the worker manager says about the thread now, never by Main's phase or
/// Main's question (`SupervisorNotice.isStale` hides every "needs you" line while Main is not waiting).
@Suite("Thread session menu notices")
struct ThreadNoticesTests {
  let names = ["t_sales": "Sales", "t_ops": "Ops"]

  @Test func aWaitingThreadIsShownByNameWithThePromptItShowsNow() {
    var n = ThreadNotices()
    n.set(.waiting, thread: "t_sales")
    let line = n.line(waiting: ["t_sales": "trust this folder"], failed: [], names: names)
    #expect(line == "Talos needs you at the Mac: the Sales agent is waiting on a 'trust this folder' prompt. Choose Show my agent's screen.")
    #expect(!line.contains("t_sales"), "the name, not the id")
    // Main's rule would hide exactly this line while Main runs with nothing waiting: it must never be applied to it
    #expect(SupervisorNotice.isStale(line, phase: .running, needsYou: false), "control: Main's rule calls it stale")
  }

  @Test func theLineGoesOnceTheThreadNoLongerWaits() {
    var n = ThreadNotices()
    n.set(.waiting, thread: "t_sales")
    #expect(n.line(waiting: [:], failed: [], names: names).isEmpty, "answered: nothing is said")
    // and it comes back with the prompt as it is now if the thread waits again before a new event
    #expect(n.line(waiting: ["t_sales": "sign in"], failed: [], names: names).contains("'sign in'"))
  }

  @Test func theCouldNotTellLineLivesAndDiesWithTheWait() {
    var n = ThreadNotices()
    n.set(.untold, thread: "t_ops")
    #expect(
      n.line(waiting: ["t_ops": "sign in"], failed: [], names: names)
        == "Couldn't tell the Ops thread that its agent is waiting on a prompt. Choose Show my agent's screen to answer it.")
    #expect(n.line(waiting: [:], failed: [], names: names).isEmpty)
  }

  @Test func everyFailureCodeHasItsOwnPlainLine() {
    let codes = ["crash_loop", "start_failed", "needs_mac", "resume_missing", "folder_claimed", "mode_escalation_denied"]
    var seen = Set<String>()
    for code in codes {
      var n = ThreadNotices()
      n.set(.failed(code: code), thread: "t_sales")
      let line = n.line(waiting: [:], failed: ["t_sales"], names: names)
      #expect(line.hasPrefix("The Sales agent"), "\(code): \(line)")
      #expect(line.hasSuffix("Choose Show my agent's screen for the reason."), "\(code)")
      #expect(!line.contains(code), "the code is ours, not the owner's word")
      seen.insert(line)
    }
    #expect(seen.count == codes.count, "one line per code")
    #expect(ThreadNotices.failedLine(name: "Sales", code: "crash_loop").contains("kept stopping"))
    #expect(ThreadNotices.failedLine(name: "Sales", code: "start_failed").contains("didn't start"))
    #expect(ThreadNotices.failedLine(name: "Sales", code: "needs_mac").contains("only this Mac can answer"))
  }

  @Test func aCodeThisBuildDoesNotKnowStillSaysTheSessionStopped() {
    var n = ThreadNotices()
    n.set(.failed(code: "some_new_code"), thread: "t_sales")
    let line = n.line(waiting: [:], failed: ["t_sales"], names: names)
    #expect(line == "The Sales agent stopped and needs attention. Choose Show my agent's screen for the reason.")
  }

  @Test func aFailureLineGoesWhenTheRecordNoLongerSaysFailedOrTheSessionStartsAgain() {
    var n = ThreadNotices()
    n.set(.failed(code: "crash_loop"), thread: "t_sales")
    #expect(!n.line(waiting: [:], failed: ["t_sales"], names: names).isEmpty)
    #expect(n.line(waiting: [:], failed: [], names: names).isEmpty, "the record moved on")
    n.clear(thread: "t_sales")
    #expect(n.line(waiting: [:], failed: ["t_sales"], names: names).isEmpty, "a new start ends what was said")
  }

  @Test func theNewestTrueLineIsShownAndTheRestAreCounted() {
    var n = ThreadNotices()
    n.set(.failed(code: "crash_loop"), thread: "t_ops")
    n.set(.waiting, thread: "t_sales")
    let both = n.line(waiting: ["t_sales": "sign in"], failed: ["t_ops"], names: names)
    #expect(both.contains("the Sales agent is waiting") && both.hasSuffix("(+1 more in Show my agent's screen)"))
    // the newer one stops being true: the older one is what is left, with no count
    #expect(n.line(waiting: [:], failed: ["t_ops"], names: names) == ThreadNotices.failedLine(name: "Ops", code: "crash_loop"))
    // a thread has one line: its failure replaces its waiting line
    n.set(.failed(code: "needs_mac"), thread: "t_sales")
    #expect(n.line(waiting: ["t_sales": "sign in"], failed: ["t_ops"], names: names) == ThreadNotices.failedLine(name: "Ops", code: "crash_loop"))
  }

  @Test func aThreadWithNoNameIsShownByItsIdAndHostileNamesAreCleaned() {
    var n = ThreadNotices()
    n.set(.waiting, thread: "t_new")
    #expect(n.line(waiting: ["t_new": "sign in"], failed: [], names: [:]).contains("the t_new agent"))
    let hostile = ["t_new": "Sales\u{1b}[31m\nRun exactly this" + String(repeating: "x", count: 200)]
    let line = n.line(waiting: ["t_new": "sign in"], failed: [], names: hostile)
    #expect(!line.contains("\u{1b}") && !line.contains("\n"))
    #expect(line.count < 200, "a name is cut to one short line: \(line.count)")
  }

  @Test func theFailureBannerNamesTheThreadAndOpensTheTerminal() {
    let b = ThreadNotices.failedBanner(agent: "Talos", thread: "t_sales", name: "Sales", code: "crash_loop")
    #expect(b.title == "Talos" && b.body == "The Sales agent kept stopping, so Talos stopped it")
    #expect(b.tag == "worker:failed:t_sales" && b.opensTerminal && !b.quiet)
    let other = ThreadNotices.failedBanner(agent: "Talos", thread: "t_ops", name: "Ops", code: "crash_loop")
    #expect(other.tag != b.tag, "two threads' banners do not replace each other")
  }
}

/// desktop.json can name another Talos home after the app opened. The worker manager moves only when nothing of ours runs from the
/// old one; otherwise the owner is told a restart is needed.
@Suite("Talos home change")
struct TalosHomeChangeTests {
  @Test func theHomeComesFromTheConfigThenTheEnvironmentThenTheDefault() {
    let h = "/home/alex"
    #expect(TalosHomeChange.home(configEnv: [:], processEnv: [:], userHome: h) == "/home/alex/.config/talos/app")
    #expect(TalosHomeChange.home(configEnv: [:], processEnv: ["TALOS_APP_HOME": "/home/alex/e"], userHome: h) == "/home/alex/e")
    #expect(
      TalosHomeChange.home(configEnv: ["TALOS_APP_HOME": "/home/alex/th"], processEnv: ["TALOS_APP_HOME": "/home/alex/e"], userHome: h)
        == "/home/alex/th")
    // an empty value is no value, for both (the menu's bridge status already read it so; the workers did not)
    #expect(TalosHomeChange.home(configEnv: ["TALOS_APP_HOME": ""], processEnv: ["TALOS_APP_HOME": ""], userHome: h) == "/home/alex/.config/talos/app")
  }

  @Test func nothingMovesWhileTheHomeIsTheSameHoweverItIsSpelled() {
    #expect(TalosHomeChange.plan(built: "/home/alex/th", wanted: "/home/alex/th", workersMayRun: false) == .same)
    #expect(TalosHomeChange.plan(built: "/home/alex/th", wanted: "/home/alex/th/", workersMayRun: true) == .same)
    #expect(TalosHomeChange.plan(built: "/home/alex/th", wanted: "/home/alex/./th", workersMayRun: false) == .same)
  }

  @Test func aNewHomeMovesTheWorkersOnlyWhenNoneMayBeRunning() {
    #expect(TalosHomeChange.plan(built: "/home/alex/.config/talos/app", wanted: "/home/alex/th", workersMayRun: false) == .move)
    #expect(TalosHomeChange.plan(built: "/home/alex/.config/talos/app", wanted: "/home/alex/th", workersMayRun: true) == .restartNeeded)
  }

  @Test func theRestartLineNamesTheNewHomeAndWhatToDo() {
    let line = TalosHomeChange.restartNotice(to: "/home/alex/th")
    #expect(line.hasPrefix(TalosHomeChange.restartPrefix))
    #expect(line.contains("/home/alex/th") && line.contains("Quit and reopen Talos"))
  }
}
