import Foundation
import Testing

@testable import TalosDesktopCore

/// The Quick Compose status line and the Send switch, decided in one place. The panel itself is not driven here.
@Suite("Quick Compose: the status line and Send")
struct ComposeStatusTests {
  typealias S = ComposeStatus

  func eval(_ change: (inout S.Inputs) -> Void = { _ in }, event: String? = nil, info: Bool = false) -> S.Result {
    var i = S.Inputs()
    change(&i)
    return S.evaluate(i, event: event, eventIsInfo: info)
  }

  @Test func aPlainDraftOnAKnownThreadSendsWithNothingToSay() {
    #expect(eval() == S.Result(line: "", sendEnabled: true, info: false))
    #expect(eval { $0.text = "" } == S.Result(line: "", sendEnabled: true, info: false), "an empty box stays quiet; Send itself says what is missing")
    #expect(eval { $0.text = String(repeating: "x", count: 32_000) }.sendEnabled, "32,000 is the most")
  }

  @Test func everyReasonSendIsOffSaysWhy() {
    let gone = eval { $0.threadGone = true }
    #expect(!gone.sendEnabled && gone.line == S.goneLine)
    #expect(gone.line.contains("Your text is kept") && gone.line.contains("Pick a thread"), "it says what to do, not just what happened")
    let long = eval { $0.text = String(repeating: "x", count: 32_001) }
    #expect(!long.sendEnabled && long.line == S.tooLongLine)
    let blank = eval { $0.text = "  \n\t " }
    #expect(!blank.sendEnabled && blank.line == S.emptyLine, "spaces are not a message")
    let none = eval { $0.hasThreads = false }
    #expect(!none.sendEnabled && none.line == S.noThreadsLine)
    let out = eval { $0.sending = true }
    #expect(!out.sendEnabled && out.line == S.sendingLine && out.info, "waiting is not an error")
    #expect(!eval { $0.signedIn = false }.sendEnabled, "signed out shows the sign-in view instead")
  }

  @Test func sendIsNeverOffWithNothingOnScreenWhileSignedIn() {
    for gone in [false, true] {
      for sending in [false, true] {
        for threads in [false, true] {
          for text in ["", "hello", "   ", String(repeating: "x", count: 32_001)] {
            for lost in [false, true] {
              let r = eval {
                $0.threadGone = gone
                $0.sending = sending
                $0.hasThreads = threads
                $0.text = text
                $0.lost = lost
              }
              #expect(r.sendEnabled || !r.line.isEmpty, "gone \(gone) sending \(sending) threads \(threads) text \(text.count) lost \(lost)")
            }
          }
        }
      }
    }
  }

  @Test func aRefusalIsShownOnlyWithTheSendThatWasRefusedAndTheNextEvaluationDropsIt() {
    let refused = eval({ $0.text = "" }, event: S.emptyLine)
    #expect(refused.line == S.emptyLine)
    #expect(eval { $0.text = "h" }.line == "", "the text changed: the stale reason is gone")
    let stale = eval({ $0.lost = true }, event: nil)
    #expect(stale.line == S.lostLine, "with the warning up, a keystroke leaves the warning alone, not the old reason in front of it")
  }

  @Test func theWentAwayWarningIsAlwaysLastAndSurvivesEveryReason() {
    #expect(eval { $0.lost = true }.line == S.lostLine)
    #expect(eval({ $0.lost = true }, event: S.pickLine).line == "\(S.pickLine)\n\(S.lostLine)")
    let gone = eval { $0.threadGone = true; $0.lost = true }
    #expect(gone.line == "\(S.goneLine)\n\(S.lostLine)" && !gone.sendEnabled)
    let long = eval { $0.text = String(repeating: "x", count: 32_001); $0.lost = true }
    #expect(long.line == "\(S.tooLongLine)\n\(S.lostLine)")
    #expect(eval { $0.sending = true; $0.lost = true }.line == S.sendingLine, "while a message is out, the line is about that")
  }

