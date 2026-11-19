import AppKit
import Foundation
import TalosDesktopCore

/// The ONE way into the owner's shell pane that is not the owner's own keys (docs/TERMINAL-PANE.md, "One path to the shell"). A script
/// the owner tapped Run on, with the pane chosen, arrives here from the bridge over the Mac-local socket (`pane_run`, ScreenSocket) and is
/// written to the pane's shell only when the owner themself vouched for exactly that Run:
///
/// 1. The page tells the app, as it sends the Run, which message, thread and script hash it is about to send (`run_witness`). The
///    app keeps that only if a real click's release (or a real Return or Space) reached the Talos window within `PaneRun.clickSeconds`
///    and the window is key. Who sent the event is the one classification of `SyntheticInput`; the time of it is held by the window
///    (`WebNSWindow`), which only its own `sendEvent` can set. Nothing the page or a message says can set it.
/// 2. The bridge's `pane_run` is accepted against that witness: same message id, same thread, the hash of the very script it hands
///    over, not older than `PaneRun.witnessSeconds`, not used. It is spent in the same step as the check, so two Runs never share one.
/// 3. Only then is a `Ticket` made, and only a ticket opens `OwnerShellPane.runScript`. A ticket can be made nowhere but in this file
///    (its initializer is `fileprivate`), so no other code in the app has a way to put a byte into a shell: the compiler holds it.
@MainActor
final class ShellRunChannel: PaneRunService {
  /// Proof that a pane Run passed the witness check. Made only below (`fileprivate init`).
  struct Ticket {
    let thread: String
    let script: String
    fileprivate init(thread: String, script: String) {
      self.thread = thread
      self.script = script
    }
  }

  /// What the pane did with a ticket: wrote the script; is not ready yet (the answer to give if it never is); or refused for good.
  enum Step {
    case wrote
    case wait(PaneRunAnswer)
    case refused(PaneRunAnswer)
  }

  private let pane: OwnerShellPane
  /// The Talos window (the one whose events are classified), nil while there is none.
  private let window: @MainActor () -> WebNSWindow?
  /// Whether that window is key. A seam for tests, which show no window; the app reads the window.
  private var isKey: @MainActor (NSWindow) -> Bool
  private var now: () -> Double
  /// The monotonic clock every wait and the Run's total budget are read on. Tests move it (`setBudgetClockForTest`).
  private var budgetNow: () -> Double = Monotonic.now
  private var book = RunWitnessBook()
  /// Set while the app is signing out or being forgotten: nothing runs.
  var barred: () -> Bool = { false }

  init(
    pane: OwnerShellPane, window: @escaping @MainActor () -> WebNSWindow?,
    isKey: @escaping @MainActor (NSWindow) -> Bool = { $0.isKeyWindow }, now: @escaping () -> Double = Monotonic.now
  ) {
    self.pane = pane
    self.window = window
    self.isKey = isKey
    self.now = now
  }

  #if DEBUG
    func setKeyCheckForTest(_ k: @escaping @MainActor (NSWindow) -> Bool) { isKey = k }
    func setClockForTest(_ c: @escaping () -> Double) { now = c }
    func setBudgetClockForTest(_ c: @escaping () -> Double) { budgetNow = c }
  #endif

  /// `run_witness` from the page. Kept only when a person's own click or Return/Space just reached the key Talos window (and that
  /// stamp is spent by this message: one click vouches for one Run) and the table has room; otherwise dropped and logged.
  @discardableResult
  func witness(threadId: String, clientMsgId: String, scriptSha256: String) -> Bool {
    guard !barred(), let w = window() else { return drop("no Talos window") }
    guard isKey(w) else { return drop("the Talos window is not key") }
    guard w.takeHumanActivation() else { return drop("no unused click or key of the owner's in the last \(PaneRun.clickSeconds) s") }
    guard let sha = PaneRun.hexBytes(scriptSha256) else { return drop("not a script hash") }
    switch book.record(id: clientMsgId, thread: threadId, sha: sha, at: now()) {
    case .kept: return true
    case .duplicate: return drop("that message already has a witness")
    case .spent: return drop("that message already ran")
    case .full: return drop("too many witnesses are waiting")
    }
  }

  private func drop(_ why: String) -> Bool {
    DesktopLog.screen("run witness dropped: \(why)")
    return false
  }

  /// Sign-out, Forget this Mac, a new document: what the page vouched for is gone with it.
  func clear() { book = RunWitnessBook() }

  /// Told what became of every pane Run the app accepted or refused: the message id and the answer (WebController sends it to the page).
  var report: (String, PaneRunAnswer) -> Void = { _, _ in }

  // MARK: PaneRunService (the socket's `pane_status` and `pane_run`)

  nonisolated func ready() async -> Bool { true }

  func run(_ r: PaneRunRequest) async -> PaneRunAnswer {
    let a = await decide(r)
    report(r.clientMsgId, a)
    return a
  }

  private func decide(_ r: PaneRunRequest) async -> PaneRunAnswer {
    guard !barred() else { return .noPane }
    let sha = PaneRun.sha256(r.script)  // of the script exactly as the bridge sent it: no trim, the trailing line feed kept
    // The Run and its witness travel two roads; a Run that is first waits a little for it (real time, whatever clock the rules use).
    let budgetEnd = budgetNow() + PaneRun.totalBudgetSeconds  // from here, nothing is written after it
    let witnessBy = min(budgetNow() + PaneRun.witnessWaitSeconds, budgetEnd)
    var outcome = book.consume(id: r.clientMsgId, thread: r.threadId, sha: sha, now: now())
    while outcome == .missing, budgetNow() < witnessBy, !barred() {
      try? await Task.sleep(nanoseconds: 50_000_000)
      outcome = book.consume(id: r.clientMsgId, thread: r.threadId, sha: sha, now: now())
    }
    if let no = PaneRunAnswer.outcome(outcome) {
      DesktopLog.screen("pane run refused: \(no.code)")
      return no
    }
    // The witness is spent. Whatever the script holds is judged here, before anything can be pasted: an escape sequence in it (ESC [ 201 ~,
    // or the 8-bit form) could end the bracketed paste early and run the rest as typed.
    if let why = PaneRun.scriptProblem(r.script) {
      DesktopLog.screen("pane run refused: bad script")
      return .badScript(why)
    }
    let ticket = Ticket(thread: r.threadId, script: r.script)
    // the pane may still be opening, or the shell still starting: ask again for a few seconds, then say why not
    let deadline = min(budgetNow() + PaneRun.paneWaitSeconds, budgetEnd)
    while true {
      switch await pane.runScript(ticket, deadline: budgetEnd, now: budgetNow) {
      case .wrote: return .done
      case .refused(let a): return a
      case .wait(let a):
        if budgetNow() >= deadline || barred() { return a }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
    }
  }
}
