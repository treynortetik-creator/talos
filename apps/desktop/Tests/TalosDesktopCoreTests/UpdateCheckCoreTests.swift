import Foundation
import Testing

@testable import TalosDesktopCore

/// "Check for Updates": the menu item, the window's words, the request file `talos-app update` leaves, the one-time banner, the relay
/// line and the channels flag. The core models only; the updater that uses them is in AutoUpdaterCheckNowTests.
@Suite("Check for updates: the core")
struct UpdateCheckCoreTests {
  // MARK: the menu

  @Test func theTalosMenuHasCheckForUpdatesRightUnderAbout() {
    let items = AppMenuSpec.talosMenu.items.compactMap { $0 }
    #expect(items.first?.action == .about)
    #expect(items.dropFirst().first?.action == .checkForUpdates)
    #expect(items.dropFirst().first?.title == "Check for Updates\u{2026}")
    #expect(AppMenuSpec.actions.contains(.checkForUpdates))
  }

  @Test func theMenuItemTurnsIntoUpdateToWithADotOnlyWhenOneIsWaiting() {
    let none: [UpdateStatus] = [
      .idle, .checking, .upToDate(version: "0.1.4"), .off, .downloading(version: "0.1.5"), .preparing(version: "0.1.5"),
      .restarting(version: "0.1.5"), .done(version: "0.1.5"), .failed(line: "x", logPath: "y"),
    ]
    for s in none {
      #expect(UpdateMenu.title(s) == "Check for Updates\u{2026}", "\(s)")
      #expect(!UpdateMenu.showsDot(s), "\(s)")
    }
    let waiting: [UpdateStatus] = [
      .ready(version: "0.1.5"), .waitingForQuiet(version: "0.1.5", why: ["main running"]),
      .relayBehind(version: "0.1.5", relay: "aaaaaaa", app: "bbbbbbb"), .waitingForTurn(version: "0.1.5"),
    ]
    for s in waiting {
      #expect(UpdateMenu.title(s) == "Update to 0.1.5\u{2026}", "\(s)")
      #expect(UpdateMenu.showsDot(s), "\(s)")
    }
  }

  @Test func aVersionFromAFeedCannotBreakTheMenuTitleOntoTwoLines() {
    #expect(UpdateMenu.title(.ready(version: "0.1.5\nEvil")) == "Update to 0.1.5 Evil\u{2026}")
  }

  // MARK: the window's words

  @Test func everyStateSaysItsOwnWords() {
    func h(_ s: UpdateStatus) -> String { s.words.headline }
    func d(_ s: UpdateStatus) -> String { s.words.detail }
    #expect(h(.upToDate(version: "0.1.4")) == "You\u{2019}re up to date")
    #expect(d(.upToDate(version: "0.1.4")).contains("0.1.4"))
    #expect(h(.downloading(version: "0.1.5")).contains("Downloading") && h(.downloading(version: "0.1.5")).contains("0.1.5"))
    #expect(h(.waitingForQuiet(version: "0.1.5", why: [])) == "Waiting for a quiet moment")
    #expect(h(.relayBehind(version: "0.1.5", relay: "a", app: "b")) == "Waiting for the relay")
    #expect(h(.restarting(version: "0.1.5")) == "Restarting your agent")
    #expect(h(.waitingForTurn(version: "0.1.5")) == "Waiting for your agent to finish its turn")
    #expect(d(.waitingForTurn(version: "0.1.5")).contains("the moment your agent\u{2019}s turn ends"))
    #expect(h(.done(version: "0.1.5")) == "Done")
    #expect(d(.done(version: "0.1.5")).contains("0.1.5"))
    #expect(h(.checking).contains("Checking"))
    #expect(h(.off) == "Automatic updates are off")
  }

  @Test func theQuietWaitSaysWhyAndTheTwoHourRule() {
    let cases: [(String, String)] = [
      ("background work: sleep (pid 4)", "running something in the background"), ("main has a draft", "waiting to be sent"),
      ("main needs the owner", "waiting for you"), ("the owner wrote", "you are typing"), ("main running", "busy"),
    ]
    for (raw, plain) in cases {
      let text = UpdateStatus.waitingForQuiet(version: "0.1.5", why: [raw]).words.detail
      #expect(text.contains(plain), "\(raw)")
      #expect(text.contains("2 hours"))
      #expect(text.contains("Update now does not wait"))
      #expect(!text.contains("pid"), "log words stay in the log")
    }
  }

