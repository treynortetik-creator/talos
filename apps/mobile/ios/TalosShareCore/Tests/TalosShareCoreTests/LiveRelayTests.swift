import Foundation
import Testing

@testable import TalosShareCore

/// Live tests against a relay that `test.sh --live` starts from this repo's own test harness (apps/relay), over
/// http://127.0.0.1. Without TALOS_LIVE_CONFIG they skip, with the reason below. Never points at a deployed relay.
struct LiveConfig: Decodable {
    struct Tokens: Decodable { let text, files, limit, revoked: String }
    let relay: String
    let control: String
    let tokens: Tokens

    static let current: LiveConfig? = {
        guard let p = ProcessInfo.processInfo.environment["TALOS_LIVE_CONFIG"],
            let d = FileManager.default.contents(atPath: p)
        else {
            print("LIVE TESTS SKIPPED: TALOS_LIVE_CONFIG is not set; run ./test.sh --live to start a local relay")
            return nil
        }
        return try? JSONDecoder().decode(LiveConfig.self, from: d)
    }()
}

/// Gives every request its own client address (the relay runs with TRUST_PROXY_HOPS=1), so the 10/min/IP bucket does
/// not decide the 30/hour/token test. Real clients send no such header.
final class SpreadSession: URLSessionProtocol, @unchecked Sendable {
    private let inner = ShareURLSession()
    private let lock = NSLock()
    private var n = 0
    func upload(for request: URLRequest, fromFile fileURL: URL) async throws -> (Data, URLResponse) {
        var r = request
        let i = lock.withLock { () -> Int in n += 1; return n }
        r.setValue("203.0.113.\(i % 250 + 1)", forHTTPHeaderField: "X-Forwarded-For")
        return try await inner.upload(for: r, fromFile: fileURL)
    }
}

private func items() async throws -> [[String: Any]] {
    let c = try #require(LiveConfig.current)
    let (d, _) = try await URLSession.shared.data(from: URL(string: c.control + "/items")!)
    return try #require(JSONSerialization.jsonObject(with: d) as? [[String: Any]])
}

private func message(_ item: [String: Any]) -> [String: Any] { item["message"] as? [String: Any] ?? [:] }

@Suite("Live relay (local harness)", .serialized, .enabled(if: LiveConfig.current != nil, "needs ./test.sh --live"))
struct LiveRelayTests {
    let cfg = LiveConfig.current
    var host: URL { URL(string: cfg!.relay)! }
    func tok(_ s: String, _ scopes: Set<ShareScope>) -> ShareToken { ShareToken(secret: s, scopes: scopes)! }

    @Test func textShareIs202AndLandsAnInboxRow() async throws {
        let before = try await items().count
        let r = await ShareClient.send(
            SharePayload(text: "live text ✓ \r\nsecond line", url: "https://example.com/a", title: "A page", note: "read later"),
            token: tok(cfg!.tokens.text, [.text]), relayHost: host, session: SpreadSession(), allowLoopbackHTTP: true)
        guard case .sent(let id) = r else { Issue.record("expected sent, got \(r)"); return }
        #expect(id?.isEmpty == false)
        let all = try await items()
        #expect(all.count == before + 1)
        let item = try #require(all.last { $0["share_id"] as? String == id })
        let m = message(item)
        #expect(m["thread_id"] as? String == "inbox")
        #expect(m["via"] as? String == "share")
        #expect(m["author"] as? String == "owner")
        #expect(m["text"] as? String == "read later")
        let content = try #require(m["share_content"] as? [String: Any])
        #expect(content["text"] as? String == "live text ✓ \r\nsecond line")
        #expect(content["url"] as? String == "https://example.com/a")
        #expect(content["title"] as? String == "A page")
    }

    @Test func photoOnlyWithFilesScopeIs202() async throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        // A real 1x1 PNG, so the relay's MIME sniffing accepts it.
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
        let u = d.appendingPathComponent("IMG_0001.png")
        try png.write(to: u)
        let r = await ShareClient.send(
            SharePayload(files: [ShareFile(url: u, filename: "IMG_0001.png", mimeType: "image/png")]),
            token: tok(cfg!.tokens.files, [.text, .files]), relayHost: host, session: SpreadSession(), allowLoopbackHTTP: true)
        guard case .sent(let id) = r else { Issue.record("expected sent, got \(r)"); return }
        let item = try #require(try await items().last { $0["share_id"] as? String == id })
        let atts = try #require(message(item)["attachments"] as? [[String: Any]])
        #expect(atts.count == 1)
    }

    @Test func hostileFileNameIsAcceptedAndCannotInjectAField() async throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
        let u = d.appendingPathComponent("x.png")
        try png.write(to: u)
        let r = await ShareClient.send(
            SharePayload(note: "weird name", files: [ShareFile(url: u, filename: "a\"b\r\nContent-Type: text/html\r\n\r\nx.png", mimeType: "image/png")]),
            token: tok(cfg!.tokens.files, [.text, .files]), relayHost: host, session: SpreadSession(), allowLoopbackHTTP: true)
        guard case .sent(let id) = r else { Issue.record("expected sent, got \(r)"); return }
        let item = try #require(try await items().last { $0["share_id"] as? String == id })
        let atts = try #require(message(item)["attachments"] as? [[String: Any]])
        #expect(atts.count == 1)
        let name = (atts[0]["name"] as? String) ?? ""
        #expect(!name.contains("\r") && !name.contains("\n"))
    }

    @Test func fileWithoutScopeIsRefusedLocallyAndNothingArrives() async throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let u = try makeFile(d, name: "a.png", bytes: 8)
        let before = try await items().count
        let r = await ShareClient.send(
            SharePayload(files: [ShareFile(url: u, filename: "a.png", mimeType: "image/png")]),
            token: tok(cfg!.tokens.text, [.text]), relayHost: host, session: SpreadSession(), allowLoopbackHTTP: true)
        #expect(r == .refused(.filesNotAllowed))
        #expect(try await items().count == before)
    }

    @Test func fileSentWithATextOnlyTokenClaimingFilesGetsThe403() async throws {
        // The local scope check is a courtesy; the relay is the authority.
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let u = try makeFile(d, name: "a.png", bytes: 8)
        let r = await ShareClient.send(
            SharePayload(files: [ShareFile(url: u, filename: "a.png", mimeType: "image/png")]),
            token: tok(cfg!.tokens.text, [.text, .files]), relayHost: host, session: SpreadSession(), allowLoopbackHTTP: true)
        #expect(r == .rejected(status: 403, code: "files_not_allowed"))
    }

    @Test func revokedTokenIsTokenInvalid() async {
        let r = await ShareClient.send(
            SharePayload(text: "x"), token: tok(cfg!.tokens.revoked, [.text]), relayHost: host, session: SpreadSession(),
            allowLoopbackHTTP: true)
        #expect(r == .tokenInvalid)
    }

    @Test func the31stShareInAnHourIsRateLimited() async {
        var results: [ShareResult] = []
        let session = SpreadSession()
        for i in 0..<31 {
            results.append(
                await ShareClient.send(
                    SharePayload(text: "n\(i)"), token: tok(cfg!.tokens.limit, [.text]), relayHost: host, session: session,
                    allowLoopbackHTTP: true))
        }
        for r in results.prefix(30) { if case .sent = r {} else { Issue.record("expected sent, got \(r)") } }
        guard case .rateLimited(let after) = results[30] else { Issue.record("31st was \(results[30])"); return }
        #expect((after ?? 0) > 0)
    }
}
