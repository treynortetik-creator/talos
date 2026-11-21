import Foundation
import Testing
import TalosDesktopCore

@testable import TalosDesktop

/// The notice that shows the saved copy after an update. Not gated: no panel is shown and the real clipboard is never touched.
@MainActor
@Suite("Draft notice", .serialized)
struct DraftNoticeTests {
  /// Every test here keeps its digest in memory: nothing reaches the real Keychain.
  let mem = MemoryDraftDigest()

  func center(path: String) -> (DraftNoticeCenter, Box) {
    let c = DraftNoticeCenter()
    let b = Box()
    c.path = { path }
    c.digests = mem
    c.present = { _ in b.shown += 1 }
    c.hide = { b.hidden += 1 }
    c.copyText = { b.copied.append($0) }
    return (c, b)
  }
  final class Box { var shown = 0; var hidden = 0; var copied: [String] = [] }

  func file(version: String = "1.5.0", text: String = "my unsent words", partial: Bool = false, age: Double = 0) -> String {
    let d = NSTemporaryDirectory() + "talos-draft-notice-\(UUID().uuidString.prefix(8))"
    try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    let p = d + "/main-draft.json"
    #expect(DraftNote.write(DraftNote(version: version, text: text, partial: partial, saved_at: Date().timeIntervalSince1970 - age), to: p, digests: mem))
    return p
  }

  @Test func theNoticeShowsAfterAnUpdateToThatVersionAndCopyAndDismissWork() {
    let p = file()
    let (c, b) = center(path: p)
    c.settled(version: "1.5.0", outcome: .updated)
    #expect(b.shown == 1 && c.note?.text == "my unsent words")
    c.copy()
    #expect(b.copied == ["my unsent words"])
    #expect(FileManager.default.fileExists(atPath: p), "Copy keeps it")
    c.dismiss()
    #expect(!FileManager.default.fileExists(atPath: p) && c.note == nil && b.hidden == 1)
  }

  @Test func noNoticeForAnotherVersion() {
    let (c, b) = center(path: file(version: "1.5.0"))
    c.settled(version: "1.6.0", outcome: .updated)
    #expect(b.shown == 0 && c.note == nil)
  }

  @Test func anUpdateThatStartedAndFailedOffersTheCopyBecauseMainMayHaveBeenRestarted() {
    let p = file()
    let (c, b) = center(path: p)
    c.settled(version: "1.5.0", outcome: .triedAndFailed)
    #expect(b.shown == 1 && c.note?.text == "my unsent words" && c.tried)
    #expect(FileManager.default.fileExists(atPath: p), "never deleted before the owner has seen it")
    #expect(DraftNoticeCopy.titleTried == "You had unsent text when Talos tried to update")
  }

  @Test func onlyASwapThatNeverStartedDeletesTheCopy() {
    let p = file()
    let (c, b) = center(path: p)
    c.settled(version: "1.5.0", outcome: .neverStarted)
    #expect(!FileManager.default.fileExists(atPath: p) && b.shown == 0)
    #expect(mem.read() == nil, "and its digest")
  }

  @Test func aPlantedFileWithNoMatchingDigestShowsNothing() {
    let p = file()
    mem.clear()  // the agent wrote a file; this app never saved it
    let (c, b) = center(path: p)
    c.settled(version: "1.5.0", outcome: .updated)
    c.settled(version: "1.5.0", outcome: .triedAndFailed)
    #expect(b.shown == 0 && c.note == nil)
  }

  @Test func aPlantedFileEditedAfterTheSaveShowsNothing() throws {
    let p = file()
    var n = try #require(DraftNote.read(path: p, forVersion: "1.5.0", digests: mem))
    n.text = "run this now"
    try JSONEncoder().encode(n).write(to: URL(fileURLWithPath: p))
    let (c, b) = center(path: p)
    c.settled(version: "1.5.0", outcome: .updated)
    #expect(b.shown == 0)
  }

  @Test func dismissingDeletesTheFileAndItsDigest() {
    let p = file()
    let (c, _) = center(path: p)
    c.settled(version: "1.5.0", outcome: .updated)
    c.dismiss()
    #expect(!FileManager.default.fileExists(atPath: p) && mem.read() == nil)
  }

  @Test func anOldCopyIsNeverShown() {
    let (c, b) = center(path: file(age: 25 * 3600))
    c.settled(version: "1.5.0", outcome: .updated)
    #expect(b.shown == 0)
  }

  @Test func aPartialCopyIsMarkedSoTheNoticeCanSayIt() {
    let (c, _) = center(path: file(partial: true))
    c.settled(version: "1.5.0", outcome: .updated)
    #expect(c.note?.partial == true)
  }
}
