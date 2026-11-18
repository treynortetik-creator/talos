import Foundation

public enum DescriptorCheck: Equatable {
    case ok
    /// The relay wants a newer app. Advisory only: show `note`, never block.
    case updateAdvised(minApp: String)

    public var note: String? {
        if case let .updateAdvised(minApp) = self { return "This relay asks for Talos \(minApp) or newer. Please update the app." }
        return nil
    }
}

/// What `GET /.well-known/talos-relay` returns. It is NEVER used for identity (docs/specs/BYOR.md section 10 (a)): the
/// relay is untrusted for that, and identity is the bridge key fingerprint pinned from the setup link. `min_app` is
/// advisory only (section 10 (c)).
public struct RelayDescriptor: Decodable, Equatable {
    public let `protocol`: Int
    public let relayVersion: String
    public let relayId: String
    public let kind: RelayKind
    public let minApp: String

    enum CodingKeys: String, CodingKey {
        case `protocol`
        case relayVersion = "relay_version"
        case relayId = "relay_id"
        case kind
        case minApp = "min_app"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        `protocol` = try c.decode(Int.self, forKey: .protocol)
        relayVersion = try c.decode(String.self, forKey: .relayVersion)
        let id = try c.decode(String.self, forKey: .relayId)
        guard RelayID.isValid(id) else {
            throw DecodingError.dataCorruptedError(forKey: .relayId, in: c, debugDescription: "not a relay id")
        }
        relayId = id
        kind = try c.decode(RelayKind.self, forKey: .kind)
        minApp = try c.decode(String.self, forKey: .minApp)
    }

    /// Never blocks. An unreadable `min_app` reads as no advice.
    public func check(appVersion: String) -> DescriptorCheck {
        guard let need = Self.numbers(minApp), let have = Self.numbers(appVersion) else { return .ok }
        for i in 0..<max(need.count, have.count) {
            let n = i < need.count ? need[i] : 0
            let h = i < have.count ? have[i] : 0
            if h != n { return h < n ? .updateAdvised(minApp: minApp) : .ok }
        }
        return .ok
    }

    private static func numbers(_ v: String) -> [Int]? {
        let parts = v.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        return parts.contains(where: { $0 == nil }) ? nil : parts.compactMap { $0 }
    }
}
