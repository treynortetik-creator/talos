import Testing
@testable import TalosDesktopCore

@Suite("SelfTestReport")
struct SelfTestReportTests {
  @Test func jsonLineParsesAndCarriesTheSpecFields() throws {
    let report = SelfTestReport(
      version: "0.1.0", bundleId: "app.talos.desktop", swiftterm: true,
      notificationsReachable: true, loginItemStatus: 3, configDefaultsDecode: true)
    let line = try report.jsonLine()
    #expect(!line.contains("\n"))
    let obj = try #require(jsonObject(line))
    #expect(obj["version"] as? String == "0.1.0")
    #expect(obj["bundle_id"] as? String == "app.talos.desktop")
    #expect(obj["swiftterm"] as? Bool == true)
    #expect(obj["notifications_reachable"] as? Bool == true)
    #expect(obj["login_item_status"] as? Int == 3)
    #expect(obj["config_defaults_decode"] as? Bool == true)
  }

  @Test func okOnlyWhenEverythingRequiredHolds() {
    var r = SelfTestReport(
      version: "x", bundleId: "app.talos.desktop", swiftterm: true,
      notificationsReachable: true, loginItemStatus: 3, configDefaultsDecode: true)
    #expect(r.ok)
    r.swiftterm = false
    #expect(!r.ok)
    r.swiftterm = true
    r.configDefaultsDecode = false
    #expect(!r.ok)
  }
}
