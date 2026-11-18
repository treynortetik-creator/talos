import Foundation
import Security

/// Where the one stored blob lives.
public protocol KeychainBacking {
    func read() throws -> Data?
    func write(_ data: Data) throws
    func delete() throws
}

public final class InMemoryKeychain: KeychainBacking {
    private var data: Data?
    public init() {}
    public func read() throws -> Data? { data }
    public func write(_ data: Data) throws { self.data = data }
    public func delete() throws { data = nil }
}

public struct KeychainError: Error, Equatable { public let status: OSStatus }

/// One generic-password item (service "talos.relays") holding the whole list and the active id. Readable after the first
/// unlock and never leaves this device. Pass `accessGroup` (the shared `<team>.app.talos.shared` group, already in the
/// app's and both extensions' keychain-access-groups) when an extension must read the profile while the phone is locked.
public struct SystemKeychain: KeychainBacking {
    public static let service = "talos.relays"
    private let account = "relay-list"
    private let accessGroup: String?
    public init(accessGroup: String? = nil) { self.accessGroup = accessGroup }

    private var query: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func read() throws -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let s = SecItemCopyMatching(q as CFDictionary, &out)
        if s == errSecItemNotFound { return nil }
        guard s == errSecSuccess else { throw KeychainError(status: s) }
        return out as? Data
    }

    public func write(_ data: Data) throws {
        let s = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if s == errSecSuccess { return }
        guard s == errSecItemNotFound else { throw KeychainError(status: s) }
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let a = SecItemAdd(q as CFDictionary, nil)
        guard a == errSecSuccess else { throw KeychainError(status: a) }
    }

    public func delete() throws {
        let s = SecItemDelete(query as CFDictionary)
        guard s == errSecSuccess || s == errSecItemNotFound else { throw KeychainError(status: s) }
    }
}

/// The relay list. Phase 3 holds ONE relay: `add` replaces the existing one and makes it active. Phase 4 lifts that to many
/// (the stored shape is already a list). A damaged blob throws; it never reads as an empty list.
public final class RelayStore {
    private struct Blob: Codable {
        var relays: [RelayProfile]
        var active: String?
    }

    private let backing: KeychainBacking
    public init(backing: KeychainBacking) { self.backing = backing }

    private static var encoder: JSONEncoder { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }
    private static var decoder: JSONDecoder { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }

    private func load() throws -> Blob {
        guard let data = try backing.read() else { return Blob(relays: [], active: nil) }
        return try Self.decoder.decode(Blob.self, from: data)
    }

    private func save(_ b: Blob) throws { try backing.write(try Self.encoder.encode(b)) }

    public func list() throws -> [RelayProfile] { try load().relays }
    public func activeId() throws -> String? { try load().active }
    public func active() throws -> RelayProfile? {
        let b = try load()
        return b.relays.first { $0.id == b.active }
    }

    public func add(_ profile: RelayProfile) throws {
        try save(Blob(relays: [profile], active: profile.id))
    }

    /// Deletes the stored item outright, so a damaged one (which makes every other call throw) can be cleared.
    public func reset() throws { try backing.delete() }

    public func remove(id: String) throws {
        var b = try load()
        b.relays.removeAll { $0.id == id }
        if b.active == id { b.active = b.relays.first?.id }
        if b.relays.isEmpty { try backing.delete() } else { try save(b) }
    }

    /// Returns false (and changes nothing) when `id` is not in the list.
    @discardableResult
    public func setActive(_ id: String) throws -> Bool {
        var b = try load()
        guard b.relays.contains(where: { $0.id == id }) else { return false }
        b.active = id
        try save(b)
        return true
    }
}
