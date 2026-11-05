import Foundation
import Testing
@testable import TalosDesktopCore

private func statusJSON(pid: Int = 4242, mode: String = "live", connected: Bool = true, updated: String) -> Data {
  Data(
    """
    {"v":1,"pid":\(pid),"instance":"i1","started_at":"2026-10-30T10:00:00Z","mode":"\(mode)",
     "relay":{"connected":\(connected),"last_connect_at":"2026-10-30T10:00:01Z","last_close_code":null},
     "queue_depth":2,"permission_relay":true,"updated_at":"\(updated)"}
    """.utf8)
}

@Suite("BridgeStatus")
struct BridgeStatusTests {
  let now = BridgeStatus.isoDate("2026-10-30T12:00:30Z")!
  let alive: (Int32) -> Bool = { _ in true }
  let dead: (Int32) -> Bool = { _ in false }

  @Test func healthyIsFreshAliveLiveAndConnected() throws {
    let s = try #require(BridgeStatus.decode(statusJSON(updated: "2026-10-30T12:00:10Z")))
    #expect(s.health(now: now, pidAlive: alive) == .healthy)
    #expect(s.queueDepth == 2 && s.permissionRelay)
  }

  @Test func staleAfter45Seconds() throws {
    let s = try #require(BridgeStatus.decode(statusJSON(updated: "2026-10-30T11:59:00Z")))
    #expect(s.health(now: now, pidAlive: alive) == .stale)
  }

  @Test func aDeadBridgeLeavingAFreshLookingFileIsDead() throws {
    let s = try #require(BridgeStatus.decode(statusJSON(updated: "2026-10-30T12:00:29Z")))
    #expect(s.health(now: now, pidAlive: dead) == .dead)
  }

  @Test func relayDownSupersededAndHeadless() throws {
    let a = try #require(BridgeStatus.decode(statusJSON(connected: false, updated: "2026-10-30T12:00:20Z")))
    #expect(a.health(now: now, pidAlive: alive) == .relayDown)
    let b = try #require(BridgeStatus.decode(statusJSON(mode: "superseded", updated: "2026-10-30T12:00:20Z")))
    #expect(b.health(now: now, pidAlive: alive) == .superseded)
    let c = try #require(BridgeStatus.decode(statusJSON(mode: "headless", updated: "2026-10-30T12:00:20Z")))
    #expect(c.health(now: now, pidAlive: alive) == .headless)
  }

  @Test func aTornFileIsNilNotAGuess() {
    let whole = String(decoding: statusJSON(updated: "2026-10-30T12:00:20Z"), as: UTF8.self)
    for n in [0, 5, whole.count / 2, whole.count - 3] {
      #expect(BridgeStatus.decode(Data(whole.prefix(n).utf8)) == nil, "prefix \(n)")
    }
    #expect(BridgeStatus.decode(Data("{\"v\":2}".utf8)) == nil)
    #expect(BridgeStatus.decode(statusJSON(pid: 0, updated: "2026-10-30T12:00:20Z")) == nil)
    #expect(BridgeStatus.decode(statusJSON(mode: "weird", updated: "2026-10-30T12:00:20Z")) == nil)
    #expect(BridgeStatus.decode(statusJSON(updated: "not a date")) == nil)
  }

  @Test func exactly45SecondsOldAndFutureStampsAreNotHealthy() {
    func st(_ at: Date) -> BridgeStatus {
      BridgeStatus(pid: 1, mode: .live, relayConnected: true, lastConnectAt: nil, lastCloseCode: nil, queueDepth: 0, permissionRelay: false, updatedAt: at)
    }
    let t = Date(timeIntervalSince1970: 1_000_000)
    #expect(st(t.addingTimeInterval(-44)).health(now: t, pidAlive: { _ in true }) == .healthy)
    #expect(st(t.addingTimeInterval(-45)).health(now: t, pidAlive: { _ in true }) == .stale)
    #expect(st(t.addingTimeInterval(3600)).health(now: t, pidAlive: { _ in true }) == .stale)
    #expect(st(t.addingTimeInterval(2)).health(now: t, pidAlive: { _ in true }) == .healthy, "small clock skew is fine")
  }

  @Test func relayHealthz() {
    #expect(RelayHealth.ok(status: 200, body: Data("{\"ok\":true,\"version\":\"1\"}".utf8)))
    #expect(!RelayHealth.ok(status: 200, body: Data("{\"ok\":false}".utf8)))
    #expect(!RelayHealth.ok(status: 503, body: Data("{\"ok\":true}".utf8)))
    #expect(!RelayHealth.ok(status: 200, body: Data("<html>".utf8)))
  }
}

