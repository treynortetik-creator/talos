import Foundation
import Testing
@testable import TalosDesktopCore

/// Main running with its bridge live, and still nobody hears the owner: the relay is out of reach, or Main stopped reading.
@Suite struct MainWatchTests {
  private func status(connected: Bool = true, closeCode: Int? = nil, unseen: Date? = nil) -> BridgeStatus {
    var s = BridgeStatus(
      pid: 42, mode: .live, relayConnected: connected, lastConnectAt: nil, lastCloseCode: closeCode, queueDepth: 0,
      permissionRelay: false, updatedAt: Date())
    s.unseenOldestAt = unseen
    return s
  }

  @Test func theRelayDownIsToldOnlyAfterTheContractsWaitAndClearsOnReconnect() {
    var w = MainWatch()
    w.observe(status: status(connected: false, closeCode: 4001), paneOutputAt: nil, awakeNow: 0)
    w.observe(status: status(connected: false, closeCode: 4001), paneOutputAt: nil, awakeNow: MainRestartContract.relayDownS - 1)
    #expect(w.relayDown(awakeNow: MainRestartContract.relayDownS - 1).down == false)
    let down = w.relayDown(awakeNow: MainRestartContract.relayDownS)
    #expect(down.down && down.closeCode == 4001)
    w.observe(status: status(connected: true), paneOutputAt: nil, awakeNow: 200)
    #expect(w.relayDown(awakeNow: 500).down == false)
  }

  /// A drop the backoff mends (it re-dials a relay that is back within about 72 s) never adds up across two drops.
  @Test func twoShortDropsAreNotOneLongOne() {
    var w = MainWatch()
    w.observe(status: status(connected: false), paneOutputAt: nil, awakeNow: 0)
    w.observe(status: status(connected: true), paneOutputAt: nil, awakeNow: 100)
    w.observe(status: status(connected: false), paneOutputAt: nil, awakeNow: 110)
    w.observe(status: status(connected: false), paneOutputAt: nil, awakeNow: 200)
    #expect(w.relayDown(awakeNow: 200).down == false)
    w.observe(status: status(connected: false), paneOutputAt: nil, awakeNow: 110 + MainRestartContract.relayDownS)
    #expect(w.relayDown(awakeNow: 110 + MainRestartContract.relayDownS).down)
  }

  @Test func aReadingThatSaysNothingChangesNothing() {
    var w = MainWatch()
    w.observe(status: status(connected: false), paneOutputAt: nil, awakeNow: 0)
    w.observe(status: nil, paneOutputAt: nil, awakeNow: 100)
    w.observe(status: status(connected: false), paneOutputAt: nil, awakeNow: 150)
    #expect(w.relayDown(awakeNow: MainRestartContract.relayDownS).down, "a torn or stale read does not restart the wait")
  }

  @Test func aMessageWaitingWithAStillPaneIsNotReadingAndClearsWhenTaken() {
    let printed = Date(timeIntervalSince1970: 1_000)
    let told = printed.addingTimeInterval(5)
    var w = MainWatch()
    w.observe(status: status(unseen: told), paneOutputAt: printed, awakeNow: 0)
    #expect(w.notReading(awakeNow: MainRestartContract.unseenS - 1) == nil)
    #expect(w.notReading(awakeNow: MainRestartContract.unseenS) == told)
    // any tool call clears the field: the episode is over
    w.observe(status: status(unseen: nil), paneOutputAt: printed, awakeNow: 400)
    #expect(w.notReading(awakeNow: 1_000) == nil)
  }

  /// "thanks": Main prints the message and a short turn, calls no tool, and goes quiet. That is a Main that read it. The message's
  /// own line, drawn within a moment of it (tmux counts in whole seconds), is not a turn.
  @Test func aPaneThatPrintedAfterTheMessageIsReading() {
    let told = Date(timeIntervalSince1970: 1_000)
    var w = MainWatch()
    w.observe(status: status(unseen: told), paneOutputAt: told.addingTimeInterval(3), awakeNow: 0)
    #expect(w.notReading(awakeNow: 10_000) == nil)
    var drawn = MainWatch()
    drawn.observe(status: status(unseen: told), paneOutputAt: told.addingTimeInterval(1), awakeNow: 0)
    #expect(drawn.notReading(awakeNow: 10_000) == told)
  }