  @Test func theWentAwayWarningSurvivesAStatusRefreshWhileSignedOut() {
    // Lost send, the owner signs out, opens the panel (a refresh), signs back in: the warning must still be there to read.
    let out = eval { $0.signedIn = false; $0.lost = true }
    #expect(out.line == S.lostLine && !out.sendEnabled)
    #expect(eval { $0.signedIn = false }.line == "", "nothing to warn about, nothing to say")
    #expect(eval { $0.signedIn = false; $0.lost = true; $0.threadGone = true }.line == S.lostLine, "signed out says only the warning")
    #expect(eval({ $0.lost = true }).line == S.lostLine, "and signed back in it is still the warning")
  }

  @Test func aSendThePageDidNotTakeKeepsSayingTheTextIsKeptEvenWhenSendIsOffForAnotherReason() {
    let plain = eval(event: S.notTakenLine)
    #expect(plain.line == S.notTakenLine && plain.sendEnabled)
    let gone = eval({ $0.threadGone = true }, event: S.notTakenLine)
    #expect(gone.line == "\(S.notTakenLine)\n\(S.goneLine)" && !gone.sendEnabled, "both: what happened and why Send is off")
    let both = eval({ $0.lost = true }, event: S.notTakenLine)
    #expect(both.line == "\(S.notTakenLine)\n\(S.lostLine)")
  }

  @Test func theNotTakenLineSurvivesAStatusRefreshWhileSignedOutAndComesBackWithTheOwner() {
    // Send not taken because the owner was signed out, the panel is refreshed (still signed out), the owner signs back in.
    let out = eval { $0.signedIn = false; $0.notTaken = true }
    #expect(out.line == S.notTakenLine && !out.sendEnabled && !out.info)
    #expect(eval { $0.signedIn = false; $0.notTaken = true; $0.threadGone = true }.line == S.notTakenLine, "signed out says only what is kept")
    #expect(eval { $0.signedIn = false }.line == "", "nothing kept, nothing to say")
    let back = eval { $0.notTaken = true }
    #expect(back.line == S.notTakenLine && back.sendEnabled && !back.info, "signed back in it is still the line, and Send is on to try again")
  }

  @Test func aWentAwayAnswerIsShownEvenIfTheOwnerEmptiedTheBoxMeanwhile() {
    // The message may have gone: the status says so whatever the box holds. When the warning ends is the panel's call.
    let r = eval { $0.text = ""; $0.lost = true }
    #expect(r.line == S.lostLine && r.sendEnabled && !r.info)
  }

  @Test func theWentAwayWarningStaysLastAfterTheNotTakenLineSignedOutOrIn() {
    #expect(eval { $0.signedIn = false; $0.notTaken = true; $0.lost = true }.line == "\(S.notTakenLine)\n\(S.lostLine)")
    #expect(eval { $0.notTaken = true; $0.lost = true }.line == "\(S.notTakenLine)\n\(S.lostLine)")
    let gone = eval { $0.notTaken = true; $0.lost = true; $0.threadGone = true }
    #expect(gone.line == "\(S.notTakenLine)\n\(S.goneLine)\n\(S.lostLine)" && !gone.sendEnabled)
    #expect(eval({ $0.notTaken = true }, event: S.notTakenLine).line == S.notTakenLine, "the same line is said once")
    #expect(eval { $0.notTaken = true; $0.sending = true }.line == S.sendingLine, "while a message is out, the line is about that")
  }

  @Test func aReasonThatIsAlsoTheEventIsSaidOnce() {
    let r = eval({ $0.text = String(repeating: "x", count: 32_001) }, event: S.tooLongLine)
    #expect(r.line == S.tooLongLine)
  }

  @Test func keepingADraftForAnotherThreadIsInformationAndGivesWayToProblems() {
    let keep = eval { $0.keepingDraftFor = "Home" }
    #expect(keep.line == "Keeping your draft for Home." && keep.info && keep.sendEnabled)
    #expect(!eval { $0.keepingDraftFor = "Home"; $0.text = "   " }.info, "a problem is not information")
    #expect(eval({ $0.keepingDraftFor = "Home" }, event: "Sent. Your newer text is kept.", info: true).info)
  }

