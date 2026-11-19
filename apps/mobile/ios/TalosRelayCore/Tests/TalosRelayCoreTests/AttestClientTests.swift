import XCTest
@testable import TalosRelayCore

private struct KeyV: Decodable { let fp: String }
private struct Expect: Decodable { let verdict: String }
private struct CaseV: Decodable { let name: String; let context: String; let pinned_fp: String; let body_hex: String; let expect: Expect }
private struct VectorFile: Decodable {
    let nonce: String; let origin: String; let relay_id: String
    let keys: [String: KeyV]
    let cases: [CaseV]
}

/// The attest client with a transport that is a script: every status code, the 8 KB cap, the cookie rule, the single retry of a
/// 429 inside the 10 seconds, and a fresh nonce per attempt. The answers are real signed vectors, so a pass here is a real check.
final class AttestClientTests: XCTestCase {
    private func unhex(_ s: String) -> Data {
        var out = Data()
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    private func load() throws -> VectorFile {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { dir.deleteLastPathComponent() }
        let url = dir.appending(path: "packages/protocol/fixtures/bridge-attest/vectors.json")
        return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
    }

    /// Plays back a list of results and records what was asked.
    final class Script: AttestTransport, @unchecked Sendable {
        var results: [AttestTransportResult]
        private(set) var calls: [(url: URL, body: Data, cookie: String?, timeout: TimeInterval)] = []
        init(_ r: [AttestTransportResult]) { results = r }
        func post(url: URL, body: Data, cookie: String?, timeout: TimeInterval) async -> AttestTransportResult {
            calls.append((url, body, cookie, timeout))
            return results.isEmpty ? .failed : results.removeFirst()
        }
    }

    /// A monotonic clock the test moves by hand. The wall clock plays no part in the 10 s budget.
    final class Time: @unchecked Sendable {
        var uptime: TimeInterval = 5000
        private(set) var slept: [TimeInterval] = []
        func sleep(_ s: TimeInterval) async { slept.append(s); uptime += s }
    }

    private struct Fixture { let v: VectorFile; let good: Data; let pinned: String }

    private func fixture() throws -> Fixture {
        let v = try load()
        let c = try XCTUnwrap(v.cases.first { $0.name == "the pinned key signs: pass" })
        return Fixture(v: v, good: unhex(c.body_hex), pinned: c.pinned_fp)
    }

    private func client(_ f: Fixture, _ script: Script, _ time: Time, nonces: [String]? = nil) -> AttestClient {
        var queue = nonces ?? [f.v.nonce]
        return AttestClient(
            transport: script, nonce: { queue.count > 1 ? queue.removeFirst() : queue[0] }, monotonic: { time.uptime },
            sleep: { await time.sleep($0) })
    }

    private func run(_ f: Fixture, _ c: AttestClient, cookie: String? = nil, context: BridgeAttest.Context = .reconnect) async -> AttestOutcome {
        await c.attest(
            origin: URL(string: f.v.origin)!, relayID: f.v.relay_id, pinnedFP: f.pinned, cookie: cookie, context: context)
    }

    private func response(_ status: Int, _ body: String = "", retryAfter: String? = nil) -> AttestTransportResult {
        .response(status: status, retryAfter: retryAfter, body: Data(body.utf8))
    }

    // MARK: the request

    func testPostsTheNonceToTheAttestRoute() async throws {
        let f = try fixture()
        let script = Script([.response(status: 200, retryAfter: nil, body: f.good)])
        let out = await run(f, client(f, script, Time()))
        XCTAssertEqual(out, .verdict(.pass))
        let call = try XCTUnwrap(script.calls.first)
        XCTAssertEqual(call.url.absoluteString, f.v.origin + "/api/bridge/attest")
        XCTAssertEqual(String(decoding: call.body, as: UTF8.self), "{\"nonce\":\"\(f.v.nonce)\"}")
    }

    func testTheNonceIs32RandomBytesAs43Characters() {
        var seen = Set<String>()
        for _ in 0..<50 {
            let n = AttestClient.randomNonce()
            XCTAssertEqual(n.utf8.count, 43)
            XCTAssertTrue(BridgeAttest.isCanonicalFP(n), "32 bytes encode to canonical text")
            seen.insert(n)
        }
        XCTAssertEqual(seen.count, 50)
    }

    func testRefusesANonHttpsOrigin() async throws {
        let f = try fixture()
        let script = Script([])
        let out = await client(f, script, Time()).attest(
            origin: URL(string: "http://relay.example.test")!, relayID: f.v.relay_id, pinnedFP: f.pinned, cookie: nil, context: .reconnect)
        XCTAssertEqual(out, .unreachable(.badAnswer))
        XCTAssertTrue(script.calls.isEmpty, "nothing is sent over http")
    }

    // MARK: the cookie rule

    func testTheCookieIsPassedOnlyWhenGiven() async throws {
        let f = try fixture()
        let a = Script([.response(status: 200, retryAfter: nil, body: f.good)])
        _ = await run(f, client(f, a, Time()), cookie: "__Host-talos_s=abc")
        XCTAssertEqual(a.calls.first?.cookie, "__Host-talos_s=abc")
        let b = Script([.response(status: 200, retryAfter: nil, body: f.good)])
        _ = await run(f, client(f, b, Time()), cookie: nil, context: .pair)
        XCTAssertNil(b.calls.first?.cookie, "pairing sends no cookie")
    }

    func testAtPairingTheClientDropsAnyCookieItWasHanded() async throws {
        let f = try fixture()
        let s = Script([.response(status: 200, retryAfter: nil, body: f.good)])
        _ = await run(f, client(f, s, Time()), cookie: "__Host-talos_s=abc", context: .pair)
        XCTAssertNil(s.calls.first?.cookie)
    }

    func testOnlyTheSessionCookieHeaderShapeIsAccepted() {
        XCTAssertEqual(AttestClient.cookieHeader(name: "__Host-talos_s", value: "abcDEF-_.~123"), "__Host-talos_s=abcDEF-_.~123")
        for bad in ["", "a;b", "a b", "a\r\nX: y", "a,b", "a\"b", "a\\b", "é", String(repeating: "a", count: 4097)] {
            XCTAssertNil(AttestClient.cookieHeader(name: "__Host-talos_s", value: bad), bad)
        }
        XCTAssertNil(AttestClient.cookieHeader(name: "other", value: "abc"), "only the relay's session cookie")
    }

    // MARK: every status

    func testEachStatusMapsToItsOwnOutcome() async throws {
        let f = try fixture()
        let cases: [(AttestTransportResult, AttestOutcome)] = [
            (response(400, "{\"error\":\"bad_request\"}"), .unreachable(.badAnswer)),
            (response(503, "{\"error\":\"mac_offline\"}"), .unreachable(.macOffline)),
            (response(503, "{\"error\":\"attest_unsupported\"}"), .unreachable(.unsupported)),
            (response(503, "{\"error\":\"something_else\"}"), .unreachable(.badAnswer)),
            (response(503, "not json"), .unreachable(.badAnswer)),
            (response(504, "{\"error\":\"attest_timeout\"}"), .unreachable(.macTimeout)),
            (response(500), .unreachable(.badAnswer)),
            (response(401), .unreachable(.badAnswer)),
            (response(302), .unreachable(.badAnswer)),
            (response(204), .unreachable(.badAnswer)),
            (.failed, .unreachable(.network)),
            (.tooLarge(status: 200), .verdict(.fail(.badShape))),
            (.tooLarge(status: 503), .unreachable(.badAnswer)),
            (.tooLarge(status: 429), .unreachable(.badAnswer)),
        ]
        for (given, want) in cases {
            let out = await run(f, client(f, Script([given]), Time()))
            XCTAssertEqual(out, want, "\(given)")
        }
    }

    func testA200WithABadBodyIsAFailNotUnreachable() async throws {
        let f = try fixture()
        let out = await run(f, client(f, Script([response(200, "{}")]), Time()))
        XCTAssertEqual(out, .verdict(.fail(.badShape)))
    }

    func testA200ForAnotherKeyIsAFailAndAChainIsARepinOnlyOnReconnect() async throws {
        let f = try fixture()
        let wrong = try XCTUnwrap(f.v.cases.first { $0.expect.verdict == "fail" && $0.context == "reconnect" })
        let outFail = await client(f, Script([.response(status: 200, retryAfter: nil, body: unhex(wrong.body_hex))]), Time()).attest(
            origin: URL(string: f.v.origin)!, relayID: f.v.relay_id, pinnedFP: wrong.pinned_fp, cookie: nil, context: .reconnect)
        guard case .verdict(.fail) = outFail else { return XCTFail("\(outFail)") }
        let chain = try XCTUnwrap(f.v.cases.first { $0.name == "a chain from the pinned key to the signing key: repin" })
        let body = unhex(chain.body_hex)
        let re = await client(f, Script([.response(status: 200, retryAfter: nil, body: body)]), Time()).attest(
            origin: URL(string: f.v.origin)!, relayID: f.v.relay_id, pinnedFP: chain.pinned_fp, cookie: nil, context: .reconnect)
        guard case .verdict(.repin) = re else { return XCTFail("\(re)") }
        let pair = await client(f, Script([.response(status: 200, retryAfter: nil, body: body)]), Time()).attest(
            origin: URL(string: f.v.origin)!, relayID: f.v.relay_id, pinnedFP: chain.pinned_fp, cookie: nil, context: .pair)
        XCTAssertEqual(pair, .verdict(.fail(.repinAtPair)), "a re-pin at pairing is a fail")
    }

    func testAnAnswerOverTheCapIsAFailNotUnverifiedAndNeverReachesTheSignatureCheck() async throws {
        let f = try fixture()
        // a transport that hands over more than 8 KB is refused by the client even if it forgot to cut it off
        let big = Data(repeating: 0x20, count: BridgeAttest.bodyMax + 1) + f.good
        let out = await run(f, client(f, Script([.response(status: 200, retryAfter: nil, body: big)]), Time()))
        XCTAssertEqual(out, .verdict(.fail(.badShape)), "the spec's check order: size is step 1 of the check, so it is a fail")
        let cut = await run(f, client(f, Script([.tooLarge(status: 200)]), Time()))
        XCTAssertEqual(cut, .verdict(.fail(.badShape)))
        let other = await run(f, client(f, Script([.response(status: 500, retryAfter: nil, body: big)]), Time()))
        XCTAssertEqual(other, .unreachable(.badAnswer), "a big body on an error status is still only an unreachable relay")
        XCTAssertEqual(AttestClient.bodyCap, 8192)
    }

    // MARK: the one retry of a 429

    func testA429IsRetriedOnceWithAFreshNonce() async throws {
        let f = try fixture()
        let s = Script([response(429, "{}", retryAfter: "2"), .response(status: 200, retryAfter: nil, body: f.good)])
        let time = Time()
        let out = await run(f, client(f, s, time, nonces: [(f.v.nonce.hasPrefix("Z") ? "Y" : "Z") + String(f.v.nonce.dropFirst()), f.v.nonce]))
        XCTAssertEqual(out, .verdict(.pass))
        XCTAssertEqual(time.slept, [2])
        XCTAssertEqual(s.calls.count, 2)
        XCTAssertNotEqual(s.calls[0].body, s.calls[1].body, "a fresh nonce for the second attempt")
    }

    func testASecond429IsNotRetriedAgain() async throws {
        let f = try fixture()
        let s = Script([response(429, "{}", retryAfter: "1"), response(429, "{}", retryAfter: "1"), .response(status: 200, retryAfter: nil, body: f.good)])
        let out = await run(f, client(f, s, Time()))
        XCTAssertEqual(out, .unreachable(.rateLimited))
        XCTAssertEqual(s.calls.count, 2)
    }

    func testARetryAfterThatDoesNotFitInTheTenSecondsIsNotWaitedFor() async throws {
        let f = try fixture()
        for after in ["30", "10", "9.5", "abc", "", "-1", "0"] {
            let s = Script([response(429, "{}", retryAfter: after)])
            let time = Time()
            let out = await run(f, client(f, s, time))
            XCTAssertEqual(out, .unreachable(.rateLimited), after)
            XCTAssertEqual(s.calls.count, 1, "Retry-After: \(after)")
            XCTAssertTrue(time.slept.isEmpty)
        }
        let none = Script([response(429)])
        let out = await run(f, client(f, none, Time()))
        XCTAssertEqual(out, .unreachable(.rateLimited), "no Retry-After header")
        XCTAssertEqual(none.calls.count, 1)
    }

    func testTheBudgetFollowsTheMonotonicClockAndNotTheWallClock() async throws {
        let f = try fixture()
        // The only clock the client reads is the monotonic one it was given: moving it past 10 s ends the attempts.
        let time = Time()
        let s = Script([response(429, "{}", retryAfter: "5"), response(429, "{}", retryAfter: "1")])
        let c = AttestClient(
            transport: s, nonce: { f.v.nonce }, monotonic: { time.uptime }, sleep: { time.uptime += 8; await time.sleep($0) })
        let out = await c.attest(origin: URL(string: f.v.origin)!, relayID: f.v.relay_id, pinnedFP: f.pinned, cookie: nil, context: .reconnect)
        XCTAssertEqual(out, .unreachable(.network), "the monotonic clock passed 10 s during the wait: no second attempt")
        XCTAssertEqual(s.calls.count, 1)
    }

    func testTheTenSecondsAreTotalAcrossBothAttempts() async throws {
        let f = try fixture()
        let s = Script([response(429, "{}", retryAfter: "4"), .response(status: 200, retryAfter: nil, body: f.good)])
        let time = Time()
        _ = await run(f, client(f, s, time))
        XCTAssertEqual(s.calls[0].timeout, 10, accuracy: 0.001)
        XCTAssertEqual(s.calls[1].timeout, 6, accuracy: 0.001, "the second attempt gets what is left of the 10 s")
    }

    func testOtherFailuresAreNeverRetried() async throws {
        let f = try fixture()
        for r in [response(503, "{\"error\":\"mac_offline\"}"), response(504), .failed, response(500)] {
            let s = Script([r, .response(status: 200, retryAfter: nil, body: f.good)])
            _ = await run(f, client(f, s, Time()))
            XCTAssertEqual(s.calls.count, 1, "\(r)")
        }
    }
}
