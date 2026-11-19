import Foundation
import Testing
@testable import TalosDesktopCore

/// The four words of the app's own enroll, read from the program's question and confirmable only while that question is whole.
@Suite("Enroll pin prompt")
struct EnrollPinTests {
  let relay = RelayOrigin("https://relay.example.com")
  let code = "0123456789ABCDEFGHJKMNPQRS"
  var link: String { "https://relay.example.com/enroll#\(code)\n" }
  let whole = "Pin \"Mac app\" [aardvark adroitness absurd adviser]? [y/N] "
  let t0 = Date(timeIntervalSince1970: 1_000_000)

  func ready() -> PairingSession {
    var s = PairingSession(relay: relay)
    _ = s.update(screen: link + whole, now: t0)
    return s
  }

  @Test func theWholeQuestionGivesTheFourWords() {
    #expect(PinPrompt.read(screen: whole) == .ready(["aardvark", "adroitness", "absurd", "adviser"]))
    // real output: colours, carriage returns, the cursor at the end
    #expect(PinPrompt.read(screen: "\u{1B}[0m\r\nPin \"Mac app\" [aardvark adroitness absurd adviser]? [y/N] \u{1B}[?25h") == .ready(["aardvark", "adroitness", "absurd", "adviser"]))
  }

  @Test func aPartialQuestionIsNotConfirmable() {
    for partial in [
      "Pin \"Mac app\" [aardvark adro", "Pin \"Mac app\" [aardvark adroitness absurd adviser]", "Pin \"Mac app\" [aardvark adroitness absurd adviser]? [y/N",
      "Pin \"Mac app\" [aardvark adroitness absurd]? [y/N] ", "Pin \"Mac app\" [aardvark adroitness absurd adviser five]? [y/N] ", "Pin \"Mac app\" [a b c 4]? [y/N] ",
    ] {
      var s = PairingSession(relay: relay)
      _ = s.update(screen: link + partial, now: t0)
      #expect(s.words(now: t0 + 10) == nil, "\(partial)")
      #expect(!s.confirmable(now: t0 + 10), "\(partial)")
      #expect(s.confirm(now: t0 + 10) == false, "\(partial)")
      #expect(s.answered == nil)
    }
  }

  @Test func aQuestionForAnotherNameIsNotOurs() {
    var s = PairingSession(relay: relay)
    _ = s.update(screen: link + "Pin \"Someone's phone\" [aardvark adroitness absurd adviser]? [y/N] ", now: t0)
    #expect(s.words(now: t0 + 10) == nil)
  }

  @Test func aQuestionBeforeTheLinkWasSentIsIgnored() {
    var s = PairingSession(relay: relay)
    _ = s.update(screen: whole, now: t0)
    #expect(s.words(now: t0 + 10) == nil)
  }

  @Test func confirmWaitsForTheReadDelayThenWorksExactlyOnce() {
    var s = ready()
    #expect(s.confirm(now: t0 + 0.1) == false, "the program counts an answer within 0.5 s as a no")
    #expect(s.confirm(now: t0 + 1) == true)
    #expect(s.confirm(now: t0 + 2) == false)
    #expect(s.decline() == false, "already answered: no `n` after a `y`")
    #expect(PairingSession.yesBytes == [0x79, 0x0d])
  }

  @Test func newWordsRestartTheReadDelay() {
    var s = ready()
    _ = s.update(screen: link + whole + "\nThis question was withdrawn (x). Nothing was pinned.\nPin \"Mac app\" [Zulu adroitness absurd Yucatán]? [y/N] ", now: t0 + 5)
    #expect(s.words(now: t0 + 5.1) == ["Zulu", "adroitness", "absurd", "Yucatán"])
    #expect(s.confirm(now: t0 + 5.1) == false)
    #expect(s.confirm(now: t0 + 6) == true)
  }

  @Test func aWithdrawnQuestionIsNotConfirmable() {
    var s = ready()
    _ = s.update(screen: link + whole + "\nThis question was withdrawn (another device used the code, or it timed out). Nothing was pinned.", now: t0 + 1)
    #expect(s.pin == .withdrawn)
    #expect(s.confirm(now: t0 + 2) == false)
  }

  @Test func outOfTimeIsNotConfirmable() {
    var s = ready()
    #expect(s.confirm(now: t0 + PairingSession.defaultPinWait + 1) == false)
    #expect(s.words(now: t0 + PairingSession.defaultPinWait + 1) == nil)
  }

  @Test func anAnswerAlreadyOnTheScreenClosesIt() {
    var s = PairingSession(relay: relay)
    _ = s.update(screen: link + whole + "y\nAnswered yes; the live bridge will pin the device.", now: t0)
    #expect(s.words(now: t0 + 5) == nil)
  }

  @Test func declineWritesNoOnlyForAWholeOpenQuestion() {
    var s = ready()
    #expect(s.decline() == true)
    #expect(s.confirm(now: t0 + 5) == false, "after They don't match nothing confirms")
    var early = PairingSession(relay: relay)
    _ = early.update(screen: link, now: t0)
    #expect(early.decline() == false)
  }

  @Test func theWholePgpWordSetIsAcceptedIncludingTheAccent() {
    #expect(PinPrompt.read(screen: "Pin \"Mac app\" [Zulu adroitness absurd Yucatán]? [y/N] ") == .ready(["Zulu", "adroitness", "absurd", "Yucatán"]))
    #expect(PinPrompt.read(screen: "Pin \"Mac app\" [Zulu adroitness absurd Yucatan]? [y/N] ") == .none, "not the real word")
  }

  @Test func onlyRealPgpWordsInTheirOwnPositionsAreTheOwnersQuestion() {
    for bad in ["amber falcon river stone", "adroitness aardvark absurd adviser", "aardvark adroitness absurd absurd", "AARDVARK adroitness absurd adviser"] {
      #expect(PinPrompt.read(screen: "Pin \"Mac app\" [\(bad)]? [y/N] ") == .none, "\(bad)")
    }
  }

  /// The Swift list is the TypeScript list (packages/protocol/src/pgp-words.ts): same words, same order.
  @Test func theWordListIsTheProtocolsList() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/protocol/src/pgp-words.ts")
    let ts = try String(contentsOf: url, encoding: .utf8)
    func words(_ name: String) -> [String] {
      guard let start = ts.range(of: name), let open = ts.range(of: "[", range: ts.range(of: "= ", range: start.upperBound..<ts.endIndex)!.upperBound..<ts.endIndex),
        let close = ts.range(of: "]", range: open.upperBound..<ts.endIndex)
      else { return [] }
      return ts[open.upperBound..<close.lowerBound].split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "'")) }.filter { !$0.isEmpty }.map { $0.replacingOccurrences(of: "\\u00e1", with: "á") }
    }
    #expect(words("PGP_EVEN_WORDS") == PgpWords.even)
    #expect(words("PGP_ODD_WORDS") == PgpWords.odd)
    #expect(PgpWords.even.count == 256 && PgpWords.odd.count == 256)
  }
}
