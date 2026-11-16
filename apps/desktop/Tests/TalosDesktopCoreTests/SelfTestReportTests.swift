import Testing
@testable import TalosDesktopCore

@Suite("SelfTestReport")
struct SelfTestReportTests {
  @Test func jsonLineParsesAndCarriesTheSpecFields() throws {
    let report = SelfTestReport(
      version: "0.1.0", bundleId: "app.talos.desktop", swiftterm: true,
      notificationsReachable: true, loginItemStatus: 3, configDefaultsDecode: true, workerHook: "ok")
    let line = try report.jsonLine()
    #expect(!line.contains("\n"))
    let obj = try #require(jsonObject(line))
    #expect(obj["version"] as? String == "0.1.0")
    #expect(obj["bundle_id"] as? String == "app.talos.desktop")
    #expect(obj["swiftterm"] as? Bool == true)
    #expect(obj["notifications_reachable"] as? Bool == true)
    #expect(obj["login_item_status"] as? Int == 3)
    #expect(obj["config_defaults_decode"] as? Bool == true)
    #expect(obj["worker_hook"] as? String == "ok")
  }

  @Test func okOnlyWhenEverythingRequiredHolds() {
    var r = SelfTestReport(
      version: "x", bundleId: "app.talos.desktop", swiftterm: true,
      notificationsReachable: true, loginItemStatus: 3, configDefaultsDecode: true, workerHook: "ok")
    #expect(r.ok)
    r.swiftterm = false
    #expect(!r.ok)
    r.swiftterm = true
    r.configDefaultsDecode = false
    #expect(!r.ok)
    r.configDefaultsDecode = true
    #expect(r.ok)
    // an app that would refuse its own bundled permission hook starts no thread session: the build must not pass
    r.workerHook = "the Talos app's code signature does not check out (a sealed resource is missing or invalid), so its permission hook can't be trusted"
    #expect(!r.ok)
  }
}
