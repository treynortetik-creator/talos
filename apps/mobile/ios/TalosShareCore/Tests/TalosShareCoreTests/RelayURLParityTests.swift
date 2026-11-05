// The phone's copy of the relay's `HttpsUrl` decides whether the relay will fold `url` into `text` (and so whether the
// 32,000 text cap counts the url). Expectations below were produced by running packages/protocol `HttpsUrl.safeParse`
// in Node over these exact strings, not written by hand.
import Foundation
import Testing

@testable import TalosShareCore

@Suite("Relay url parity")
struct RelayURLParityTests {
    static let relay: [(String, Bool)] = [
        ("https://example.com", true),
        ("http://example.com/a b", false),
        ("HTTPS://Example.COM/x", true),
        ("https:example.com", true),
        ("https:///example.com", true),
        ("https://", false),
        ("http://?x", false),
        ("https://user:pw@example.com/p", true),
        ("https://a@b@example.com", true),
        ("https://exa<mple.com", false),
        ("https://exa%41mple.com", true),
        ("https://exa%zzmple.com", false),
        ("https://exa%3Cmple.com", false),
        ("https://host:8080/x", true),
        ("https://host:99999/", false),
        ("https://host:/", true),
        ("https://host:0080", true),
        ("https://host:8a/", false),
        ("https://[::1]/x", true),
        ("https://[::1]:443/", true),
        ("https://[::1/", false),
        ("https://1.2.3.4/", true),
        ("https://1.2.3.999/", false),
        ("https://999.1.1.1/", false),
        ("https://0x7f.1/", true),
        ("https://08.1.1.1/", false),
        ("https://foo.1/", false),
        ("https://1.2.3.4.5/", false),
        ("https://4294967295/", true),
        ("https://4294967296/", false),
        ("https://example.com/\u{A0}x", false),
        ("https://example.com/\u{3000}", false),
        ("https://example.com/\u{200B}x", true),
        ("https://example.com/\u{2003}", false),
        ("ftp://example.com", false),
        ("javascript:alert(1)", false),
        ("not a url", false),
        ("mailto:alex@example.com", false),
        ("https://ex|ample.com", false),
        ("https://ex^ample.com", false),
        ("https://example.com/{|}^`", true),
        ("https://example.com\\path", true),
        ("http:\\\\example.com\\x", true),
        ("https://exa_mple.com", true),
        ("https://\u{4F8B}\u{3048}.jp/\u{30D1}\u{30B9}", true),
        ("https://example.com.", true),
        ("https://1.2.3.4./", true),
        ("https://0x/", true),
        ("https://example.com#frag", true),
        ("https://example.com?q=a\"b", true),
    ]

    @Test func matchesTheRelaysHttpsUrl() {
        for (u, ok) in Self.relay { #expect(SharePayload.isRelayWebURL(u) == ok, "\(u.debugDescription)") }
        #expect(SharePayload.isRelayWebURL("https://e.com/" + String(repeating: "a", count: 1_986)))  // 2,000
        #expect(!SharePayload.isRelayWebURL("https://e.com/" + String(repeating: "a", count: 1_987)))  // 2,001
    }

    @Test func aFoldedURLCountsAgainstTheTextCapExactly() throws {
        // "not a url" (9) + "\n" + text: the relay's text is exactly 32,000 at 31,990.
        try SharePayload(text: String(repeating: "t", count: 31_990), url: "not a url").validate(scopes: [.text])
        #expect(throws: ShareRefusal.fieldTooLong(.text)) {
            try SharePayload(text: String(repeating: "t", count: 31_991), url: "not a url").validate(scopes: [.text])
        }
        // Blank text is dropped before the fold, so the url alone is the text.
        try SharePayload(text: "  ", url: "not a url").validate(scopes: [.text])
        #expect(throws: ShareRefusal.fieldTooLong(.text)) {
            try SharePayload(url: "x" + String(repeating: "y", count: 32_000)).validate(scopes: [.text])
        }
        // A valid url is its own field: it never counts against text.
        try SharePayload(text: String(repeating: "t", count: 32_000), url: "https://example.com/x").validate(scopes: [.text])
    }

    @Test func aZeroByteFileIsRefusedEvenNextToText() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let empty = ShareFile(url: try makeFile(d, name: "e", bytes: 0), filename: "e", mimeType: "image/png")
        #expect(throws: ShareRefusal.emptyFile) { try SharePayload(text: "hi", files: [empty]).validate(scopes: [.text, .files]) }
    }

    @Test func theFilenameCutIsTheRelays200UTF16Units() {
        #expect(MultipartWriter.safeFilename(String(repeating: "語", count: 300)).utf16.count == 200)
        #expect(MultipartWriter.safeFilename(String(repeating: "😀", count: 150)).utf16.count == 200)  // no split pair
        #expect(MultipartWriter.safeFilename(String(repeating: "\"", count: 100)) == String(repeating: "%22", count: 66))
    }
}
