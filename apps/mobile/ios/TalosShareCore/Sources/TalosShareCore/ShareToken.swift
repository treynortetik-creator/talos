import Foundation

public enum ShareScope: String, Sendable, Hashable {
    case text
    case files
}

/// A share link's secret and what it may send (the relay's `talos_share_<43>` token and its scopes).
///
/// The secret is held only here and read only by `ShareClient` when it builds the `Authorization` header. It is not
/// in `description`, `debugDescription`, `dump`, or any `ShareResult`. There is no accessor. Where it is stored (the
/// shared Keychain group, WP-I3b) and who may read it is the plugin's job: this package never touches the Keychain.
public struct ShareToken: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let secret: String
    public let scopes: Set<ShareScope>

    /// `nil` unless the secret has exactly the relay's shape (packages/protocol `SHARE_SECRET_RE`) and the token
    /// can send something. The shape check also keeps CR, LF and spaces out of the header.
    public init?(secret: String, scopes: Set<ShareScope>) {
        guard !scopes.isEmpty, Self.hasRelayShape(secret) else { return nil }
        self.secret = secret
        self.scopes = scopes
    }

    private static let prefix = Array("talos_share_".utf8)
    private static func hasRelayShape(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard b.count == prefix.count + 43, b.starts(with: prefix) else { return false }
        return b.dropFirst(prefix.count).allSatisfy {
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x5f || $0 == 0x2d
        }
    }

    public var description: String { "ShareToken(scopes: \(scopes.map(\.rawValue).sorted()), secret: <redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [("scopes", scopes.map(\.rawValue).sorted())]) }
}
