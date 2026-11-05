import Foundation
import Security
import TalosShareCore

/// The share token in the Keychain access group shared by the app and the share extension (free tier: Keychain sharing
/// needs no paid capability). The group string is `$(AppIdentifierPrefix)app.talos.shared`, resolved at build time into
/// each target's Info.plist (`TalosKeychainGroup`) and entitlements, so no Team ID is ever committed.
///
/// One item, replaced on every `save`, never in backups (ThisDeviceOnly: the token is bound to this device). The secret is never logged and `load()` returns `ShareToken`, which has no
/// accessor for it.
enum KeychainTokenStore {
    enum Failure: Error { case noGroup, keychain(OSStatus) }

    private static let service = "app.talos.share"
    private static let account = "token"

    static func group(in bundle: Bundle = .main) -> String? {
        let g = bundle.object(forInfoDictionaryKey: "TalosKeychainGroup") as? String
        return (g?.isEmpty == false) ? g : nil
    }

    private static func query(_ group: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account, kSecAttrAccessGroup: group]
    }

    static func save(_ data: Data) throws {
        guard let group = group() else { throw Failure.noGroup }
        try clear()
        var item = query(group)
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }

    static func clear() throws {
        guard let group = group() else { throw Failure.noGroup }
        let status = SecItemDelete(query(group) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.keychain(status) }
    }

    static func load() -> ShareToken? {
        guard let group = group() else { return nil }
        var q = query(group)
        q[kSecReturnData] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return StoredShareToken.decode(data)
    }
}
