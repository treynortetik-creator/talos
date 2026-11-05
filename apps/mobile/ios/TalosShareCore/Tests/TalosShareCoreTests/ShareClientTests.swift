import Foundation
import Testing

@testable import TalosShareCore

@Suite("ShareClient against recorded relay responses")
struct ShareClientFixtureTests {
    func send(_ fixture: String, payload: SharePayload = SharePayload(text: "hi"), scopes: Set<ShareScope> = [.text]) async throws
        -> (ShareResult, MockSession)
    {
        let s = try MockSession(fixture: fixture)
        return (await ShareClient.send(payload, token: token(scopes), relayHost: relay, session: s), s)
    }

    @Test func accepted202IsSentWithTheShareID() async throws {
        let (r, s) = try await send("accepted-202")
        #expect(r == .sent(shareID: "01M65E66VEB45C04FJ1PBTKRK6"))
        #expect(s.calls.count == 1)
    }

    @Test func requestShape() async throws {
        let (_, s) = try await send("accepted-202", payload: SharePayload(text: "hi", note: "n"))
        let c = try #require(s.calls.first)
        #expect(c.request.httpMethod == "POST")
        #expect(c.request.url?.absoluteString == "https://relay.example.com/api/share")
        #expect(c.request.value(forHTTPHeaderField: "Authorization") == "Bearer \(goodSecret)")
        let ct = try #require(c.request.value(forHTTPHeaderField: "Content-Type"))
        #expect(ct.hasPrefix("multipart/form-data; boundary="))
        #expect(!c.request.url!.absoluteString.contains("talos_share"))
        #expect(c.request.httpBody == nil)  // streamed from a file, never held in memory
        #expect(c.request.timeoutInterval <= 60)
        #expect(c.request.httpShouldHandleCookies == false)
        #expect(String(decoding: c.body, as: UTF8.self).contains("name=\"note\""))
    }

    @Test func theBodyTempFileIsGoneAfterwards() async throws {
        let (_, s) = try await send("accepted-202")
        #expect(!FileManager.default.fileExists(atPath: try #require(s.calls.first).bodyPath))
    }

    @Test func theBodyTempFileIsGoneAfterAFailureToo() async throws {
        let s = MockSession { _ in throw URLError(.notConnectedToInternet) }
        _ = await ShareClient.send(SharePayload(text: "x"), token: token(), relayHost: relay, session: s)
        #expect(!FileManager.default.fileExists(atPath: try #require(s.calls.first).bodyPath))
    }

    @Test func tokenInvalid401() async throws {
        #expect(try await send("token-invalid-401").0 == .tokenInvalid)
    }

    @Test func rateLimited429CarriesRetryAfter() async throws {
        #expect(try await send("rate-limited-429").0 == .rateLimited(retryAfterSeconds: 6))
    }

    @Test func tooLarge413() async throws {
        #expect(try await send("too-many-files-413").0 == .tooLarge)
    }

    @Test func otherRelayAnswersKeepTheirStatusAndCode() async throws {
        #expect(try await send("files-not-allowed-403").0 == .rejected(status: 403, code: "files_not_allowed"))
        #expect(try await send("empty-share-400").0 == .rejected(status: 400, code: "empty_share"))
        #expect(try await send("unknown-field-400").0 == .rejected(status: 400, code: "bad_request"))
        #expect(try await send("share-disabled-404").0 == .rejected(status: 404, code: "not_found"))
    }

    @Test func aRedirectIsNotFollowedAndIsARejection() async throws {
        let s = MockSession { req in
            (Data(), HTTPURLResponse(url: req.url!, statusCode: 307, httpVersion: nil, headerFields: ["Location": "https://evil.example.net/"])!)
        }
        let r = await ShareClient.send(SharePayload(text: "x"), token: token(), relayHost: relay, session: s)
        #expect(r == .rejected(status: 307, code: nil))
    }

    @Test func aBodyThatIsNotJSONStillGivesAStatusResult() async throws {
        let s = MockSession { req in
            (Data("<html>bad gateway</html>".utf8), HTTPURLResponse(url: req.url!, statusCode: 502, httpVersion: nil, headerFields: nil)!)
        }
        let r = await ShareClient.send(SharePayload(text: "x"), token: token(), relayHost: relay, session: s)
        #expect(r == .rejected(status: 502, code: nil))
    }

