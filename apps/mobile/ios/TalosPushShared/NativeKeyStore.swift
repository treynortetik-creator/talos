import CryptoKit
import Foundation
import Security
import TalosPushCore
import TalosRelayCore

/// The notification keys, in the Keychain access group the app and the notification extension share (free tier: Keychain
/// sharing needs no paid capability; the group is `$(AppIdentifierPrefix)app.talos.shared`, resolved at build time into
/// Info.plist, so no Team ID is committed). Three items PER PAIRING: the account name ends in the profile's `keyId`, the id the
/// phone minted when it scanned the relay's code, NOT the relay's own id (a relay can claim another relay's id). So two relays never
/// share a key or a grant, and scanning a relay again always starts with new keys (BYOR.md 3.1, "device keys never mix"). All items
/// are `ThisDeviceOnly` and readable after the first unlock (the extension runs while the phone is locked): the encryption key
/// (the notification extension, the app and the share extension, which lists the same Keychain
/// group in its entitlements, can read it; the relay seals to its public half), the action key (signs Reply and Approve) and the grant the page got the device key to sign.
/// A private key never leaves the Keychain except as bytes in this process, and nothing here is ever logged.
enum NativeKeyStore {
    enum Failure: Error { case noGroup, badKeyId, keychain(OSStatus) }
    private static let service = "app.talos.push"

    static func group(in bundle: Bundle = .main) -> String? {
        let g = bundle.object(forInfoDictionaryKey: "TalosKeychainGroup") as? String
        return (g?.isEmpty == false) ? g : nil
    }

    /// Only the canonical form of a UUID (what `RelayProfile.keyId` produces) names an item.
    static func isValid(keyId: String) -> Bool { UUID(uuidString: keyId)?.uuidString == keyId }

