import Foundation
import TalosDesktopCore

/// The stuck-Main auto-unstick (setting `unstick_main`, on by default). When `MainWatch` says an owner message's model request has hung
/// (`stalled`), this tries for that message: Escape in Main's pane, through the key gate (`.interrupt`: the box live and empty, the
/// working line up, no dialog or select anywhere), then a request file the bridge answers by delivering that message to Main again
/// (apps/bridge/src/main-resend.ts: it checks the message is still the oldest unseen one, has waited as long as a stall, and does it
/// once). Nothing is typed into the pane: the second delivery is the bridge's own channel notification, the path every owner message takes.
///
/// - Only against a bridge that says it answers (`main_resend` in status.json): an older bridge could not send the message again, so
///   nothing is pressed and the owner gets the alarm line alone.
/// - The thread line waits for the bridge's answer (`main-resend-result.json`) and says "sent it again" only when the bridge says it did;
///   an answer of failure, or none within `MainWatch.answerWithin`, says Esc was pressed and the message must be sent again.
/// - A frozen request that drew no spinner gets the same Esc through `.interruptBlank` (the idle prompt, an empty box, no dialog, the
///   transcript's pending turn read this tick, the 90 s wait passed).
/// - Never while an attached client typed lately (`ownerIsTyping`), and a draft in the box is refused by the gate. A refusal spends
///   nothing: the next try is `MainWatch.retryAfter` later, and at most one Esc is ever sent for a message.
extension Supervisor {
  private var resendRequestPath: String { talosAppHome + "/main-resend.json" }
  private var resendAnswerPath: String { talosAppHome + "/main-resend-result.json" }

  /// The request the bridge reads: the time of the message it is for, in the bridge's own form.
  /// `blank`: the stall was the blank-pane case (no working line), which the bridge accepts from the shorter wait only when told so.
  public static func resendRequest(for at: Date, blank: Bool = false) -> Data {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var body: [String: Any] = ["v": 1, "unseen_at": f.string(from: at)]
    if blank { body["blank"] = true }
    return (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
  }

  /// Every tick of `watchMain` after the reads: one try when the stall is up and nothing is spent for it.
  func unstickTick(_ l: inout Launch, awake: Double) {
    guard config.unstickMain, l.mainWatch.stalled() != nil else { return }
    guard l.mainWatch.bridgeResends else {
      if !l.noResendNoted {
        l.noResendNoted = true
        audit("unstick_skipped", ["why": "bridge_cannot_resend"])
      }
      return
    }
    guard let at = l.mainWatch.takeUnstick(awakeNow: awake) else { return }
    if ownerIsTyping() {
      audit("unstick_skipped", ["why": "typing"])
      l.mainWatch.refused(awakeNow: awake)
      return
    }
    // an answer left by an earlier request is never read as this one's
    try? FileManager.default.removeItem(atPath: resendAnswerPath)
    // A spinner on the pane: `.interrupt`. No working line but the transcript says the model's turn is pending and the blank wait has
    // passed: `.interruptBlank`, the idle prompt only. Either way one Escape for the message (a second opens Claude Code's rewind menu).
    let blank = l.mainWatch.blankStallReady(awakeNow: awake)
    let intent: KeyGuard.Intent = blank ? .interruptBlank : .interrupt
    let sent = sendKey(intent) { $0.sendEscape() }
    guard sent != .refused, sent != .failed else {
      audit(sent == .failed ? "unstick_failed" : "unstick_skipped", ["why": sent == .failed ? "key" : "refused"])  // the gate's own row has the reason
      l.mainWatch.refused(awakeNow: awake)
      return
    }
    let minutes = max(1, Int(((options.wallClock() / 1000 - at.timeIntervalSince1970) / 60).rounded()))
    do {
      try AtomicFile.write(Self.resendRequest(for: at, blank: blank), to: resendRequestPath, mode: 0o600)
    } catch {
      audit("unstick_pressed", ["resend": "not_written", "minutes": "\(minutes)"])
      l.mainWatch.pressedNoRequest(min: minutes)
      postToPhone { _ in SupervisorNotice.mainStalled(since: at, did: .failed(min: minutes)) }
      return
    }
    audit("unstick_pressed", ["resend": "asked", "minutes": "\(minutes)"])
    l.mainWatch.pressed(unseenAt: at, min: minutes, awakeNow: awake)
  }

  /// The bridge's answer to the request in flight (or the wait running out): the one thread line, then the answer file is removed.
  func settleUnstickAnswer(_ l: inout Launch, awake: Double) {
    guard l.mainWatch.awaiting != nil else { return }
    let answer = probe.readFile(resendAnswerPath).flatMap(MainResendAnswer.decode)
    guard let (done, sent) = l.mainWatch.settleAwaiting(answer: answer, awakeNow: awake) else { return }
    try? FileManager.default.removeItem(atPath: resendAnswerPath)
    audit("unstick_answered", ["sent": sent ? "1" : "0", "answered": answer == nil ? "0" : "1"])
    let did: MainWatch.Unstick = sent ? .resent(min: done.min) : .failed(min: done.min)
    postToPhone { _ in SupervisorNotice.mainStalled(since: done.unseenAt, did: did) }
  }
}
