import Foundation

public enum RelayKind: String, Codable, Equatable {
    case hosted
    case `self`
}

/// One paired relay (docs/specs/BYOR.md section 4). `id` is the relay_id from the descriptor.
public struct RelayProfile: Codable, Equatable {
    public let id: String
    public var origin: URL
    public var kind: RelayKind
    public var label: String
    public var bridgeFp: String
    public var deviceId: String
    public var dataStoreId: UUID
    public var pushHandle: String?
    public var stepUpKeyRef: String?
    public var addedAt: Date
    /// When an attest last passed for THIS pairing (saved on the profile, so it is named by `keyId` and never by the relay's own id).
    /// nil when none ever did (a profile from before phase 4b).
    public var lastVerifiedAt: Date?
    /// True while the last check of this pairing answered with the wrong key or a bad answer (the app's red screen). Cleared by the next
    /// pass. Kept here, with `lastVerifiedAt`, because a notification button (a separate wake of the app, no web view) reads both.
    public var attestFailed: Bool

    /// What names this pairing's notification keys and grant in the Keychain. The phone minted it when it scanned the code
    /// (`dataStoreId`), so a relay cannot choose it: `id` comes from the relay's public descriptor, and a relay can claim another's.
    /// A new scan always gets a new one, so a new pairing never reads an earlier pairing's keys.
    public var keyId: String { dataStoreId.uuidString }

    enum CodingKeys: String, CodingKey {
        case id, origin, kind, label
        case bridgeFp = "bridge_fp"
        case deviceId = "device_id"
        case dataStoreId = "data_store_id"
        case pushHandle = "push_handle"
        case stepUpKeyRef = "step_up_key_ref"
        case addedAt = "added_at"
        case lastVerifiedAt = "last_verified_at"
        case attestFailed = "attest_failed"
    }

    /// Fails (nil) when `id` is not a valid relay id.
    public init?(
        id: String, origin: URL, kind: RelayKind, label: String, bridgeFp: String, deviceId: String,
        dataStoreId: UUID, pushHandle: String? = nil, stepUpKeyRef: String? = nil, addedAt: Date, lastVerifiedAt: Date? = nil,
        attestFailed: Bool = false
    ) {
        guard RelayID.isValid(id) else { return nil }
        self.id = id
        self.origin = origin
        self.kind = kind
        self.label = label
        self.bridgeFp = bridgeFp
        self.deviceId = deviceId
        self.dataStoreId = dataStoreId
        self.pushHandle = pushHandle
        self.stepUpKeyRef = stepUpKeyRef
        self.addedAt = addedAt
        self.lastVerifiedAt = lastVerifiedAt
        self.attestFailed = attestFailed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        guard RelayID.isValid(id) else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "not a relay id")
        }
        self.id = id
        origin = try c.decode(URL.self, forKey: .origin)
        kind = try c.decode(RelayKind.self, forKey: .kind)
        label = try c.decode(String.self, forKey: .label)
        bridgeFp = try c.decode(String.self, forKey: .bridgeFp)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        dataStoreId = try c.decode(UUID.self, forKey: .dataStoreId)
        pushHandle = try c.decodeIfPresent(String.self, forKey: .pushHandle)
        stepUpKeyRef = try c.decodeIfPresent(String.self, forKey: .stepUpKeyRef)
        addedAt = try c.decode(Date.self, forKey: .addedAt)
        lastVerifiedAt = try c.decodeIfPresent(Date.self, forKey: .lastVerifiedAt)
        attestFailed = try c.decodeIfPresent(Bool.self, forKey: .attestFailed) ?? false
    }

    /// The text the bridge signs as the origin: `https://<host>[:<port>]`, host in lower case, no slash, no default port.
    public static func originText(of url: URL) -> String {
        let host = (url.host ?? "").lowercased()
        let scheme = (url.scheme ?? "https").lowercased()
        let defaultPort = scheme == "https" ? 443 : 80
        if let port = url.port, port != defaultPort { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }

    public var originText: String { Self.originText(of: origin) }

    /// 24 hours from the last verified attest: the app blocks past it (BridgeGuard's `RelayTrust.hardBlockAfter` is the same number).
    public static let trustWindow: TimeInterval = 24 * 3600

    /// Whether a notification button may sign and send for this pairing: it was verified less than 24 hours ago (a time in the future or
    /// none at all is expired) and its last check did not fail. Unverified inside the window is allowed, as the readable page is.
    public func allowsQuickAct(now: Date) -> Bool {
        guard !attestFailed, let verified = lastVerifiedAt else { return false }
        let age = now.timeIntervalSince(verified)
        return age >= 0 && age < Self.trustWindow
    }
}