@Suite("HealthModel")
struct HealthModelTests {
  func icon(_ i: HealthModel.Inputs) -> HealthSummary.Icon { HealthModel.summarize(i).icon }

  @Test func fourIconStates() {
    #expect(icon(.init(session: .running(activity: "idle"), bridge: .healthy, relayReachable: true)) == .ok)
    #expect(icon(.init(session: .running(activity: "busy"), bridge: .healthy, relayReachable: true)) == .working)
    #expect(icon(.init(session: .running(activity: "idle"), badge: 2, bridge: .healthy, relayReachable: true)) == .needsYou)
    #expect(icon(.init(session: .running(activity: "idle"), sessionNeedsYou: true)) == .needsYou)
    #expect(icon(.init(session: .notStarted)) == .down)
    #expect(icon(.init(session: .stopped("crash loop"))) == .down)
    #expect(icon(.init(session: .running(activity: "idle"), bridge: .dead)) == .down)
    #expect(icon(.init(session: .running(activity: "idle"), bridge: nil)) == .unknown)
    #expect(icon(.init(session: .running(activity: "idle"), bridge: .healthy, relayReachable: false)) == .down)
    #expect(icon(.init(session: .blocked)) == .needsYou)
  }

  /// D4 review: unknown is neither fine nor down. Until the bridge writes status.json every Mac is in this state.
  @Test func noStatusFileIsUnknownNotFineAndNotDown() {
    let s = HealthModel.summarize(.init(session: .running(activity: "idle"), bridge: nil, relayReachable: true))
    #expect(s.icon == .unknown)
    #expect(s.lines.contains("Bridge: unknown"))
    #expect(icon(.init(session: .running(activity: "busy"), bridge: nil, relayReachable: true)) == .unknown)
  }

  @Test func aRelayNotCheckedYetOrNotSetIsUnknownToo() {
    #expect(icon(.init(session: .running(activity: "idle"), bridge: .healthy, relayReachable: nil)) == .unknown)
    let s = HealthModel.summarize(.init(session: .running(activity: "idle"), bridge: .healthy, relayReachable: nil, relayConfigured: false))
    #expect(s.lines.contains("Relay: not set (Mac settings → Connection)"))
  }

  @Test func staleRelayDownAndHeadlessAreDownNotFine() {
    for h in [BridgeStatus.Health.stale, .relayDown, .headless] {
      #expect(icon(.init(session: .running(activity: "idle"), bridge: h, relayReachable: true)) == .down, "\(h)")
    }
  }

  @Test func aBridgeAbsentWhileStartingOrRestartingIsNotAnOutage() {
    #expect(icon(.init(session: .starting, bridge: .dead)) == .working)
    #expect(icon(.init(session: .restarting, bridge: .stale, relayReachable: true)) == .working)
  }

  @Test func needsYouOutranksBusyButDownOutranksNeedsYou() {
    #expect(icon(.init(session: .running(activity: "busy"), badge: 1)) == .needsYou)
    #expect(icon(.init(session: .notStarted, badge: 5)) == .down)
  }

  @Test func theFirstLineSpellsItOut() {
    let s = HealthModel.summarize(.init(session: .running(activity: "busy"), bridge: .healthy, relayReachable: true, host: "tmux"))
    #expect(s.lines.first == "Session: busy · tmux")
    #expect(s.lines.contains("Bridge: connected") && s.lines.contains("Relay: reachable"))
  }
}

@Suite("NotificationPolicy")
struct NotificationPolicyTests {
  @Test func supervisorTextsAreFixedPhrases() {
    #expect(NotificationPolicy.notice(.needsYou, agent: "Talos").body == "Talos needs you at the Mac")
    #expect(NotificationPolicy.notice(.restartedAfterCrash, agent: "Talos").quiet)
    #expect(NotificationPolicy.notice(.stoppedRestarting, agent: "Talos").body == "Talos stopped restarting (crash loop)")
  }

  @Test func theAgentNameCannotCarryControlCharsOrLength() {
    let n = NotificationPolicy.notice(.needsYou, agent: "Evil\u{7}\nName" + String(repeating: "x", count: 100))
    #expect(!n.body.contains("\n") && !n.body.contains("\u{7}"))
    #expect(n.title.count <= 40)
    #expect(NotificationPolicy.notice(.needsYou, agent: "  ").title == "Talos")
  }

