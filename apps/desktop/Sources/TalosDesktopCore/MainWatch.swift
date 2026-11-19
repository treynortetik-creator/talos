import Foundation

/// Two ways a running Main goes silent that only its bridge's `status.json` shows (the contract's `MAIN_RESTART.relay_down_s`,
/// `unseen_s` and `unseen_quiet_s`, mirrored in `MainRestartContract`):
/// - the bridge is live (Main's MCP server is up) but has reported no relay connection for `relayDownS`: the bridge's reconnect
///   backoff (1, 2, 5, 10, 30 s, then every 60 s, each +/-20%) re-dials a relay that is back within about 72 s, so a relay restart
///   or a short drop never gets this far;
/// - the agent was told about an owner message (`unseen_oldest_at`) and has made no bridge tool call for `unseenS`, its pane has
///   printed nothing for `unseenQuietS`, and nothing since that message at all. A Main that took the message in prints it and its
///   turn, even when the answer needs no tool; a frozen one prints nothing. (A Main hung inside a tool call keeps drawing its
///   spinner, so it is not caught here.)
/// Pure: the supervisor feeds it one reading per tick and raises or clears what it says. Times are on the awake clock (stopped
/// while the Mac sleeps), so a night asleep is never an outage; a value first seen by this copy counts from when it was seen.
public struct MainWatch: Equatable, Sendable {
  public var relayDownAfter = MainRestartContract.relayDownS
  public var unseenAfter = MainRestartContract.unseenS
  public var quietAfter = MainRestartContract.unseenQuietS
  /// tmux reports pane output in whole seconds, and Claude draws a message a moment after the bridge tells it: output this close
  /// after the message is the message's own line, not a turn.
  public static let printSlack: Double = 2
  /// Without a live reading for this long the bridge is gone (stale or dead), and what it last said about the relay is not news.
  public static let liveFor: Double = 60

  var lastLiveAt: Double?
  var relayDownSince: Double?
  var closeCode: Int?
  var unseen: Date?
  var unseenSince: Double?
  /// Main printed after the current message: it read it, whatever `unseen` still says.
  var printedSince = false
  /// The current message was told to the owner: it stays told until the message is taken in (a pane redraw after the alarm, from
  /// the owner opening the pane, does not end it).
  var latched = false
  var paneOutput: Date?
  var paneChangedAt: Double?
  /// The stall alarm (`observeStall`): what the pane's body (counter masked) and the transcript's size were at the last reading, and
  /// when either last changed (awake clock; the message's first sighting starts it).
  public var stallAfter = MainRestartContract.stallS
  public var stallThinkingAfter = MainRestartContract.stallThinkingS
  /// With no working line on the pane and the model's turn pending in the transcript (`observeStall`).
  public var stallBlankAfter = MainRestartContract.stallBlankS
  var stallBody: String?
  var stallSize: Int64?
  var stallTail: MainStall.Transcript.Tail?
  var stallChangedAt: Double?
  var stallWorking = false
  /// This reading found the blank case: no working line, and the transcript read right now says the model's turn is pending.
  var stallBlankNow = false
  var stallThinking = false
  /// Told once for this message; `stallActive` is whether the line is up now (anything changing takes it down, never raises it again).
  var stallTold = false
  var stallActive = false
  /// What the auto-unstick did for the stalled message (the supervisor sets it; `SupervisorUnstick`).
  public enum Unstick: Equatable, Sendable {
    /// Nothing was pressed: the setting is off, the bridge cannot resend (older), someone is typing, a dialog is up, or the gate refused.
    case none
    /// Esc went and the bridge was asked to deliver the message again; its answer (or the wait for it) is still to come.
    case awaiting(min: Int)
    /// Esc went and the bridge said it delivered the message again. `min` is how long it had been stuck.
    case resent(min: Int)
    /// Esc went but the message was not sent again: the bridge said it could not, or did not answer in time, or the request could not be written.
    case failed(min: Int)
  }
  /// The request sent after an Esc, until the bridge's answer (`MainResendAnswer`) or `answerWithin` of awake time. Kept apart from the
  /// message's own state: the line must be told even when the message was taken in meanwhile.
  public struct Awaiting: Equatable, Sendable {
    public var unseenAt: Date
    public var since: Double
    public var min: Int
  }
  /// How long the bridge has to answer a resend request (its poll runs every 10 s) before the owner is told it was not sent again.
  public static let answerWithin: Double = 15
  /// Pressed Esc: at most one per message. Spent only when Esc was actually sent, so a refusal (the owner typing, a passing redraw,
  /// a dialog) leaves the message another try, at most one Esc ever.
  var unstickTried = false
  /// The bridge says it answers resend requests (`BridgeStatus.mainResend`); the Mac presses nothing otherwise.
  public private(set) var bridgeResends = false
  var unstickNextTry: Double = 0
  public private(set) var unstick: Unstick = .none
  public private(set) var awaiting: Awaiting?