  /// Once told, a redraw (the owner opening the pane resizes it) does not take the line away: only the message being taken in does.
  @Test func oneToldStaysToldUntilTheMessageIsTakenIn() {
    let told = Date(timeIntervalSince1970: 1_000)
    var w = MainWatch()
    w.observe(status: status(unseen: told), paneOutputAt: told.addingTimeInterval(-10), awakeNow: 0)
    #expect(w.notReading(awakeNow: 400) == told)
    #expect(!w.wantsPaneOutput, "no more tmux reads for a message already told")
    w.observe(status: status(unseen: told), paneOutputAt: told.addingTimeInterval(500), awakeNow: 401)
    #expect(w.notReading(awakeNow: 402) == told)
    let next = told.addingTimeInterval(600)
    w.observe(status: status(unseen: next), paneOutputAt: told.addingTimeInterval(500), awakeNow: 403)
    #expect(w.notReading(awakeNow: 404) == nil, "a new message starts over")
    #expect(w.notReading(awakeNow: 403 + MainRestartContract.unseenS) == next, "and is told in its turn")
  }

  /// A bridge that stopped writing (stale, dead) is no longer "running but off the relay".
  @Test func theRelayLineEndsWhenTheBridgeStopsBeingLive() {
    var w = MainWatch()
    w.observe(status: status(connected: false), paneOutputAt: nil, awakeNow: 0)
    w.observe(status: status(connected: false), paneOutputAt: nil, awakeNow: 200)
    #expect(w.relayDown(awakeNow: 200).down)
    #expect(w.relayDown(awakeNow: 200 + MainWatch.liveFor).down == false)
  }

  @Test func thePaneMustHaveBeenQuietForTheContractsTime() {
    let told = Date(timeIntervalSince1970: 1_000)
    var w = MainWatch()
    w.quietAfter = 400  // longer than unseenS, to see the quiet on its own
    w.observe(status: status(unseen: told), paneOutputAt: told.addingTimeInterval(-60), awakeNow: 0)
    #expect(w.notReading(awakeNow: 399) == nil)
    #expect(w.notReading(awakeNow: 400) == told)
  }

  /// The wait is awake time since this copy first saw the message, never the message's own (wall-clock) age: a message told an
  /// hour ago, before a night's sleep or before the app opened, is not an alarm on the first look.
  @Test func theWaitCountsFromWhenThisCopySawTheMessage() {
    let told = Date().addingTimeInterval(-3600)
    var w = MainWatch()
    w.observe(status: status(unseen: told), paneOutputAt: told.addingTimeInterval(-1), awakeNow: 50)
    #expect(w.notReading(awakeNow: 50 + MainRestartContract.unseenS - 1) == nil)
    #expect(w.notReading(awakeNow: 50 + MainRestartContract.unseenS) == told)
  }

  @Test func theStatusFileCarriesTheUnseenTimeAndAnOlderOneSaysNothing() throws {
    let base = #"{"v":1,"pid":7,"mode":"live","relay":{"connected":true},"queue_depth":0,"updated_at":"2026-11-10T10:00:00.000Z""#
    let with = try #require(BridgeStatus.decode(Data((base + #","unseen_oldest_at":"2026-11-10T09:55:00.000Z"}"#).utf8)))
    #expect(with.unseenOldestAt == Date(timeIntervalSince1970: 1_794_304_500))
    #expect(try #require(BridgeStatus.decode(Data((base + "}").utf8))).unseenOldestAt == nil)
    #expect(try #require(BridgeStatus.decode(Data((base + #","unseen_oldest_at":null}"#).utf8))).unseenOldestAt == nil)
  }

  @Test func aDamagedBridgeConfigIsNamedAndAGoodOrMissingOneIsNot() {
    let why = BridgeConfigCheck.problem(Data("{not json".utf8), path: "/home/alex/.config/talos/app/config.json")
    #expect(why?.contains("config.json") == true && why?.contains("damaged") == true)
    #expect(BridgeConfigCheck.problem(Data("[1,2]".utf8), path: "p") != nil, "the bridge wants an object")
    #expect(BridgeConfigCheck.problem(Data(#"{"v":1}"#.utf8), path: "p") == nil)
    #expect(BridgeConfigCheck.problem(nil, path: "p") == nil)
  }
}
