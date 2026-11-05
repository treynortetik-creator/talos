import Foundation
import Testing

@testable import TalosShareCore

@Suite("ShareToken")
struct ShareTokenTests {
    @Test func acceptsTheRelaysSecretShapeOnly() {
        #expect(ShareToken(secret: goodSecret, scopes: [.text]) != nil)
        #expect(ShareToken(secret: "talos_share_short", scopes: [.text]) == nil)
        #expect(ShareToken(secret: "Bearer " + goodSecret, scopes: [.text]) == nil)
        #expect(ShareToken(secret: goodSecret + "\r\nX-Evil: 1", scopes: [.text]) == nil)
        #expect(ShareToken(secret: goodSecret, scopes: []) == nil)
    }

    @Test func neverPrintsTheSecret() {
        let t = token([.text, .files])
        var dumped = ""
        dump(t, to: &dumped)
        for s in ["\(t)", String(describing: t), String(reflecting: t), dumped, "\(String(describing: Optional(t)))"] {
            #expect(!s.contains("talos_share_"))
            #expect(!s.contains(String(repeating: "A", count: 10)))
        }
    }
}

@Suite("SharePayload limits")
struct SharePayloadTests {
    @Test func limitsMatchTheRelay() {
        #expect(ShareLimits.textUTF16 == 32_000)
        #expect(ShareLimits.noteUTF16 == 4_000)
        #expect(ShareLimits.titleUTF16 == 300)
        #expect(ShareLimits.maxFiles == 4)
        #expect(ShareLimits.fileBytes == 20 * 1024 * 1024)
    }

    @Test func emptyShareIsRefused() {
        #expect(throws: ShareRefusal.empty) { try SharePayload().validate(scopes: [.text]) }
        #expect(throws: ShareRefusal.empty) { try SharePayload(text: " \n\t", note: "  ").validate(scopes: [.text]) }
        #expect(throws: ShareRefusal.empty) { try SharePayload(title: "only a title").validate(scopes: [.text]) }
        #expect(throws: Never.self) { try SharePayload(url: "https://example.com").validate(scopes: [.text]) }
        #expect(throws: Never.self) { try SharePayload(note: "hi").validate(scopes: [.text]) }
    }

    @Test func textNoteTitleBoundaries() {
        #expect(throws: Never.self) { try SharePayload(text: String(repeating: "a", count: 32_000)).validate(scopes: [.text]) }
        #expect(throws: ShareRefusal.fieldTooLong(.text)) {
            try SharePayload(text: String(repeating: "a", count: 32_001)).validate(scopes: [.text])
        }
        #expect(throws: Never.self) { try SharePayload(text: "x", note: String(repeating: "n", count: 4_000)).validate(scopes: [.text]) }
        #expect(throws: ShareRefusal.fieldTooLong(.note)) {
            try SharePayload(text: "x", note: String(repeating: "n", count: 4_001)).validate(scopes: [.text])
        }
        #expect(throws: ShareRefusal.fieldTooLong(.title)) {
            try SharePayload(text: "x", title: String(repeating: "t", count: 301)).validate(scopes: [.text])
        }
    }

    @Test func lengthIsUTF16LikeTheRelay() {
        // 2001 emoji is 2001 characters but 4002 UTF-16 units: the relay (JavaScript length) refuses it.
        let note = String(repeating: "😀", count: 2_001)
        #expect(note.count == 2_001)
        #expect(throws: ShareRefusal.fieldTooLong(.note)) { try SharePayload(text: "x", note: note).validate(scopes: [.text]) }
        #expect(throws: Never.self) {
            try SharePayload(text: "x", note: String(repeating: "😀", count: 2_000)).validate(scopes: [.text])
        }
    }

    @Test func filesNeedTheFilesScope() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let f = ShareFile(url: try makeFile(d, bytes: 10), filename: "a.png", mimeType: "image/png")
        #expect(throws: ShareRefusal.filesNotAllowed) { try SharePayload(files: [f]).validate(scopes: [.text]) }
        #expect(throws: Never.self) { try SharePayload(files: [f]).validate(scopes: [.text, .files]) }  // photo only
    }

    @Test func fileCountAndSizeBoundaries() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let small = ShareFile(url: try makeFile(d, name: "s", bytes: 1), filename: "s", mimeType: "image/png")
        #expect(throws: Never.self) { try SharePayload(files: Array(repeating: small, count: 4)).validate(scopes: [.text, .files]) }
        #expect(throws: ShareRefusal.tooManyFiles) {
            try SharePayload(files: Array(repeating: small, count: 5)).validate(scopes: [.text, .files])
        }
        let max = ShareFile(url: try makeFile(d, name: "max", bytes: 20 * 1024 * 1024), filename: "max", mimeType: "video/mp4")
        let over = ShareFile(url: try makeFile(d, name: "over", bytes: 20 * 1024 * 1024 + 1), filename: "over", mimeType: "video/mp4")
        #expect(throws: Never.self) { try SharePayload(files: [max]).validate(scopes: [.text, .files]) }
        #expect(throws: ShareRefusal.fileTooLarge) { try SharePayload(files: [over]).validate(scopes: [.text, .files]) }
        let missing = ShareFile(url: d.appendingPathComponent("nope"), filename: "nope", mimeType: "image/png")
        #expect(throws: ShareRefusal.fileUnreadable) { try SharePayload(files: [missing]).validate(scopes: [.text, .files]) }
    }
}