  public init() {}

  /// One tick. `status` is this start's bridge status only when it is live (fresh, `live`, from Main's own process); nil changes
  /// nothing. `paneOutputAt` is when the pane last printed, nil when it was not read.
  public mutating func observe(status: BridgeStatus?, paneOutputAt: Date?, awakeNow: Double) {
    if let out = paneOutputAt, out != paneOutput {
      paneOutput = out
      paneChangedAt = awakeNow
    }
    if let s = status {
      lastLiveAt = awakeNow
      bridgeResends = s.mainResend
      relayDownSince = s.relayConnected ? nil : (relayDownSince ?? awakeNow)
      closeCode = s.lastCloseCode
      if s.unseenOldestAt != unseen {
        unseen = s.unseenOldestAt
        unseenSince = unseen == nil ? nil : awakeNow
        printedSince = false
        latched = false
        stallBody = nil
        stallSize = nil
        stallTail = nil
        stallThinking = false
        stallChangedAt = unseen == nil ? nil : awakeNow
        stallWorking = false
        stallBlankNow = false
        stallTold = false
        stallActive = false
        unstickTried = false
        unstickNextTry = 0
        unstick = .none
      }
    }
    if let u = unseen, !latched, let out = paneOutput, out.timeIntervalSince(u) >= Self.printSlack { printedSince = true }
  }

  /// The pane's output time is needed only while a message waits and Main has not printed since: the supervisor reads it (a tmux
  /// call) only then.
  public var wantsPaneOutput: Bool { unseen != nil && !printedSince && !latched }

  /// Whether the supervisor should read the pane's rows and the transcript's size this tick: while a message waits and its stall is
  /// not yet told, or is up (to take it down when something moves).
  public var wantsStallReads: Bool { unseen != nil && (!stallTold || stallActive) }

  /// One reading for the stall alarm: the pane's rows (nil when they could not be read) and Main's transcript (nil when it is missing
  /// or unreadable: that signal is then unknown and the pane and the file's size decide). A signal that cannot be read neither moves
  /// nor holds the wait. Fires once per message when, for `stallAfter` of awake time (`stallThinkingAfter` while the label says
  /// thinking) since the model's turn came up (the newest user or tool_result record nothing from the model follows) or since
  /// anything last moved, the working line has been on the screen with its body (elapsed counter masked) and the transcript's size
  /// unchanged. With NO working line on the pane the same holds after `stallBlankAfter`, but only while this reading's transcript says
  /// the model's turn is pending (`awaitingModel`): a pane gone blank under a request that never answered. A transcript whose newest turn is the model's (a reply, or a tool_use still running) is never a stall.
  /// Once told, the line stays until the message is taken in (`observe`) or the model's record appears: the pane alone, which the
  /// owner opening it redraws, never takes it away.
  public mutating func observeStall(rows: [String]?, transcript: MainStall.Transcript?, awakeNow: Double) {
    guard unseen != nil, wantsStallReads else { return }
    var moved = false
    if let rows {
      let body = MainStall.maskedBody(rows: rows)
      if let old = stallBody, old != body { moved = true }
      stallBody = body
      stallWorking = MainStall.hasWorkingLine(rows: rows)
      stallThinking = MainStall.isThinking(rows: rows)
    }
    var answered = false
    if let t = transcript {
      if let old = stallSize, old != t.size { moved = true }
      stallSize = t.size
      if let old = stallTail, old != t.tail { moved = true }
      stallTail = t.tail
      answered = t.tail == .answered
    }
    if moved { stallChangedAt = awakeNow }
    if answered {
      stallActive = false
      stallBlankNow = false
      return
    }
    // A blank pane (no working line) counts only on a transcript read right now that says the model's turn is pending: an unreadable
    // transcript with a blank pane is an idle prompt, and an answered one is never a stall.
    var blankPending = false
    if !stallWorking, stallBody != nil, case .awaitingModel? = transcript?.tail { blankPending = true }
    stallBlankNow = blankPending
    var thinkingTurn = false
    if case .thinking? = stallTail { thinkingTurn = true }
    let limit = blankPending ? stallBlankAfter : (stallThinking || thinkingTurn ? stallThinkingAfter : stallAfter)
    if !stallTold, stallWorking || blankPending, stallBody != nil, let since = stallChangedAt, awakeNow - since >= limit {
      stallTold = true
      stallActive = true
    }
  }

