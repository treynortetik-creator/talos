import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("EnrollOutput and DevicesList")
struct EnrollOutputTests {
  let relay = RelayOrigin("https://relay.example.com")
  let code = "0123456789ABCDEFGHJKMNPQRS"
  var banner: String {
    "Open this link on the device you want to add (it works once, for 10 minutes):\r\n"
  }

  @Test func readsTheLinkTheCliPrints() {
    var o = EnrollOutput(relay: relay)
    o.feed(banner + "https://relay.example.com/enroll#\(code)\r\nWaiting for the device… (Ctrl-C to stop)\r\n")
    #expect(o.result == .code(code))
  }

  @Test func aLinkSplitAcrossChunksAndColoredText() {
    var o = EnrollOutput(relay: relay)
    o.feed("\u{1B}[1mhttps://relay.example.com/enr")
    #expect(o.result == .none)
    o.feed("oll#0123456789ABC")
    o.feed("DEFGHJKMNPQRS\u{1B}[0m\r\n")
    #expect(o.result == .code(code))
  }

  @Test func theSameLinkRepeatedIsStillOne() {
    var o = EnrollOutput(relay: relay)
    o.feed("https://relay.example.com/enroll#\(code)\nhttps://relay.example.com/enroll#\(code.lowercased())\n")
    #expect(o.result == .code(code))
  }

  @Test func twoDifferentLinksSendNothing() {
    var o = EnrollOutput(relay: relay)
    o.feed("https://relay.example.com/enroll#\(code)\nhttps://relay.example.com/enroll#0123456789ABCDEFGHJKMNPQR1\n")
    #expect(o.result == .ambiguous)
  }

  @Test func aLinkForAnotherRelayIsIgnored() {
    var o = EnrollOutput(relay: relay)
    o.feed("https://evil.example/enroll#\(code)\n")
    #expect(o.result == .none)
  }

  @Test func garbageIsIgnored() {
    var o = EnrollOutput(relay: relay)
    o.feed("see /enroll#\(code) for details\nhttps://relay.example.com/enroll#tooshort\n")
    #expect(o.result == .none)
  }

  @Test func devicesListAndForget() {
    let a = "d_" + String(repeating: "a", count: 20)
    let b = "d_" + String(repeating: "b", count: 20)
    let c = "d_" + String(repeating: "c", count: 20)
    let text = """
      \(a)  pinned   Mac app  [word one two three]  2026-10-30T12:00:00Z
      \(b)  pinned   iPhone (Home Screen)  [x y z w]  2026-10-30T12:00:00Z
      \(c)  REVOKED  Mac app  [x y z w]
      not a device line
      d_bad  pinned  Mac app
      """
    let list = DevicesList.parse(text)
    #expect(list.count == 3)
    #expect(DevicesList.macAppIds(list) == [a])
  }

  @Test func deviceIdShape() {
    #expect(DevicesList.isDeviceId("d_" + String(repeating: "a", count: 20)))
    #expect(!DevicesList.isDeviceId("d_" + String(repeating: "A", count: 20)))
    #expect(!DevicesList.isDeviceId("d_" + String(repeating: "1", count: 20)))
    #expect(!DevicesList.isDeviceId("d_aa; rm -rf /"))
  }
}

@Suite("PairingSession")
struct PairingSessionTests {
  let relay = RelayOrigin("https://relay.example.com")
  let code = "0123456789ABCDEFGHJKMNPQRS"

  @Test func sendsTheCodeExactlyOnceEvenWhenTheScreenIsReadAgainAndAgain() {
    var s = PairingSession(relay: relay)
    #expect(s.update(screen: "Open this link\n") == nil)
    let screen = "Open this link\nhttps://relay.example.com/enroll#\(code)\nWaiting for the device…\n"
    #expect(s.update(screen: screen) == code)
    for _ in 0..<5 { #expect(s.update(screen: screen) == nil) }
    #expect(s.sent)
  }

  @Test func theFourWordsPromptAfterwardsDoesNotSendAgain() {
    var s = PairingSession(relay: relay)
    #expect(s.update(screen: "https://relay.example.com/enroll#\(code)") == code)
    #expect(s.update(screen: "https://relay.example.com/enroll#\(code)\nPin \"Mac app\" [a b c d]? [y/N] ") == nil)
  }

  @Test func twoLinksOnTheScreenSendNothing() {
    var s = PairingSession(relay: relay)
    let two = "https://relay.example.com/enroll#\(code)\nhttps://relay.example.com/enroll#0123456789ABCDEFGHJKMNPQR1\n"
    #expect(s.update(screen: two) == nil)
    #expect(s.ambiguous)
    #expect(!s.sent)
  }

  @Test func aSecondDifferentLinkAfterTheFirstWasSentStillSendsNothingMore() {
    var s = PairingSession(relay: relay)
    #expect(s.update(screen: "https://relay.example.com/enroll#\(code)") == code)
    #expect(s.update(screen: "https://relay.example.com/enroll#0123456789ABCDEFGHJKMNPQR1") == nil)
  }

  @Test func wrappedRowsJoinIntoOneLink() {
    let link = "https://a-very-long-relay-host-name-for-testing.up.example.net/enroll#\(code)"
    let rows: [(text: String, wrapped: Bool)] = [
      ("Open this link:", false), (String(link.prefix(80)), false), (String(link.dropFirst(80)), true), ("Waiting", false),
    ]
    var s = PairingSession(relay: RelayOrigin("https://a-very-long-relay-host-name-for-testing.up.example.net"))
    #expect(s.update(screen: ScreenText.join(rows)) == code)
  }
}
