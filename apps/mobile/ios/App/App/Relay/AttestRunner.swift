import Foundation
import TalosRelayCore
import WebKit

/// Runs one attest for a relay (BYOR phase 4b, docs/specs/BYOR-phase4-frame.md sections 3 and 4). A protocol so tests (and the DEBUG hook)
/// can stand in for the network; the real one is `LiveAttester`.
protocol AttestRunning {
    /// `cookie` is the relay's session cookie for a paired relay, nil at pairing. `context` is `.pair` only inside the Add-relay flow.
    func run(origin: URL, relayID: String, pinnedFP: String, cookie: String?, context: BridgeAttest.Context) async -> AttestOutcome
}

struct LiveAttester: AttestRunning {
    var client = AttestClient(transport: URLSessionAttestTransport())

    func run(origin: URL, relayID: String, pinnedFP: String, cookie: String?, context: BridgeAttest.Context) async -> AttestOutcome {
        await client.attest(origin: origin, relayID: relayID, pinnedFP: pinnedFP, cookie: cookie, context: context)
    }
}

/// The real transport: native, https only, an ephemeral session with no cookie jar, no cache and no redirects (a redirect could leave the
/// origin the owner confirmed, and would carry the cookie along), a capped streaming read, and the one `Cookie` header the client hands in.
struct URLSessionAttestTransport: AttestTransport {
    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ s: URLSession, task: URLSessionTask, willPerformHTTPRedirection r: HTTPURLResponse,
                        newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }

    func post(url: URL, body: Data, cookie: String?, timeout: TimeInterval) async -> AttestTransportResult {
        guard url.scheme == "https", timeout > 0 else { return .failed }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.httpBody = body
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed }
            if http.expectedContentLength > Int64(AttestClient.bodyCap) { return .tooLarge(status: http.statusCode) }
            var data = Data()
            for try await b in bytes {
                data.append(b)
                if data.count > AttestClient.bodyCap { return .tooLarge(status: http.statusCode) }
            }
            return .response(status: http.statusCode, retryAfter: http.value(forHTTPHeaderField: "Retry-After"), body: data)
        } catch {
            return .failed
        }
    }
}

/// The relay's session cookie, read from THIS profile's own web view data store and nowhere else. Only the exact `__Host-` cookie that
/// belongs to the origin is taken (host-only, path `/`, secure), so a cookie set for another host or path is never sent.
enum PairedSessionCookie {
    @MainActor
    static func header(store: WKHTTPCookieStore, origin: URL) async -> String? {
        let cookies = await store.allCookies()
        return header(from: cookies, origin: origin)
    }

    static func header(from cookies: [HTTPCookie], origin: URL) -> String? {
        guard let host = origin.host?.lowercased(), origin.scheme == "https" else { return nil }
        for c in cookies where c.name == AttestClient.sessionCookieName {
            guard c.isSecure, c.path == "/", c.domain.lowercased() == host else { continue }  // host-only: no leading dot
            if let h = AttestClient.cookieHeader(name: c.name, value: c.value) { return h }
        }
        return nil
    }
}
