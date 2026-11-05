import Foundation

/// How a share token travels between the app (which stores it) and the share extension (which reads it), through one
/// Keychain item. Foundation only: the Keychain calls live in the app's shared source folder, this is the part that can be
/// tested on the Mac. Everything is validated on the way in and on the way out; anything off yields nil, never a partial token.
public enum StoredShareToken {
    private struct Wire: Codable {
        var v: Int
        var secret: String
        var scopes: [String]
    }

    /// The bytes to store. nil when the secret is not the relay's shape, a scope is unknown, or no scope is given.
    /// `text` is always implied: a token that may send files may send text.
    public static func encode(secret: String, scopes: [String]) -> Data? {
        guard let scopeSet = parse(scopes), ShareToken(secret: secret, scopes: scopeSet) != nil else { return nil }
        return try? JSONEncoder().encode(Wire(v: 1, secret: secret, scopes: scopeSet.map(\.rawValue).sorted()))
    }

    /// nil for anything that is not exactly what `encode` writes.
    public static func decode(_ data: Data) -> ShareToken? {
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data), wire.v == 1,
            let scopes = parse(wire.scopes)
        else { return nil }
        return ShareToken(secret: wire.secret, scopes: scopes)
    }

    static func parse(_ raw: [String]) -> Set<ShareScope>? {
        guard !raw.isEmpty, raw.count <= 2 else { return nil }
        var out = Set<ShareScope>()
        for s in raw {
            guard let scope = ShareScope(rawValue: s) else { return nil }
            out.insert(scope)
        }
        if out.contains(.files) { out.insert(.text) }
        return out
    }
}