    private static func query(_ account: String, _ group: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account, kSecAttrAccessGroup: group]
    }

    private static func readAccount(_ account: String) -> Data? {
        guard let group = group() else { return nil }
        var q = query(account, group)
        q[kSecReturnData] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    private static func writeAccount(_ account: String, _ data: Data) throws {
        guard let group = group() else { throw Failure.noGroup }
        SecItemDelete(query(account, group) as CFDictionary)
        var item = query(account, group)
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }

    /// False when the item could not be deleted (an item that is not there is fine).
    private static func deleteAccount(_ account: String) -> Bool {
        guard let group = group() else { return false }
        let status = SecItemDelete(query(account, group) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private static func read(_ kind: String, _ keyId: String) -> Data? {
        isValid(keyId: keyId) ? readAccount(PushCore.keychainAccount(kind, keyId: keyId)) : nil
    }

    private static func write(_ kind: String, _ keyId: String, _ data: Data) throws {
        guard isValid(keyId: keyId) else { throw Failure.badKeyId }
        try writeAccount(PushCore.keychainAccount(kind, keyId: keyId), data)
    }

    static func encKey(keyId: String) -> P256.KeyAgreement.PrivateKey? {
        read("enc", keyId).flatMap { try? P256.KeyAgreement.PrivateKey(rawRepresentation: $0) }
    }

    static func actKey(keyId: String) -> P256.Signing.PrivateKey? {
        read("act", keyId).flatMap { try? P256.Signing.PrivateKey(rawRepresentation: $0) }
    }

    static func grant(keyId: String) -> String? {
        read("grant", keyId).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// Makes the pairing's two key pairs the first time and returns their public halves (uncompressed points, base64url) every time.
    static func ensureKeys(keyId: String) throws -> (encPub: String, actPub: String) {
        let enc = encKey(keyId: keyId) ?? P256.KeyAgreement.PrivateKey()
        let act = actKey(keyId: keyId) ?? P256.Signing.PrivateKey()
        if encKey(keyId: keyId) == nil { try write("enc", keyId, enc.rawRepresentation) }
        if actKey(keyId: keyId) == nil { try write("act", keyId, act.rawRepresentation) }
        return (Base64URL.encode(enc.publicKey.x963Representation), Base64URL.encode(act.publicKey.x963Representation))
    }

    /// Keeps the grant only if it names THIS pairing's keys, so a stale or foreign grant can never make the phone sign for another key.
    static func saveGrant(_ json: String, keyId: String) throws -> Bool {
        let keys = try ensureKeys(keyId: keyId)
        guard RichPush.grantNamesKeys(json, encPub: keys.encPub, actPub: keys.actPub) else { return false }
        try write("grant", keyId, Data(json.utf8))
        return true
    }

    /// Turn off, sign out, a removed relay: that pairing's grant and both private keys are gone, and no other pairing's are touched.
    /// A new Turn on makes new keys. Every item is tried; false when one could not be deleted (it stays listed by `keyIdsWithKeys`,
    /// so the next launch's sweep tries again).
    @discardableResult
    static func clearAll(keyId: String) -> Bool {
        guard isValid(keyId: keyId) else { return false }
        var ok = true
        PushCore.deleteNotificationSecrets(keyId: keyId) { if !deleteAccount($0) { ok = false } }
        return ok
    }

    // MARK: which pairings hold keys

    /// The key ids that have an item here (read from the account names), so the keys of a relay that is gone can be found.
    static func keyIdsWithKeys() -> [String] {
        guard let group = group() else { return [] }
        var q = query("", group)
        q.removeValue(forKey: kSecAttrAccount)
        q[kSecReturnAttributes] = true
        q[kSecMatchLimit] = kSecMatchLimitAll
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let rows = out as? [[String: Any]] else { return [] }
        var ids = Set<String>()
        for row in rows {
            guard let account = row[kSecAttrAccount as String] as? String, let dot = account.firstIndex(of: ".") else { continue }
            let id = String(account[account.index(after: dot)...])
            if PushCore.keychainAccounts.contains(String(account[..<dot])), isValid(keyId: id) { ids.insert(id) }
        }
        return ids.sorted()
    }

    /// Deletes the keys of every pairing that is not in `kept` (a removed or replaced relay). A deletion that fails leaves the
    /// pairing listed, so the next sweep tries again.
    static func removeKeys(exceptKeyIds kept: Set<String>) {
        for id in keyIdsWithKeys() where !kept.contains(id) { clearAll(keyId: id) }
    }

    // MARK: the old single-relay items

    /// Keys made before each relay had its own may be known to a relay the owner has left, so they are never used: they are only
    /// deleted. The cost is one fresh "Show message text" per relay.
    static func hasLegacyKeys() -> Bool { PushCore.keychainAccounts.contains { readAccount($0) != nil } }

    static func clearLegacy() {
        PushCore.deleteLegacyNotificationSecrets { _ = deleteAccount($0) }
    }

    // MARK: what the notification extension and the quick actions read

    /// The relay list, in the same shared group the app saves it to.
    static func relayStore() -> RelayStore? {
        group().map { RelayStore(backing: SystemKeychain(accessGroup: $0)) }
    }

    /// The key id of the pairing the app is on now (nil when nothing is paired or the list cannot be read).
    static func activeKeyId(store: RelayStore?) -> String? {
        guard let store, let profile = try? store.active() else { return nil }
        return profile.keyId
    }

    /// Every stored pairing's seal key with that pairing's device id (taken from its grant), the active one first. A pairing with no
    /// key or no readable grant is left out, so its pushes stay closed.
    static func sealCandidates(store: RelayStore?) -> [RichPush.SealCandidate] {
        guard let store, let profiles = try? store.list() else { return [] }
        let active = (try? store.activeId()) ?? nil
        return profiles.sorted { ($0.id == active ? 0 : 1) < ($1.id == active ? 0 : 1) }.compactMap { p in
            guard let key = encKey(keyId: p.keyId), let json = grant(keyId: p.keyId), let info = RichPush.grantInfo(json) else { return nil }
            return RichPush.SealCandidate(keyId: p.keyId, key: key, deviceId: info.deviceId)
        }
    }
}
