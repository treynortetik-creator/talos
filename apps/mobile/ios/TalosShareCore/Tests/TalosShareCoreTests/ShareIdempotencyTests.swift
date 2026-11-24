import Foundation
import Testing

@testable import TalosShareCore

@Suite("A retried share carries the same Idempotency-Key")
struct ShareIdempotencyTests {
    let keyShape = #"^[A-Za-z0-9_-]{16,64}$"#

    func sendKeyed(_ payload: SharePayload, _ key: String?, via s: MockSession) async -> ShareResult {
        await ShareClient.send(payload, token: token(), relayHost: relay, session: s, idempotencyKey: key)
    }

    @Test func theRequestCarriesTheKeyInAHeaderAndNotInTheBody() async throws {
        let s = try MockSession(fixture: "accepted-202")
        _ = await sendKeyed(SharePayload(text: "hi", note: "n"), "0F8FAD5B-D9CB-469F-A165-70867728950E", via: s)
        let c = try #require(s.calls.first)
        #expect(c.request.value(forHTTPHeaderField: "Idempotency-Key") == "0F8FAD5B-D9CB-469F-A165-70867728950E")
        #expect(!String(decoding: c.body, as: UTF8.self).contains("0F8FAD5B"))  // an older relay refuses unknown form fields
        #expect(!c.request.url!.absoluteString.contains("0F8FAD5B"))
    }

    @Test func noKeyMeansNoHeader() async throws {
        let s = try MockSession(fixture: "accepted-202")
        let r = await ShareClient.send(SharePayload(text: "hi"), token: token(), relayHost: relay, session: s)
        #expect(r == .sent(shareID: "01M65E66VEB45C04FJ1PBTKRK6"))
        #expect(try #require(s.calls.first).request.value(forHTTPHeaderField: "Idempotency-Key") == nil)
    }

    @Test func aKeyTheRelayWouldRefuseIsLeftOutSoTheShareStillGoes() async throws {
        for bad in ["short", String(repeating: "a", count: 65), "has space in it 1234", "line\nbreak-123456789", "0123456789abcdef\n"] {
            let s = try MockSession(fixture: "accepted-202")
            _ = await sendKeyed(SharePayload(text: "hi"), bad, via: s)
            #expect(try #require(s.calls.first).request.value(forHTTPHeaderField: "Idempotency-Key") == nil)
        }
    }

    @Test func aRetryAfterALostReplyCarriesTheSameKey() async throws {
        let payload = SharePayload(text: "hi", note: "read later")
        var rk = ShareRetryKey()
        let lost = MockSession { _ in throw URLError(.networkConnectionLost) }
        let first = await sendKeyed(payload, rk.key(for: payload), via: lost)
        #expect(first == .network(code: URLError.networkConnectionLost.rawValue))
        let ok = try MockSession(fixture: "accepted-202")
        let second = await sendKeyed(payload, rk.key(for: payload), via: ok)
        #expect(second == .sent(shareID: "01M65E66VEB45C04FJ1PBTKRK6"))
        let a = try #require(lost.calls.first).request.value(forHTTPHeaderField: "Idempotency-Key")
        let b = try #require(ok.calls.first).request.value(forHTTPHeaderField: "Idempotency-Key")
        #expect(a != nil)
        #expect(a == b)
    }

    @Test func aRetryAfterARefusalOrRateLimitStillCarriesTheSameKey() async throws {
        let payload = SharePayload(text: "hi", note: "read later")
        var rk = ShareRetryKey()
        let limited = try MockSession(fixture: "rate-limited-429")
        #expect(await sendKeyed(payload, rk.key(for: payload), via: limited) == .rateLimited(retryAfterSeconds: 6))
        let bad = try MockSession(fixture: "empty-share-400")
        _ = await sendKeyed(payload, rk.key(for: payload), via: bad)
        let ok = try MockSession(fixture: "accepted-202")
        _ = await sendKeyed(payload, rk.key(for: payload), via: ok)
        let keys = [limited, bad, ok].map { $0.calls.first?.request.value(forHTTPHeaderField: "Idempotency-Key") }
        #expect(keys[0] != nil)
        #expect(Set(keys).count == 1)
    }

    @Test func editingTheNoteBetweenTriesChangesTheKey() {
        var rk = ShareRetryKey()
        let one = rk.key(for: SharePayload(text: "hi", note: "read later"))
        #expect(rk.key(for: SharePayload(text: "hi", note: "read later")) == one)
        let two = rk.key(for: SharePayload(text: "hi", note: "read tonight"))
        #expect(two != one)
        #expect(rk.key(for: SharePayload(text: "hi", note: "read tonight")) == two)
        #expect(rk.key(for: SharePayload(text: "hi")) != two)  // clearing the note is an edit too
    }

    @Test func eachSessionMakesItsOwnKeyAndItCarriesNothingFromTheShare() {
        var a = ShareRetryKey()
        var b = ShareRetryKey()
        let p = SharePayload(text: "secret words", url: "https://example.com/private", title: "T", note: "a note")
        let ka = a.key(for: p)
        #expect(ka != b.key(for: p))
        #expect(ka.range(of: keyShape, options: .regularExpression) != nil)
        for part in ["secret", "example", "note", "words"] { #expect(!ka.lowercased().contains(part)) }
    }
}
