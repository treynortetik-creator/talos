import Foundation
import TalosDesktopCore

/// Main's session waiting on a prompt nobody named (a tool permission, the agent's own question, any Select): once the prompt has
/// held still (`PromptDetector`, `PromptWatch`) the default thread gets one line, through the same path as the cold-start question.
/// The known dialogs keep their handling in `superviseLive`; the detector answers nothing for them. While an attached client has
/// typed lately (a picker the owner opened, or the owner at the keys) the line waits. A record on disk (`main-prompt.json`: a hash of
/// the prompt, which has no width in it, and whether it is still open) keeps a relaunched app, a resize, or a re-read of the same pane
/// from announcing the same open prompt twice. Nothing is ever typed into the prompt.
extension Supervisor {
  struct PromptRecord: Codable, Equatable {
    var hash: String
    var open: Bool
  }

  private var promptRecordPath: String { talosAppHome + "/main-prompt.json" }

  private func readPromptRecord() -> PromptRecord? {
    probe.readFile(promptRecordPath).flatMap { try? JSONDecoder().decode(PromptRecord.self, from: $0) }
  }

  private func writePromptRecord(_ r: PromptRecord) {
    guard let d = try? JSONEncoder().encode(r) else { return }
    try? AtomicFile.write(d, to: promptRecordPath, mode: 0o600)
  }

  /// An attached client typed within `promptClientQuiet`. Not read while a prompt is already announced, or when there is none.
  private func ownerIsTyping() -> Bool {
    guard let last = host.clientActivity() else { return false }
    return options.wallClock() / 1000 - last < timings.promptClientQuiet
  }

  /// One look at a readable screen.
  func watchPrompt(_ rows: [String], launch l: inout Launch, now: Double) {
    let found = PromptDetector.detect(rows)
    let still = l.promptWatch.screenStill(rows, at: now, settle: timings.promptSettle)
    let hold = found != nil && l.promptWatch.current == nil && ownerIsTyping()
    switch l.promptWatch.observe(found, at: now, settle: timings.promptSettle, hold: hold, idle: PromptDetector.isIdle(rows)) {
    case .appeared(let p):
      l.promptChecked = true
      let hash = p.hash
      if let rec = readPromptRecord(), rec.open, rec.hash == hash {
        // still the prompt a previous run of the app announced
        audit("prompt_already_open", ["kind": p.title ?? "prompt"])
        return
      }
      writePromptRecord(PromptRecord(hash: hash, open: true))
      audit("prompt_notified", ["kind": p.title ?? "prompt"])
      postToPhone { SupervisorNotice.mainPromptLine(agentName: $0, prompt: p) }
    case .cleared:
      audit("prompt_cleared", [:])
      closePromptRecord()
    case .none:
      // The first look since this run began: an open record whose prompt is not on screen is over (the session was restarted, or the
      // prompt was answered while the app was away). Only once the screen has held still: a pane that is still being drawn, or a
      // prompt still settling, is not "no prompt".
      if found == nil, !l.promptChecked, still, !rows.isEmpty {
        l.promptChecked = true
        closePromptRecord()
      }
    }
  }

  private func closePromptRecord() {
    guard var rec = readPromptRecord(), rec.open else { return }
    rec.open = false
    writePromptRecord(rec)
  }
}
