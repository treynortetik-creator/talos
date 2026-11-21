import Foundation
import Testing

@testable import TalosDesktopCore

@Suite("Devices row")
struct DevicesPageTests {
  @Test func theWindowOpensTheDevicesPartOnTheConfiguredServer() throws {
    let relay = try #require(RelayOrigin("https://talos.example.com"))
    let url = try #require(DevicesPage.url(relay: relay))
    #expect(url.absoluteString == "https://talos.example.com/settings/account#devices")
    #expect(RelayOrigin(url) == relay, "same origin as the window, so it opens inside it")
    let local = try #require(RelayOrigin("http://127.0.0.1:8443"))
    #expect(DevicesPage.url(relay: local)?.absoluteString == "http://127.0.0.1:8443/settings/account#devices")
  }

  @Test func thePathIsOneTheWindowAcceptsAndKeepsThePart() {
    #expect(AppPath.isValid(DevicesPage.path))
    #expect(DevicesPage.path == "/settings/account#devices")
  }

  @Test func withoutAServerAddressTheRowIsDisabledWithAPlainReason() {
    #expect(DevicesPage.plan(hasRelay: false) == .disabled(reason: "Set up the Talos server first"))
    #expect(DevicesPage.plan(hasRelay: true) == .open(path: "/settings/account#devices"))
  }

  @Test func theRowWordsHaveNoEngineerWord() {
    for s in [DevicesPage.rowTitle, DevicesPage.rowButton, DevicesPage.needsServer] {
      #expect(MacWords.forbiddenWords(in: s).isEmpty, Comment(rawValue: s))
    }
  }
}
