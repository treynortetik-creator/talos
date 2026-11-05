import Foundation

/// The one thing `ShareClient` needs from the network, so tests can hand it recorded relay answers.
public protocol URLSessionProtocol: Sendable {
    func upload(for request: URLRequest, fromFile fileURL: URL) async throws -> (Data, URLResponse)
}

/// What happened to a share. No case carries free text from the relay or the system, and none can carry the token.
public enum ShareResult: Equatable, Sendable {
    /// 202. `shareID` is the relay's id when it sent a well-formed one.
    case sent(shareID: String?)
    /// 401: the link is revoked, wrong, or its device was revoked. "Turn the share sheet on again in Talos Settings."
    case tokenInvalid
    /// 429: "Too many shares; try in a few minutes."
    case rateLimited(retryAfterSeconds: Int?)
    /// 413 from the relay, or a file count or size over the limits caught on the phone.
    case tooLarge
    /// The request never got an answer. `code` is the `URLError` code, nothing else.
    case network(code: Int)
    /// Refused on the phone; nothing was sent.
    case refused(ShareRefusal)
    /// Any other answer (400, 403, 404, 5xx, a redirect), with the relay's short error code when it looks like one.
    case rejected(status: Int, code: String?)
}

public enum ShareClient {
    /// Posts `payload` to `<relayHost>/api/share` with `Authorization: Bearer <token>`.
    ///
    /// `relayHost` is the compiled relay origin, never a value from a web page. https only. Files are checked against
    /// the token's scopes and the limits before anything is sent.
    public static func send(
        _ payload: SharePayload, token: ShareToken, relayHost: URL, session: URLSessionProtocol = ShareURLSession()
    ) async -> ShareResult {
        await send(payload, token: token, relayHost: relayHost, session: session, allowLoopbackHTTP: false)
    }

    /// Test-only seam: `internal`, so only `@testable import` can reach it. Allows `http://` to 127.0.0.1, localhost
    /// and ::1 for the local-relay tests, and to nothing else.
    static func send(
        _ payload: SharePayload, token: ShareToken, relayHost: URL, session: URLSessionProtocol, allowLoopbackHTTP: Bool
    ) async -> ShareResult {
        let endpoint: URL
        do { endpoint = try endpointURL(relayHost, allowLoopbackHTTP: allowLoopbackHTTP) } catch {
            return .refused((error as? ShareRefusal) ?? .badRelay)
        }
        do { try payload.validate(scopes: token.scopes) } catch let r as ShareRefusal {
            return (r == .tooManyFiles || r == .fileTooLarge) ? .tooLarge : .refused(r)
        } catch { return .refused(.localIO) }

        let body = FileManager.default.temporaryDirectory.appendingPathComponent("talos-share-\(UUID().uuidString).multipart")
        defer { try? FileManager.default.removeItem(at: body) }
        var writer = MultipartWriter()
        var attempts = 0
        while true {
            do {
                try writer.write(payload, to: body)
                break
            } catch ShareRefusal.badBoundary where attempts < 3 {
                attempts += 1
                writer = MultipartWriter()
            } catch ShareRefusal.fileTooLarge {
                return .tooLarge
            } catch let r as ShareRefusal {
                return .refused(r)
            } catch { return .refused(.localIO) }
        }

        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.setValue(writer.contentType, forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token.secret)", forHTTPHeaderField: "Authorization")

        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.upload(for: request, fromFile: body) } catch {
            return .network(code: networkCode(error))
        }
        guard let http = response as? HTTPURLResponse else { return .network(code: URLError.badServerResponse.rawValue) }
        return interpret(http, data, token: token)
    }

    // MARK: - Relay URL

    static func endpointURL(_ relayHost: URL, allowLoopbackHTTP: Bool) throws -> URL {
        guard let c = URLComponents(url: relayHost, resolvingAgainstBaseURL: false), let scheme = c.scheme?.lowercased() else {
            throw ShareRefusal.insecureRelay
        }
        let host = (c.host ?? "").lowercased()
        let loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host)
        guard scheme == "https" || (scheme == "http" && allowLoopbackHTTP && loopback) else { throw ShareRefusal.insecureRelay }
        guard !host.isEmpty, c.user == nil, c.password == nil, c.query == nil, c.fragment == nil, c.path.isEmpty || c.path == "/"
        else { throw ShareRefusal.badRelay }
        var out = URLComponents()
        out.scheme = scheme
        out.host = c.host
        out.port = c.port
        out.path = "/api/share"
        guard let url = out.url else { throw ShareRefusal.badRelay }
        return url
    }

    // MARK: - Answers

    private static func networkCode(_ error: Error) -> Int {
        if let e = error as? URLError { return e.code.rawValue }
        if error is CancellationError { return URLError.cancelled.rawValue }
        return (error as NSError).code
    }

    private static func interpret(_ http: HTTPURLResponse, _ data: Data, token: ShareToken) -> ShareResult {
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        switch http.statusCode {
        case 202: return .sent(shareID: clean(json?["share_id"], pattern: #"^[A-Za-z0-9_-]{1,64}$"#, token: token))
        case 401: return .tokenInvalid
        case 413: return .tooLarge
        case 429:
            let after = Int((http.value(forHTTPHeaderField: "Retry-After") ?? "").trimmingCharacters(in: .whitespaces))
            return .rateLimited(retryAfterSeconds: after.map { min(max($0, 0), 86_400) })
        default:
            return .rejected(status: http.statusCode, code: clean(json?["error"], pattern: #"^[a-z0-9_]{1,40}$"#, token: token))
        }
    }

    /// A string from the relay's body is passed on only when it looks like an id or an error code, and is not the token.
    private static func clean(_ value: Any?, pattern: String, token: ShareToken) -> String? {
        guard let s = value as? String, s.range(of: pattern, options: .regularExpression) != nil,
            !s.contains("talos_share_"), !s.contains(token.secret)
        else { return nil }
        return s
    }
}

/// The default session: ephemeral, no cookies, no cache, no credentials stored, and it never follows a redirect (the
/// `Authorization` header must not travel anywhere but the compiled relay host).
public final class ShareURLSession: NSObject, URLSessionProtocol, URLSessionTaskDelegate, @unchecked Sendable {
    private let session: URLSession

    public override init() {
        session = URLSession(configuration: Self.makeConfiguration())
        super.init()
    }

    deinit { session.finishTasksAndInvalidate() }

    public static func makeConfiguration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.urlCredentialStorage = nil
        c.waitsForConnectivity = false
        c.timeoutIntervalForRequest = 60
        c.timeoutIntervalForResource = 300
        c.tlsMinimumSupportedProtocolVersion = .TLSv12
        return c
    }

    public func upload(for request: URLRequest, fromFile fileURL: URL) async throws -> (Data, URLResponse) {
        try await session.upload(for: request, fromFile: fileURL, delegate: self)
    }

    public func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