  @Test func theRelayStateCarriesBothBuildsAndTheStepToTake() {
    let text = UpdateStatus.relayBehind(
      version: "0.1.5", relay: "1111111deadbeef", app: "2222222cafef00d").words.detail
    #expect(text.contains("1111111"), "the relay's build")
    #expect(text.contains("2222222"), "the build of the update")
    #expect(!text.contains("deadbeef"), "short builds, 7 characters")
    #expect(text.contains("redeploy the relay in Railway"))
    #expect(text.contains("Talos does not wait for the relay"), "the swap never waits for it")
    // a busy Mac as well: both reasons are on the screen
    let both = UpdateStatus.relayBehind(version: "0.1.5", relay: "1111111", app: "2222222", why: ["main running"]).words.detail
    #expect(both.contains("redeploy the relay") && both.contains("also waiting for a quiet moment") && both.contains("busy"), "\(both)")
  }

  @Test func aFailureIsOneLinePlusWhereTheLogIs() {
    let w = UpdateStatus.failed(line: "Talos couldn\u{2019}t reach the update server.\nsecond", logPath: "~/Library/Logs/Talos/supervisor.log").words
    #expect(w.detail == "Talos couldn\u{2019}t reach the update server. second Details are in ~/Library/Logs/Talos/supervisor.log.")
    #expect(!w.detail.contains("\n"))
  }

  @Test func noStateUsesTheWordsTheJargonInventoryRejects() {
    let all: [UpdateStatus] = [
      .idle, .checking, .upToDate(version: "1"), .off, .downloading(version: "1"), .ready(version: "1"),
      .waitingForQuiet(version: "1", why: ["background work: x (pid 1)"]), .relayBehind(version: "1", relay: "aaaaaaa", app: "bbbbbbb"),
      .preparing(version: "1"), .restarting(version: "1"), .done(version: "1"),
    ]
    for s in all {
      let t = (s.words.headline + " " + s.words.detail)
      for bad in ["pid", "session", "desktop.json", "Main ", "bridge", "checkout", "signature", "sha"] {
        #expect(!t.contains(bad), "\(s) says \(bad)")
      }
    }
  }

  // MARK: the banner

  @Test func theBannerComesOncePerVersion() {
    let s = UpdateStatus.ready(version: "0.1.5")
    #expect(UpdateBanner.announce(s, announced: []) == "Talos 0.1.5 is ready to update.")
    #expect(UpdateBanner.announce(s, announced: ["0.1.5"]) == nil, "after Later it stays pending, quietly")
    #expect(UpdateBanner.announce(.waitingForQuiet(version: "0.1.6", why: []), announced: ["0.1.5"]) != nil, "a newer one is news")
    #expect(UpdateBanner.announce(.checking, announced: []) == nil)
  }

  // MARK: the request file

  static let now = 1_800_000_000.0
  static func file(_ json: String) -> Data { Data(json.utf8) }
  static func iso(_ t: Double) -> String { ISOTime.string(t) }

