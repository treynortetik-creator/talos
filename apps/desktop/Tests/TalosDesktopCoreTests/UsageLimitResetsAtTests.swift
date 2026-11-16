import Foundation
import Testing
@testable import TalosDesktopCore

/// `needs_you.resets_at` (protocol WorkerNeedsYou.resets_at): the usage-limit screen's reset as an instant, the next such moment after the
/// screen was read, in the zone the screen names, else the Mac's own; absent when it does not parse. The zones here are examples only.
@Suite("The usage-limit reset as an instant")
struct UsageLimitResetsAtTests {
  static let paris = TimeZone(identifier: "Europe/Paris")!
  static let tokyo = TimeZone(identifier: "Asia/Tokyo")!
  static let minus5 = TimeZone(identifier: "Etc/GMT+5")!

  func utc(_ s: String) -> Date { Date(timeIntervalSince1970: ISOTime.parse(s)!) }
  func at(_ resets: String?, _ read: String, _ zone: TimeZone = minus5) -> String? {
    UsageLimitScreen.resetsAt(resets, after: utc(read), zone: zone).map { ISOTime.string($0.timeIntervalSince1970) }
  }

  @Test func aClockTimeIsTheNextOneInTheZoneTheScreenNames() {
    // 11:00 in Paris (UTC+1 in November): 4pm is later the same day
    #expect(at("4pm (Europe/Paris)", "2026-11-13T10:00:00Z") == "2026-11-13T15:00:00.000Z")
    // the Mac's zone does not matter when the screen names one
    #expect(at("4pm (Europe/Paris)", "2026-11-13T10:00:00Z", Self.tokyo) == "2026-11-13T15:00:00.000Z")
    // summer time in Paris (UTC+2)
    #expect(at("Jul 3, 4pm (Europe/Paris)", "2026-07-01T00:00:00Z") == "2026-07-03T14:00:00.000Z")
  }

  @Test func pastTheTimeTodayIsTomorrowAcrossMidnight() {
    // 22:30 in Paris: 4pm has gone, so it is tomorrow's, across the local midnight
    #expect(at("4pm (Europe/Paris)", "2026-11-13T21:30:00Z") == "2026-11-14T15:00:00.000Z")
    // 23:50 in Tokyo, reset at 1:30am: ten past midnight later, the next local day
    #expect(at("1:30am (Asia/Tokyo)", "2026-11-13T14:50:00Z") == "2026-11-13T16:30:00.000Z")
    // read at the very moment: the next such moment is strictly after it
    #expect(at("4pm (Europe/Paris)", "2026-11-13T15:00:00Z") == "2026-11-14T15:00:00.000Z")
    // a dated reset already past this year is next year's
    #expect(at("Jan 2, 9am (Asia/Tokyo)", "2026-11-13T00:00:00Z") == "2027-01-02T00:00:00.000Z")
    // a 24-hour clock
    #expect(at("15:10 (Asia/Tokyo)", "2026-11-13T00:00:00Z") == "2026-11-13T06:10:00.000Z")
  }

  @Test func noZoneOnTheScreenIsTheMacsOwn() {
    #expect(at("3:10pm", "2026-11-13T00:00:00Z", Self.minus5) == "2026-11-13T20:10:00.000Z")
    #expect(at("3:10pm", "2026-11-13T00:00:00Z", Self.tokyo) == "2026-11-13T06:10:00.000Z")
    #expect(at("Aug 8, 3:10pm", "2026-11-13T00:00:00Z", Self.paris) == "2027-08-08T13:10:00.000Z")
    // 12am and 12pm
    #expect(at("12am", "2026-11-13T12:00:00Z", Self.minus5) == "2026-11-14T05:00:00.000Z")
    #expect(at("12pm", "2026-11-13T12:00:00Z", Self.minus5) == "2026-11-13T17:00:00.000Z")
  }

  @Test func whatDoesNotNameAMomentHasNone() {
    for r: String? in [nil, "", "Aug 8", "Feb 30, 4pm", "soon", "13pm", "25:00", "in 3 hours"] {
      #expect(at(r, "2026-11-13T00:00:00Z") == nil, "\(String(describing: r))")
    }
    // an unknown zone in brackets is not the screen's zone: the Mac's own is used (the Info never keeps one the system does not know)
    #expect(at("4pm (Mars/Olympus)", "2026-11-13T00:00:00Z", Self.minus5) == "2026-11-13T21:00:00.000Z")
  }

  /// From the screen as the reader reads it to the instant: the same words the owner's line names.
  @Test func theSyntheticScreensResetIsAnInstant() throws {
    let info = try #require(UsageLimitScreen.read(try RealScreens.rows("usage-limit", in: "synthetic")))
    let d = try #require(info.resets.flatMap { UsageLimitScreen.resetsAt($0, after: utc("2026-11-13T22:00:00Z"), zone: Self.tokyo) })
    #expect(ISOTime.string(d.timeIntervalSince1970) == "2026-11-14T15:00:00.000Z")
    // a screen with no reset words has no instant
    let none = try #require(UsageLimitScreen.read(try RealScreens.rows("usage-limit-weekly-model", in: "synthetic")))
    #expect(UsageLimitScreen.resetsAt(none.resets, after: utc("2026-11-13T22:00:00Z"), zone: Self.tokyo) == nil)
  }

  @Test func mainsFileCarriesItOnlyForTheUsageLimit() throws {
    func needsYou(_ kind: String, _ resetsAt: Double?) throws -> [String: Any]? {
      let d = MainRestartCheck.encode(
        at: 1_800_000_000, verdict: .init(willReturn: true, reasons: []), last: nil, needsYou: (kind, 1_800_000_000), resetsAt: resetsAt)
      return try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])["needs_you"] as? [String: Any]
    }
    let ul = try #require(try needsYou(UsageLimitScreen.kind, 1_800_003_600))
    #expect(ul["resets_at"] as? String == ISOTime.string(1_800_003_600))
    #expect(ul["kind"] as? String == "usage limit")
    #expect(try needsYou(UsageLimitScreen.kind, nil)?["resets_at"] == nil, "unparsed: omitted")
    #expect(try needsYou("folder trust", 1_800_003_600)?["resets_at"] == nil, "another kind never carries it")
  }

  @Test func theWorkersFileKeepsItAndDropsABadOneAlone() throws {
    let e = try JSONDecoder().decode(
      WorkersFile.NeedsYou.self, from: Data(#"{"kind":"usage limit","since":"2026-11-13T00:00:00.000Z","resets_at":"2026-11-13T15:00:00.000Z"}"#.utf8))
    #expect(e.resets_at == "2026-11-13T15:00:00.000Z")
    let back = try JSONDecoder().decode(WorkersFile.NeedsYou.self, from: JSONEncoder().encode(e))
    #expect(back == e)
    for bad in [#"42"#, #""tomorrow""#, #"{"x":1}"#] {
      let n = try JSONDecoder().decode(
        WorkersFile.NeedsYou.self, from: Data(#"{"kind":"usage limit","since":"2026-11-13T00:00:00.000Z","resets_at":\#(bad)}"#.utf8))
      #expect(n.kind == "usage limit" && n.resets_at == nil, "\(bad): the field goes, the needs-you stays")
    }
    // an older file has none, and none is written for one that has none
    let old = try JSONDecoder().decode(WorkersFile.NeedsYou.self, from: Data(#"{"kind":"folder trust","since":"2026-11-13T00:00:00.000Z"}"#.utf8))
    #expect(old.resets_at == nil)
    #expect(!String(decoding: try JSONEncoder().encode(old), as: UTF8.self).contains("resets_at"))
  }
}
