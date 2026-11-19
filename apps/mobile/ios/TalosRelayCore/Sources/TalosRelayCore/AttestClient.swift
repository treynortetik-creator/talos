import Foundation
import Security

/// What the network did with one attest request. The transport never decides what an answer means.
public enum AttestTransportResult: Equatable, Sendable {
    /// Any HTTP answer. `body` is cut off at `AttestClient.bodyCap` + 1 by the real transport (`tooLarge` instead when it was longer).
    case response(status: Int, retryAfter: String?, body: Data)
    /// The answer was longer than the cap (the status it came with is kept: a 200 that is too big is a bad answer, not a silent relay).
    case tooLarge(status: Int)
    /// A timeout, a refused or dropped connection, a bad certificate, a redirect: nothing usable came back.
    case failed
}

/// Posts one request. The real one (App/Relay) is a native ephemeral URLSession: https only, no cookie jar, no redirects, a capped
/// streaming read. `cookie`, when not nil, is sent as the `Cookie` header and nothing else is.
public protocol AttestTransport: Sendable {
    func post(url: URL, body: Data, cookie: String?, timeout: TimeInterval) async -> AttestTransportResult
}

/// Why no check could be made. These are the relay's unsigned words (or none), so none of them is a pass and none is a fail.
public enum AttestUnreachable: String, Sendable, Equatable {
    case network
    case macOffline = "mac_offline"
    case unsupported = "attest_unsupported"
    case macTimeout = "attest_timeout"
    case rateLimited = "rate_limited"
    case badAnswer = "bad_answer"
}

public enum AttestOutcome: Sendable, Equatable {
    case verdict(BridgeAttest.Verdict)
    case unreachable(AttestUnreachable)
}

/// The phone's side of `POST /api/bridge/attest` (docs/specs/BYOR-phase4-frame.md sections 3 and 4): a fresh 32-byte nonce for each
/// attempt, a 10 s total timeout, one retry of a 429 inside it, an 8 KB cap, and the answer handed to `BridgeAttest.check`.
/// Native only, never page JavaScript.
public struct AttestClient: Sendable {
    public static let totalSeconds: TimeInterval = 10
    public static let bodyCap = BridgeAttest.bodyMax
    /// The relay's session cookie (apps/relay/src/auth/util.ts): the only cookie this client will ever send.
    public static let sessionCookieName = "__Host-talos_s"

    let transport: AttestTransport
    let nonce: @Sendable () -> String
    /// A clock that only moves forward (seconds), for the 10 s budget: a change of the wall clock cannot stretch or cut it.
    let monotonic: @Sendable () -> TimeInterval
    let sleep: @Sendable (TimeInterval) async -> Void

    public init(
        transport: AttestTransport,
        nonce: @escaping @Sendable () -> String = { AttestClient.randomNonce() },
        monotonic: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64(max(0, $0) * 1_000_000_000)) }
    ) {
        self.transport = transport
        self.nonce = nonce
        self.monotonic = monotonic
        self.sleep = sleep
    }

    /// 32 bytes from the system's random source, as 43 base64url characters. One per attempt, never stored.
    public static func randomNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "no random bytes")
        return BridgeAttest.encode(Data(bytes))
    }

    /// `name=value` for the Cookie header, or nil: only the relay's session cookie, and only a value that cannot break the header
    /// (visible ASCII, no `;` `,` `"` `\`, at most 4096 bytes).
    public static func cookieHeader(name: String, value: String) -> String? {
        guard name == sessionCookieName, !value.isEmpty, value.utf8.count <= 4096,
              value.utf8.allSatisfy({ (0x21...0x7E).contains($0) && $0 != 0x3B && $0 != 0x2C && $0 != 0x22 && $0 != 0x5C })
        else { return nil }
        return "\(name)=\(value)"
    }

    /// One check. `cookie` is dropped at pairing (`context == .pair`), whatever the caller passes.
    public func attest(
        origin: URL, relayID: String, pinnedFP: String, cookie: String?, context: BridgeAttest.Context
    ) async -> AttestOutcome {
        guard origin.scheme == "https", let host = origin.host, !host.isEmpty,
              let url = URL(string: "/api/bridge/attest", relativeTo: origin)?.absoluteURL
        else { return .unreachable(.badAnswer) }
        let originText = RelayProfile.originText(of: origin)
        let sendCookie = context == .reconnect ? cookie : nil
        let started = monotonic()
        var retried = false
        while true {
            let left = Self.totalSeconds - (monotonic() - started)
            if left <= 0 { return .unreachable(.network) }
            let n = nonce()
            let body = Data("{\"nonce\":\"\(n)\"}".utf8)
            let result = await transport.post(url: url, body: body, cookie: sendCookie, timeout: left)
            switch result {
            case .failed: return .unreachable(.network)
            case let .tooLarge(status): return status == 200 ? .verdict(.fail(.badShape)) : .unreachable(.badAnswer)
            case let .response(status, retryAfter, data):
                // A 200 goes to the check whatever its size (the check's first step refuses more than 8 KB: a fail). Another status is
                // only a relay that is not answering, whatever it sends.
                if status != 200, data.count > Self.bodyCap { return .unreachable(.badAnswer) }
                switch status {
                case 200:
                    return .verdict(BridgeAttest.check(
                        body: data, nonce: n, origin: originText, relayID: relayID, pinnedFP: pinnedFP, context: context))
                case 429:
                    // One retry, only when the relay's own wait fits what is left of the 10 s with a second to spare.
                    guard !retried, let wait = Self.seconds(retryAfter),
                          wait + 1 <= Self.totalSeconds - (monotonic() - started) else { return .unreachable(.rateLimited) }
                    retried = true
                    await sleep(wait)
                case 503: return .unreachable(Self.word(in: data) ?? .badAnswer)
                case 504: return .unreachable(.macTimeout)
                default: return .unreachable(.badAnswer)
                }
            }
        }
    }

    /// A whole number of seconds from 1 up (a date, a fraction, a blank or a negative is not waited for).
    private static func seconds(_ header: String?) -> TimeInterval? {
        guard let header, let n = Int(header.trimmingCharacters(in: .whitespaces)), n >= 1 else { return nil }
        return TimeInterval(n)
    }

    private static func word(in body: Data) -> AttestUnreachable? {
        guard let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let e = obj["error"] as? String else { return nil }
        switch e {
        case "mac_offline": return .macOffline
        case "attest_unsupported": return .unsupported
        default: return nil
        }
    }
}