  @Test func aFreshWellFormedRequestIsACheck() {
    #expect(CheckNowRequest.evaluate(Self.file(#"{"v":1,"action":"check","ts":"\#(Self.iso(Self.now - 5))"}"#), now: Self.now) == .check)
    #expect(CheckNowRequest.evaluate(Self.file(#"{"v":1,"action":"check","ts":\#((Self.now - 5) * 1000)}"#), now: Self.now) == .check)
    #expect(
      CheckNowRequest.evaluate(Self.file(#"{"v":1,"action":"check","ts":"\#(Self.iso(Self.now))","from":"cli","x":[1]}"#), now: Self.now)
        == .check, "an unknown extra key does not spoil the frame")
  }

  @Test func staleOrFutureOrMalformedRequestsAreIgnored() {
    let ts = Self.iso(Self.now - 5)
    let cases: [(String, CheckNowRequest.Reason)] = [
      (#"{"v":1,"action":"check","ts":"\#(Self.iso(Self.now - 11 * 60))"}"#, .stale),
      (#"{"v":1,"action":"check","ts":"\#(Self.iso(Self.now + 5 * 60))"}"#, .ahead),
      (#"{"v":2,"action":"check","ts":"\#(ts)"}"#, .wrongVersion), (#"{"v":"1","action":"check","ts":"\#(ts)"}"#, .wrongVersion),
      (#"{"v":true,"action":"check","ts":"\#(ts)"}"#, .wrongVersion), (#"{"action":"check","ts":"\#(ts)"}"#, .wrongVersion),
      (#"{"v":1,"action":"update","ts":"\#(ts)"}"#, .wrongAction), (#"{"v":1,"ts":"\#(ts)"}"#, .wrongAction),
      (#"{"v":1,"action":"check"}"#, .noTime), (#"{"v":1,"action":"check","ts":"yesterday"}"#, .noTime),
      (#"{"v":1,"action":"check","ts":true}"#, .noTime), (#"{"v":1,"action":"check","ts":-5}"#, .noTime),
      (#"[1,2]"#, .notAnObject), ("not json at all", .notAnObject), ("", .notAnObject), ("null", .notAnObject),
    ]
    for (json, why) in cases { #expect(CheckNowRequest.evaluate(Self.file(json), now: Self.now) == .ignore(why), "\(json)") }
    let big = Self.file(#"{"v":1,"action":"check","ts":"\#(ts)","pad":"\#(String(repeating: "x", count: 2000))"}"#)
    #expect(CheckNowRequest.evaluate(big, now: Self.now) == .ignore(.tooBig))
  }

  /// What `talos-app update` writes (apps/bridge/src/cli-main.ts askMacAppToCheck): the exact bytes, millisecond ISO time and a newline.
  @Test func theFileTheCliWritesIsAccepted() {
    let line = "{\"v\":1,\"action\":\"check\",\"ts\":\"2027-01-15T08:00:00.123Z\"}\n"
    let at = ISOTime.parse("2027-01-15T08:00:00.123Z") ?? 0
    #expect(CheckNowRequest.evaluate(Data(line.utf8), now: at + 3) == .check)
    #expect(CheckNowRequest.evaluate(Data(line.utf8), now: at + 3600) == .ignore(.stale))
  }

  // MARK: the relay line

  @Test func relayHexReadsOnlyACommit() {
    #expect(AutoUpdate.relayHex("ABCDEF1234567") == "abcdef1234567")
    #expect(AutoUpdate.relayHex("v0.1.4-12-gabcdef1") == "abcdef1")
    #expect(AutoUpdate.relayHex("v0.1.4-12-gabcdef1-dirty") == "abcdef1")
    #expect(AutoUpdate.relayHex("0.1.4") == nil, "a package version names no commit")
    #expect(AutoUpdate.relayHex("main") == nil)
    #expect(AutoUpdate.relayHex("abc") == nil)
  }

  @Test func relayBehindLineNamesBothBuildsAndNothingElse() {
    let line = AutoUpdate.relayBehindLine(version: "0.1.5", relay: "a1b2c3d4e5f6", app: "f6e5d4c3b2a1")
    #expect(line.contains("a1b2c3d") && line.contains("f6e5d4c"))
    #expect(!line.contains("a1b2c3d4"))
  }

  // MARK: the channels flag

  @Test func mainAlwaysPassesTheChannelFlagAfterTheOwnersOwnFlags() {
    let flag = MainChannelFlag.flag
    #expect(MainChannelFlag.ensured(["--model", "opus"]) == ["--model", "opus", flag, "server:talos-app"])
    #expect(MainChannelFlag.ensured([]) == [flag, "server:talos-app"])
    #expect(
      MainChannelFlag.ensured(["--permission-mode", "plan", "--resume", "abc"])
        == ["--permission-mode", "plan", "--resume", "abc", flag, "server:talos-app"], "after the permission-mode picker's flag")
    // a command that ends in a flag waiting for its value: the pair would become that value, so it goes first
    #expect(MainChannelFlag.ensured(["--model"]) == [flag, "server:talos-app", "--model"])
    // nothing after `--` is a flag
    #expect(MainChannelFlag.ensured(["--model", "opus", "--", "hello"]) == ["--model", "opus", flag, "server:talos-app", "--", "hello"])
  }

  @Test func aCommandThatAlreadyNamesTheFlagIsLeftAlone() {
    let a = ["--dangerously-load-development-channels", "server:talos-app", "--model", "opus"]
    #expect(MainChannelFlag.ensured(a) == a)
    // the owner's own channel stays; ours is added beside it (see MainChannelFlagSavedTests)
    let b = ["--dangerously-load-development-channels=server:other"]
    #expect(MainChannelFlag.ensured(b).first == b[0], "the owner's own channel is kept")
    #expect(MainChannelFlag.passes(MainChannelFlag.ensured(["--model", "opus"])))
    #expect(!MainChannelFlag.passes(["--", flag2]), "the flag after -- is the prompt")
    #expect(AutoConfirmGuard.channels(inArgv: MainChannelFlag.ensured(["--model", "opus"])) == ["server:talos-app"])
  }

  private let flag2 = "--dangerously-load-development-channels"
}