  /// The time of the message whose model request looks stuck while the line is up, else nil.
  public func stalled() -> Date? { stallActive ? unseen : nil }

  /// The stalled message's time when the unstick may try now: stalled, the bridge can resend, no Esc spent for this message, and not
  /// inside the wait after a refused try. Does not spend anything: `pressed` does, once an Esc went.
  public func takeUnstick(awakeNow: Double) -> Date? {
    guard stallActive, bridgeResends, let u = unseen, !unstickTried, awakeNow >= unstickNextTry else { return nil }
    return u
  }

  /// The blank case holds right now for an Escape: this tick's reading had no working line and a transcript whose newest turn is the
  /// model's pending one, and nothing has changed for `stallBlankAfter` (`KeyGuard.Intent.interruptBlank`).
  public func blankStallReady(awakeNow: Double) -> Bool {
    stallActive && stallBlankNow && (stallChangedAt.map { awakeNow - $0 >= stallBlankAfter } ?? false)
  }

  /// The try was refused (typing, a dialog, the gate): look again after `Self.retryAfter`, no Esc spent.
  public mutating func refused(awakeNow: Double) { unstickNextTry = awakeNow + Self.retryAfter }
  public static let retryAfter: Double = 15

  /// Esc went for the message at `unseenAt`, and the resend request was written.
  public mutating func pressed(unseenAt: Date, min: Int, awakeNow: Double) {
    unstickTried = true
    awaiting = Awaiting(unseenAt: unseenAt, since: awakeNow, min: min)
    unstick = .awaiting(min: min)
  }

  /// Esc went but the request could not be written: the message cannot be sent again.
  public mutating func pressedNoRequest(min: Int) {
    unstickTried = true
    unstick = .failed(min: min)
  }

  /// One look at the bridge's answer (nil: none readable yet). Returns the finished request and whether the message was sent again,
  /// once, when the answer for it came or `answerWithin` passed without one.
  public mutating func settleAwaiting(answer: MainResendAnswer?, awakeNow: Double) -> (Awaiting, sent: Bool)? {
    guard let a = awaiting else { return nil }
    let sent: Bool
    if let ans = answer, abs(ans.unseenAt.timeIntervalSince(a.unseenAt)) < 0.001 {
      sent = ans.sent
    } else if awakeNow - a.since >= Self.answerWithin {
      sent = false
    } else {
      return nil
    }
    awaiting = nil
    if unseen == a.unseenAt { unstick = sent ? .resent(min: a.min) : .failed(min: a.min) }
    return (a, sent)
  }


  /// The bridge has been live and off the relay for `relayDownAfter`: the last close code it reported, if any.
  public func relayDown(awakeNow: Double) -> (down: Bool, closeCode: Int?) {
    guard let since = relayDownSince, awakeNow - since >= relayDownAfter, let live = lastLiveAt, awakeNow - live < Self.liveFor
    else { return (false, nil) }
    return (true, closeCode)
  }

  /// When the message Main is not reading was first told to it, nil while it is reading. Once true, true until that message is
  /// taken in (`unseen_oldest_at` changes).
  public mutating func notReading(awakeNow: Double) -> Date? {
    guard let u = unseen else { return nil }
    if latched { return u }
    guard !printedSince, let since = unseenSince, awakeNow - since >= unseenAfter,
      let changed = paneChangedAt, awakeNow - changed >= quietAfter
    else { return nil }
    latched = true
    return u
  }
}

/// The bridge's answer to a resend request (`main-resend-result.json`, apps/bridge/src/main-resend.ts): which message, and whether it was
/// delivered again. Anything else in the file (a field this build does not know, an outcome it does not) is read as "not sent".
public struct MainResendAnswer: Equatable, Sendable {
  public var unseenAt: Date
  public var sent: Bool
  public init(unseenAt: Date, sent: Bool) {
    self.unseenAt = unseenAt
    self.sent = sent
  }
  public static func decode(_ data: Data) -> MainResendAnswer? {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], JSONValue.int(o["v"]) == 1,
      let at = (o["unseen_at"] as? String).flatMap(BridgeStatus.isoDate)
    else { return nil }
    return MainResendAnswer(unseenAt: at, sent: o["outcome"] as? String == "sent")
  }
}
