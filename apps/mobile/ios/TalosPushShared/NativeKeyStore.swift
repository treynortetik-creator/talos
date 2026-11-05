import CryptoKit
import Foundation
import Security
import TalosPushCore

/// The notification keys, in the Keychain access group the app and the notification extension share (free tier: Keychain
/// sharing needs no paid capability; the group is `$(AppIdentifierPrefix)app.talos.shared`, resolved at build time into
/// Info.plist, so no Team ID is committed). Three items, all `ThisDeviceOnly` and readable after the first unlock (the
/// extension runs while the phone is locked): the encryption key (the notification extension, the app and the share extension, which lists the same Keychain
/// group in its entitlements, can read it; the relay seals to its public half), the action key (signs Reply and Approve) and the grant the page got the device key to sign.
/// A private key never leaves the Keychain except as bytes in this process, and nothing here is ever logged.
enum NativeKeyStore {
    enum Failure: Error { case noGroup, keychain(OSStatus) }
    private static let service = "app.talos.push"

    static func group(in bundle: Bundle = .main) -> String? {
        let g = bundle.object(forInfoDictionaryKey: "TalosKeychainGroup") as? String
        return (g?.isEmpty == false) ? g : nil
    }

    private static func query(_ account: String, _ group: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account, kSecAttrAccessGroup: group]
    }

    private static func read(_ account: String) -> Data? {
        guard let group = group() else { return nil }
        var q = query(account, group)
        q[kSecReturnData] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    private static func write(_ account: String, _ data: Data) throws {
        guard let group = group() else { throw Failure.noGroup }
        SecItemDelete(query(account, group) as CFDictionary)
        var item = query(account, group)
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }

    static func encKey() -> P256.KeyAgreement.PrivateKey? {
        read("enc").flatMap { try? P256.KeyAgreement.PrivateKey(rawRepresentation: $0) }
    }

    static func actKey() -> P256.Signing.PrivateKey? {
        read("act").flatMap { try? P256.Signing.PrivateKey(rawRepresentation: $0) }
    }

    static func grant() -> String? {
        read("grant").flatMap { String(data: $0, encoding: .utf8) }
    }

    /// Makes the two key pairs the first time and returns their public halves (uncompressed points, base64url) every time.
    static func ensureKeys() throws -> (encPub: String, actPub: String) {
        let enc = encKey() ?? P256.KeyAgreement.PrivateKey()
        let act = actKey() ?? P256.Signing.PrivateKey()
        if encKey() == nil { try write("enc", enc.rawRepresentation) }
        if actKey() == nil { try write("act", act.rawRepresentation) }
        return (Base64URL.encode(enc.publicKey.x963Representation), Base64URL.encode(act.publicKey.x963Representation))
    }

    /// Keeps the grant only if it names THESE keys, so a stale or foreign grant can never make the phone sign for another key.
    static func saveGrant(_ json: String) throws -> Bool {
        let keys = try ensureKeys()
        guard RichPush.grantNamesKeys(json, encPub: keys.encPub, actPub: keys.actPub) else { return false }
        try write("grant", Data(json.utf8))
        return true
    }

    /// Turn off, sign out: the grant and both private keys are gone. A new Turn on makes new keys.
    static func clearAll() {
        guard let group = group() else { return }
        PushCore.deleteNotificationSecrets { SecItemDelete(query($0, group) as CFDictionary) }
    }
}