  @Test func webNotificationsOnlyWhileTheWindowIsNotKey() {
    #expect(NotificationPolicy.web(title: "T", body: "b", navigate: "/t/general", tag: "x", windowIsKey: true) == nil)
    let n = NotificationPolicy.web(title: "T", body: "b", navigate: "/t/general", tag: "thread:general", windowIsKey: false)
    #expect(n?.navigate == "/t/general")
    #expect(n?.tag == "web:thread:general")
  }

  @Test func aBannerBodyIsOneOfThePushPhrasesOrNewActivity() {
    func body(_ b: String) -> String? {
      NotificationPolicy.web(title: "Talos", body: b, navigate: "/", tag: nil, windowIsKey: false)?.body
    }
    for good in ["New reply in General", "Needs you in a thread", "Answer ready in Work", "Overnight: 3 items", "Talos's Mac session stopped",
      "New device pinned", "Your scheduler needs you", "Talos's Mac is back"]
    {
      #expect(body(good) == good, "\(good)")
    }
    for bad in ["the biopsy came back", "New reply in General\nand more text", "New reply in " + String(repeating: "x", count: 60),
      "Hello from Dr Lee", "", "New reply"]
    {
      #expect(body(bad) == "New activity", "\(bad.debugDescription)")
    }
  }

  @Test func webNotificationsRefuseOutOfAppTargetsAndAreCapped() {
    #expect(NotificationPolicy.web(title: "T", body: "b", navigate: "/media/x", tag: nil, windowIsKey: false) == nil)
    #expect(NotificationPolicy.web(title: "T", body: "b", navigate: "https://evil.example", tag: nil, windowIsKey: false) == nil)
    let n = NotificationPolicy.web(
      title: String(repeating: "t", count: 500), body: String(repeating: "b", count: 500), navigate: "/", tag: nil,
      windowIsKey: false)
    #expect(n?.title.count == 40 && n?.body == "New activity")
  }

  @Test func theRateLimiterDropsTheSameTagInsideTheWindow() {
    var r = NotificationPolicy.RateLimiter(window: 60)
    let t0 = Date(timeIntervalSince1970: 1000)
    let first = r.allow("a", now: t0)
    let again = r.allow("a", now: t0.addingTimeInterval(30))
    let other = r.allow("b", now: t0.addingTimeInterval(30))
    let later = r.allow("a", now: t0.addingTimeInterval(61))
    #expect(first && !again && other && later)
  }
}

@Suite("QuietWindow")
struct QuietWindowTests {
  func cfg(_ s: String, _ e: String, tz: String = "Etc/GMT+7") -> Data {
    Data("{\"quiet_window\":{\"start\":\"\(s)\",\"end\":\"\(e)\"},\"timezone\":\"\(tz)\"}".utf8)
  }
  // 2026-01-06 03:00 UTC = 20:00 on 2026-01-05 in a fixed UTC-7 zone (no DST)
  let eightPM = Date(timeIntervalSince1970: 1_767_668_400)

  @Test func aWindowThatWrapsMidnight() throws {
    let q = try #require(QuietWindow.read(cfg("20:30", "04:00")))
    #expect(!q.isQuiet(eightPM))
    #expect(q.isQuiet(eightPM.addingTimeInterval(30 * 60)))  // 20:30
    #expect(q.isQuiet(eightPM.addingTimeInterval(6 * 3600)))  // 02:00
    #expect(!q.isQuiet(eightPM.addingTimeInterval(9 * 3600)))  // 05:00
  }

  @Test func aSameDayWindowAndAnEmptyOne() throws {
    let q = try #require(QuietWindow.read(cfg("19:00", "21:00")))
    #expect(q.isQuiet(eightPM))
    #expect(try #require(QuietWindow.read(cfg("08:00", "08:00"))).isQuiet(eightPM) == false)
  }

  @Test func theOwnersTimeZoneDecides() throws {
    let utc = try #require(QuietWindow.read(cfg("19:00", "21:00", tz: "UTC")))
    #expect(!utc.isQuiet(eightPM))  // 03:00 UTC
  }

  @Test func garbageAndMissingAreNoWindow() {
    #expect(QuietWindow.read(nil) == nil)
    #expect(QuietWindow.read(Data("{}".utf8)) == nil)
    #expect(QuietWindow.read(cfg("25:00", "04:00")) == nil)
    #expect(QuietWindow.read(cfg("20:00", "04:00", tz: "Mars/Olympus")) == nil)
    #expect(QuietWindow.read(Data("{\"quiet_window\":null,\"timezone\":\"UTC\"}".utf8)) == nil)
  }
}
