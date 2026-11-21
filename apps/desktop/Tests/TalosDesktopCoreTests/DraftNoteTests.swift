import Foundation
import Testing

@testable import TalosDesktopCore

/// The saved copy of Main's unsent text: what is read back, from whom, for which version, and for how long.
@Suite("Draft note")
struct DraftNoteTests {
  let mem = MemoryDraftDigest()

  func tmp() -> String {
    let d = NSTemporaryDirectory() + "talos-draft-note-\(UUID().uuidString.prefix(8))"
    try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d + "/main-draft.json"
  }

  @Test func textIsCleanedToOnePlainLineWithNoControlCharacters() {
    #expect(DraftNote.clean("a\r\nb\u{1b}[31mc\u{7}") == "a  b [31mc")
    #expect(!DraftNote.clean("x\ry\n").contains("\r") && !DraftNote.clean("x\ry\n").contains("\n"))
    #expect(DraftNote.clean(String(repeating: "a", count: 20_000)).count == DraftNote.maxChars)
  }

  @Test func aFileReadsBackOnlyForItsOwnVersion() {
    let p = tmp()
    #expect(DraftNote.write(DraftNote(version: "1.5.0", text: "hello", partial: false, saved_at: Date().timeIntervalSince1970), to: p, digests: mem))
    #expect(DraftNote.read(path: p, forVersion: "1.5.0", digests: mem)?.text == "hello")
    #expect(DraftNote.read(path: p, forVersion: "1.4.0", digests: mem) == nil)
    #expect(FileManager.default.fileExists(atPath: p), "another version's read leaves it")
  }

  @Test func aPlantedFileWithControlCharactersIsReadAsPlainText() throws {
    let p = tmp()
    let n = DraftNote(version: "1.5.0", text: "ls -la\r\u{1b}[2Jrm", partial: false, saved_at: Date().timeIntervalSince1970)
    try JSONEncoder().encode(n).write(to: URL(fileURLWithPath: p))
    _ = mem.save(n.digest)  // as if this app had saved it
    let got = try #require(DraftNote.read(path: p, forVersion: "1.5.0", digests: mem))
    #expect(!got.text.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) })
  }

  @Test func aFileOlderThanADayIsDeletedAndNeverShown() {
    let p = tmp()
    let old = Date().timeIntervalSince1970 - 25 * 3600
    #expect(DraftNote.write(DraftNote(version: "1.5.0", text: "hello", partial: false, saved_at: old), to: p, digests: mem))
    #expect(DraftNote.read(path: p, forVersion: "1.5.0", digests: mem) == nil)
    #expect(!FileManager.default.fileExists(atPath: p))
    #expect(DraftNote.write(DraftNote(version: "1.5.0", text: "hello", partial: false, saved_at: old), to: p, digests: mem))
    DraftNote.expire(path: p, digests: mem)
    #expect(!FileManager.default.fileExists(atPath: p), "expire at launch")
  }

  @Test func aGarbageFileOrASymlinkIsDroppedNotRead() throws {
    let p = tmp()
    try Data("not json".utf8).write(to: URL(fileURLWithPath: p))
    #expect(DraftNote.read(path: p, forVersion: "1.5.0", digests: mem) == nil && !FileManager.default.fileExists(atPath: p))
    let target = tmp()
    #expect(DraftNote.write(DraftNote(version: "1.5.0", text: "hello", partial: false, saved_at: Date().timeIntervalSince1970), to: target, digests: mem))
    try FileManager.default.createSymbolicLink(atPath: p, withDestinationPath: target)
    #expect(DraftNote.read(path: p, forVersion: "1.5.0", digests: mem) == nil, "a link is not the file this app wrote")
  }

  @Test func aPastePlaceholderOrATopBoxIsPartial() {
    #expect(DraftNote.looksPartial(text: "see [Pasted text #2 +10 lines]", boxStartsAtTop: false))
    #expect(DraftNote.looksPartial(text: "plain", boxStartsAtTop: true))
    #expect(!DraftNote.looksPartial(text: "plain", boxStartsAtTop: false))
  }

  @Test func theNoticeWordsAreThereAndPlain() {
    #expect(DraftNoticeCopy.title == "You had unsent text when Talos updated")
    #expect(DraftNoticeCopy.partial == "This may be only part of what you typed.")
    #expect(UpdateStatus.waitingForTurn(version: "1.5.0", why: ["main running"], draft: .keep).words.detail.contains("Talos will keep a copy of your unsent text"))
  }

  @Test func aFileWithNoMatchingDigestIsNeverReadAndAMatchingOneIs() {
    let p = tmp()
    let n = DraftNote(version: "1.5.0", text: "hello", partial: false, saved_at: Date().timeIntervalSince1970)
    let mem = MemoryDraftDigest()
    #expect(DraftNote.write(n, to: p, digests: mem))
    #expect(DraftNote.read(path: p, forVersion: "1.5.0", digests: mem)?.text == "hello", "a match shows")
    #expect(DraftNote.read(path: p, forVersion: "1.5.0", digests: MemoryDraftDigest()) == nil, "no digest: nothing")
    let other = MemoryDraftDigest()
    _ = other.save("0000")
    #expect(DraftNote.read(path: p, forVersion: "1.5.0", digests: other) == nil, "another digest: nothing")
    DraftNote.remove(path: p, digests: mem)
    #expect(!FileManager.default.fileExists(atPath: p) && mem.read() == nil)
  }

  @Test func theDigestBindsVersionTimeAndText() {
    let a = DraftNote(version: "1.5.0", text: "hello", partial: false, saved_at: 100)
    var b = a; b.version = "1.5.1"
    var c = a; c.saved_at = 101
    var d = a; d.text = "hellp"
    #expect(Set([a.digest, b.digest, c.digest, d.digest]).count == 4)
    #expect(a.digest.count == 64)
  }

  @Test func theSavedLineSaysWhen() {
    let utc = TimeZone(identifier: "UTC")!, us = Locale(identifier: "en_US")
    let t = 1_798_000_000.0  // 2026-12-23 04:26:40 UTC
    #expect(DraftNoticeCopy.saved(at: t, now: t + 60, locale: us, timeZone: utc).hasPrefix("Talos saved this copy at 4:26"))
    #expect(DraftNoticeCopy.saved(at: t, now: t + 3 * 86400, locale: us, timeZone: utc).contains("Dec 23, 2026"))
  }
}

/// The digest in a real (throwaway) keychain, never the login one.
@Suite("Draft digest in a real keychain", .serialized, .keychainPromptsOff)
struct DraftDigestKeychainTests {
  @Test func theDigestGoesInComesBackIsReplacedAndGoes() throws {
    let k = try ThrowawayKeychain.make("draft")
    defer { k.remove() }
    let store = KeychainDraftDigest(service: "com.talos.test.draft-copy.\(UUID().uuidString.lowercased())", keychain: k.keychain)
    #expect(store.read() == nil)
    #expect(store.save("aaaa") && store.read() == "aaaa")
    #expect(store.save("bbbb") && store.read() == "bbbb", "the next note replaces it")
    store.clear()
    #expect(store.read() == nil)
  }
}
