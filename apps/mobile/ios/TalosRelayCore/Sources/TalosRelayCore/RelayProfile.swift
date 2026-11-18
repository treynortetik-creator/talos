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
    }

    /// Fails (nil) when `id` is not a valid relay id.
    public init?(
        id: String, origin: URL, kind: RelayKind, label: String, bridgeFp: String, deviceId: String,
        dataStoreId: UUID, pushHandle: String? = nil, stepUpKeyRef: String? = nil, addedAt: Date
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
    }
}
