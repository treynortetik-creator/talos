import CryptoKit
import Foundation
import Security

/// One generic password the app keeps for itself (the launch seal's key, the screen helper's allowed-list record): this device only, never
/// synced, read and written with no UI. User interaction is switched off around every call, so a call the Keychain would ask about FAILS (and
/// the caller fails closed) instead of putting a prompt on the owner's screen. Only the item named by `service` and `account` is touched.
public struct KeychainItem: @unchecked Sendable {
  public let service: String
  public let account: String
  private let keychain: SecKeychain?
  /// The one keychain this item is limited to (nil: the owner's search list), for a sibling item in the same place.
  var keychainForScope: SecKeychain? { keychain }

  public init(service: String, account: String, keychain: SecKeychain? = nil) {
    self.service = service
    self.account = account
    self.keychain = keychain
  }

  private func base() -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
    ]
    if let keychain { q[kSecMatchSearchList as String] = [keychain] }
    return q
  }

  /// Runs `body` with Keychain prompts switched off for this process, and puts the setting back when the LAST such call ends. The
  /// setting is process-wide: two calls at once (the launch seal and the screen list, or two tests) each saving and restoring it
  /// would let one turn prompts back on while the other is inside a read, and a read the Keychain asks about then waits on a dialog
  /// instead of failing (seen 2026-11-14: a test hung on it). So the calls are counted, and only the first saves and the last restores.
  private func quietly<T>(_ body: () -> T) -> T {
    KeychainQuiet.enter()
    defer { KeychainQuiet.leave() }
    return body()
  }

  /// The item's data and the status (`errSecItemNotFound` when there is none).
  public func read() -> (Data?, OSStatus) {
    quietly {
      var q = base()
      q[kSecReturnData as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitOne
      var out: CFTypeRef?
      let s = SecItemCopyMatching(q as CFDictionary, &out)
      return (s == errSecSuccess ? out as? Data : nil, s)
    }
  }

  public func add(_ data: Data) -> OSStatus {
    quietly {
      var add = base()
      if let keychain {
        add[kSecMatchSearchList as String] = nil
        add[kSecUseKeychain as String] = keychain
      }
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      return SecItemAdd(add as CFDictionary, nil)
    }
  }

  public func update(_ data: Data) -> OSStatus {
    quietly { SecItemUpdate(base() as CFDictionary, [kSecValueData as String: data] as CFDictionary) }
  }

  public func delete() -> OSStatus { quietly { SecItemDelete(base() as CFDictionary) } }
}

/// The process-wide count behind `KeychainItem.quietly`.
enum KeychainQuiet {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var depth = 0
  nonisolated(unsafe) private static var prior = true

  static func enter() {
    lock.withLock {
      if depth == 0 {
        var p = DarwinBoolean(true)
        SecKeychainGetUserInteractionAllowed(&p)
        prior = p.boolValue
        SecKeychainSetUserInteractionAllowed(false)
      }
      depth += 1
    }
  }

  static func leave() {
    lock.withLock {
      depth -= 1
      if depth == 0 { SecKeychainSetUserInteractionAllowed(prior) }
    }
  }

  /// For tests: whether prompts are off now.
  static var promptsOff: Bool {
    var p = DarwinBoolean(true)
    SecKeychainGetUserInteractionAllowed(&p)
    return !p.boolValue
  }
}

/// Who signed the running app, as a short stable id: the first 16 hex characters of the SHA-256 of its designated requirement. nil for
/// an ad hoc or unsigned build, whose requirement is its own code hash and changes with every build.
public enum SignerKey {
  public static func current() -> String? {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var req: SecRequirement?
    guard SecCodeCopyDesignatedRequirement(staticCode, [], &req) == errSecSuccess, let req else { return nil }
    var text: CFString?
    guard SecRequirementCopyString(req, [], &text) == errSecSuccess, let t = text as String? else { return nil }
    return key(requirement: t)
  }

  /// The id of a designated requirement's text; nil for an ad hoc one (`cdhash H"..."`).
  public static func key(requirement t: String) -> String? {
    if t.contains("cdhash H\"") || t.isEmpty { return nil }
    return SHA256.hash(data: Data(t.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
  }
}

/// One record kept per signer when it has to be. The Keychain lets an item be read with no prompt only by the signer that made it, so
/// after the app's signer changes (a local build, then the notarized one) the new app cannot read the old item, and must not replace it
/// (it cannot, and it would not know the item is stale). Then the record lives in a second item, `<account>.signer-<SignerKey>`, made by
/// and readable to this signer; the old signer's item is left alone, so going back to that signer still finds it.
/// An item that is simply missing is made under the plain account, as before. An ad hoc build (no signer key) gets no second item: it
/// fails closed, as before.
public struct SignerScopedItem: @unchecked Sendable {
  public let primary: KeychainItem
  public let signer: String?

  public init(service: String, account: String, keychain: SecKeychain? = nil, signer: String? = SignerKey.current()) {
    primary = KeychainItem(service: service, account: account, keychain: keychain)
    self.signer = signer
  }

  /// The item this signer reads and writes, with its data and the status of that read. The plain item when it can be read or is
  /// missing; this signer's own item when the plain one exists and cannot be read (and there is a signer key); else the plain one with
  /// the failed status.
  public func resolve() -> (item: KeychainItem, data: Data?, status: OSStatus) {
    let (d, s) = primary.read()
    if s == errSecSuccess || s == errSecItemNotFound { return (primary, d, s) }
    guard let signer else { return (primary, nil, s) }
    let own = KeychainItem(service: primary.service, account: primary.account + ".signer-" + signer, keychain: primary.keychainForScope)
    let (d2, s2) = own.read()
    return (own, d2, s2)
  }

  /// The 32 bytes of a key kept here, made (in the item `resolve` names) when it is missing and `create` is set. nil when there is no key
  /// and none may be made, or the Keychain cannot be used.
  public func key(create: Bool) -> Data? {
    let (item, d, s) = resolve()
    if s == errSecSuccess, let d, d.count == 32 { return d }
    guard create, s == errSecItemNotFound else { return nil }
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    guard item.add(Data(bytes)) == errSecSuccess else { return nil }
    return Data(bytes)
  }
}