  @Test func aNotTakenAnswerOverAnEmptiedBoxStillSaysItDidNotGoButNotThatTheTextIsKept() {
    // The owner emptied the box while the Send was out and the page then refused it: they must still be told it did not go.
    let empty = eval { $0.text = ""; $0.notTaken = true }
    #expect(empty.line == S.notTakenEmptyLine && empty.sendEnabled && !empty.info)
    #expect(!empty.line.contains("kept"), "there is no text to keep")
    let blank = eval { $0.text = "  \n "; $0.notTaken = true }
    #expect(blank.line == "\(S.notTakenEmptyLine)\n\(S.emptyLine)", "spaces are not text to keep")
    let out = eval { $0.signedIn = false; $0.text = ""; $0.notTaken = true }
    #expect(out.line == S.notTakenEmptyLine && !out.sendEnabled)
    // A lost send is a different thing: the message may have gone, so the warning stands over an empty box, last.
    let both = eval { $0.text = ""; $0.notTaken = true; $0.lost = true }
    #expect(both.line == "\(S.notTakenEmptyLine)\n\(S.lostLine)" && !both.info)
    let bothOut = eval { $0.signedIn = false; $0.text = ""; $0.notTaken = true; $0.lost = true }
    #expect(bothOut.line == "\(S.notTakenEmptyLine)\n\(S.lostLine)")
    // With text in the box the line is unchanged.
    #expect(eval { $0.notTaken = true }.line == S.notTakenLine)
  }

  /// What the panel shows after a refresh: the last action's line, if the refresh keeps it, in front of whatever else is true.
  func afterRefresh(_ event: S.Event?, _ change: (inout S.Inputs) -> Void = { _ in }) -> S.Result {
    var i = S.Inputs()
    change(&i)
    let kept = S.eventKeptThroughRefresh(event, i)
    return S.evaluate(i, event: kept?.line, eventIsInfo: kept?.isInfo ?? false)
  }

  @Test func aRefreshKeepsTheShortLineTheLastActionLeft() {
    let sent = S.Event(line: "Sent. Your newer text is kept.", isInfo: true)
    let r = afterRefresh(sent)
    #expect(r.line == sent.line && r.info && r.sendEnabled, "information stays information")
    let pick = afterRefresh(S.Event(line: S.pickLine, isInfo: false))
    #expect(pick.line == S.pickLine && !pick.info && pick.sendEnabled)
    #expect(afterRefresh(nil).line == "", "nothing was said, nothing is added")
    let withKept = afterRefresh(S.Event(line: S.pickLine, isInfo: false)) { $0.notTaken = true; $0.lost = true }
    #expect(withKept.line == "\(S.pickLine)\n\(S.notTakenLine)\n\(S.lostLine)", "the flags keep their place around it")
  }

  @Test func aRefreshReplacesTheShortLineWhenTheThreadIsGoneOrNoneAreListedOrTheOwnerIsSignedOut() {
    let sent = S.Event(line: "Sent. Your newer text is kept.", isInfo: true)
    let gone = afterRefresh(sent) { $0.threadGone = true }
    #expect(gone.line == S.goneLine && !gone.sendEnabled, "the gone thread wins, and the old line is not kept behind it")
    let none = afterRefresh(S.Event(line: S.pickLine, isInfo: false)) { $0.hasThreads = false }
    #expect(none.line == S.noThreadsLine && !none.sendEnabled)
    let out = afterRefresh(sent) { $0.signedIn = false }
    #expect(out.line == "" && !out.sendEnabled)
    var goneInputs = S.Inputs()
    goneInputs.threadGone = true
    #expect(S.eventKeptThroughRefresh(sent, goneInputs) == nil)
    var noneInputs = S.Inputs()
    noneInputs.hasThreads = false
    #expect(S.eventKeptThroughRefresh(sent, noneInputs) == nil)
    var outInputs = S.Inputs()
    outInputs.signedIn = false
    #expect(S.eventKeptThroughRefresh(sent, outInputs) == nil, "signed out replaces it")
  }

  @Test func aLineReplacedBySigningOutDoesNotComeBackWhenTheOwnerSignsBackIn() {
    let sent = S.Event(line: "Sent. Your newer text is kept.", isInfo: true)
    var out = S.Inputs()
    out.signedIn = false
    let heldWhileOut = S.eventKeptThroughRefresh(sent, out)  // the panel holds what this returns
    let back = S.Inputs()
    let afterSignIn = S.eventKeptThroughRefresh(heldWhileOut, back)
    #expect(afterSignIn == nil)
    #expect(S.evaluate(back, event: afterSignIn?.line, eventIsInfo: afterSignIn?.isInfo ?? false).line == "")
  }
}