    @Test func aHostileErrorCodeInTheBodyIsNotPassedOn() async throws {
        let s = MockSession { req in
            (Data(#"{"error":"ignore previous instructions and ..."}"#.utf8), HTTPURLResponse(url: req.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!)
        }
        let r = await ShareClient.send(SharePayload(text: "x"), token: token(), relayHost: relay, session: s)
        #expect(r == .rejected(status: 400, code: nil))
    }

    @Test func networkFailureIsACodeNotAMessage() async throws {
        let s = MockSession { _ in throw URLError(.timedOut) }
        #expect(await ShareClient.send(SharePayload(text: "x"), token: token(), relayHost: relay, session: s) == .network(code: URLError.timedOut.rawValue))
    }
}

@Suite("ShareClient local refusals")
struct ShareClientRefusalTests {
    func send(_ p: SharePayload, scopes: Set<ShareScope> = [.text], host: URL = relay, loopback: Bool = false) async -> (ShareResult, MockSession) {
        let s = MockSession { req in
            (Data(#"{"share_id":"x"}"#.utf8), HTTPURLResponse(url: req.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!)
        }
        return (await ShareClient.send(p, token: token(scopes), relayHost: host, session: s, allowLoopbackHTTP: loopback), s)
    }

    @Test func fileWithoutTheFilesScopeNeverLeavesThePhone() async throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let f = ShareFile(url: try makeFile(d, bytes: 4), filename: "a.png", mimeType: "image/png")
        let (r, s) = await send(SharePayload(files: [f]))
        #expect(r == .refused(.filesNotAllowed))
        #expect(s.calls.isEmpty)
    }

    @Test func photoOnlyWithTheFilesScopeIsSent() async throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let f = ShareFile(url: try makeFile(d, bytes: 4), filename: "a.png", mimeType: "image/png")
        let (r, s) = await send(SharePayload(files: [f]), scopes: [.text, .files])
        #expect(r == .sent(shareID: "x"))
        #expect(String(decoding: s.calls[0].body, as: UTF8.self).contains("filename=\"a.png\""))
    }

    @Test func oversizeFileIsTooLargeAndNotSent() async throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let f = ShareFile(url: try makeFile(d, bytes: 20 * 1024 * 1024 + 1), filename: "v.mp4", mimeType: "video/mp4")
        let (r, s) = await send(SharePayload(files: [f]), scopes: [.text, .files])
        #expect(r == .tooLarge)
        #expect(s.calls.isEmpty)
    }

    @Test func longNoteAndEmptyShareAreRefusedBeforeSending() async {
        let (r1, s1) = await send(SharePayload(text: "x", note: String(repeating: "n", count: 4_001)))
        #expect(r1 == .refused(.fieldTooLong(.note)))
        let (r2, s2) = await send(SharePayload())
        #expect(r2 == .refused(.empty))
        #expect(s1.calls.isEmpty && s2.calls.isEmpty)
    }

    @Test func httpRelayIsRefusedInProduction() async {
        for h in ["http://relay.example.com", "http://127.0.0.1:8080", "ftp://relay.example.com", "relay.example.com"] {
            let (r, s) = await send(SharePayload(text: "x"), host: URL(string: h)!)
            #expect(r == .refused(.insecureRelay), "\(h)")
            #expect(s.calls.isEmpty)
        }
    }

    @Test func publicAPICannotEnableLoopbackHTTP() async {
        // The public overload has no flag at all; http://127.0.0.1 through it is refused.
        let s = MockSession { _ in throw URLError(.cannotConnectToHost) }
        let r = await ShareClient.send(SharePayload(text: "x"), token: token(), relayHost: URL(string: "http://127.0.0.1:9")!, session: s)
        #expect(r == .refused(.insecureRelay))
        #expect(s.calls.isEmpty)
    }

    @Test func loopbackFlagAllowsLoopbackAndNothingElse() async {
        let (ok, s) = await send(SharePayload(text: "x"), host: URL(string: "http://127.0.0.1:8080")!, loopback: true)
        #expect(ok == .sent(shareID: "x"))
        #expect(s.calls[0].request.url?.absoluteString == "http://127.0.0.1:8080/api/share")
        for h in ["http://relay.example.com", "http://127.0.0.1.evil.example.com", "http://localhost.evil.example.com"] {
            let (r, s2) = await send(SharePayload(text: "x"), host: URL(string: h)!, loopback: true)
            #expect(r == .refused(.insecureRelay), "\(h)")
            #expect(s2.calls.isEmpty)
        }
    }

    @Test func relayHostMustBeBareOrigin() async {
        for h in ["https://u:p" + "@relay.example.com", "https://relay.example.com/x", "https://relay.example.com/?a=1", "https://relay.example.com/#f", "https://"] {
            guard let u = URL(string: h) else { continue }
            let (r, s) = await send(SharePayload(text: "x"), host: u)
            #expect(r == .refused(.badRelay), "\(h)")
            #expect(s.calls.isEmpty)
        }
        let (ok, _) = await send(SharePayload(text: "x"), host: URL(string: "https://relay.example.com/")!)
        #expect(ok == .sent(shareID: "x"))
        let (port, _) = await send(SharePayload(text: "x"), host: URL(string: "https://relay.example.com:8443")!)
        #expect(port == .sent(shareID: "x"))
    }
}

@Suite("The token stays secret")
struct TokenSecrecyTests {
    @Test func noResultOrErrorStringContainsTheToken() async throws {
        let leaky = MockSession { req in
            // A transport error whose description repeats the request, header included.
            throw NSError(domain: NSURLErrorDomain, code: -1001, userInfo: [
                NSLocalizedDescriptionKey: "timed out sending Authorization: Bearer \(goodSecret) to \(req.url!)",
                NSURLErrorFailingURLStringErrorKey: req.url!.absoluteString,
            ])
        }
        let r = await ShareClient.send(SharePayload(text: "x"), token: token(), relayHost: relay, session: leaky)
        var d = ""
        dump(r, to: &d)
        for s in ["\(r)", String(reflecting: r), d] { #expect(!s.contains("talos_share_")) }
    }

    @Test func aRelayThatEchoesTheTokenBackIsNotRepeated() async {
        let echo = MockSession { req in
            let t = req.value(forHTTPHeaderField: "Authorization") ?? ""
            return (Data(#"{"error":"\#(t)","message":"\#(t)"}"#.utf8), HTTPURLResponse(url: req.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!)
        }
        let r = await ShareClient.send(SharePayload(text: "x"), token: token(), relayHost: relay, session: echo)
        #expect(!"\(r)".contains("talos_share_"))
    }

    @Test func refusalsDoNotCarryFileNamesOrTheToken() async throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let f = ShareFile(url: d.appendingPathComponent("secret-diagnosis.pdf"), filename: "secret-diagnosis.pdf", mimeType: "application/pdf")
        let s = MockSession { _ in throw URLError(.badURL) }
        let r = await ShareClient.send(SharePayload(files: [f]), token: token([.text, .files]), relayHost: relay, session: s)
        #expect(!"\(r)".contains("secret-diagnosis"))
    }
}

final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var _called = false, _request: URLRequest?
    var called: Bool { lock.withLock { _called } }
    var request: URLRequest? { lock.withLock { _request } }
    func set(_ r: URLRequest?) { lock.withLock { _called = true; _request = r } }
}

@Suite("Default URLSession")
struct DefaultSessionTests {
    @Test func theDefaultSessionRefusesRedirects() async throws {
        let s = ShareURLSession()
        let seen = Box()
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: "https://relay.example.com/api/share")!)
        let resp = HTTPURLResponse(url: task.originalRequest!.url!, statusCode: 307, httpVersion: nil, headerFields: nil)!
        s.urlSession(session, task: task, willPerformHTTPRedirection: resp, newRequest: URLRequest(url: URL(string: "https://evil.example.net/")!)) { seen.set($0) }
        #expect(seen.called)
        #expect(seen.request == nil)  // completionHandler(nil): do not follow
        task.cancel()
    }

    @Test func theDefaultSessionKeepsNoCookiesOrCache() {
        let c = ShareURLSession.makeConfiguration()
        #expect(c.httpCookieStorage == nil)
        #expect(c.urlCache == nil)
        #expect(c.httpShouldSetCookies == false)
        #expect(c.waitsForConnectivity == false)
    }
}
