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
      relayDownSince = s.relayConnected ? nil : (relayDownSince ?? awakeNow)
      closeCode = s.lastCloseCode
      if s.unseenOldestAt != unseen {
        unseen = s.unseenOldestAt
        unseenSince = unseen == nil ? nil : awakeNow
        printedSince = false
        latched = false
      }
    }
    if let u = unseen, !latched, let out = paneOutput, out.timeIntervalSince(u) >= Self.printSlack { printedSince = true }
  }

  /// The pane's output time is needed only while a message waits and Main has not printed since: the supervisor reads it (a tmux
  /// call) only then.
  public var wantsPaneOutput: Bool { unseen != nil && !printedSince && !latched }

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
