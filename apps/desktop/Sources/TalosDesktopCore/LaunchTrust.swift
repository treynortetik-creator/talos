import CryptoKit
import Foundation
import Security

/// A seal on `confirmed_launch` (DESKTOP-SPEC 4.4; docs/desktop.md "The development-channels warning"). `desktop.json` can be written by any
/// program running as the owner, the agent included, so a fingerprint stored there stops accidents, not a determined agent. The seal is an
/// HMAC-SHA256 over the fingerprint (and the per-piece description stored beside it) with a 32-byte key that is created on the owner's first
/// confirm and lives in the Keychain, where an agent writing files cannot read it. `desktop.json` keeps the fingerprint and its MAC; the guard
/// trusts the fingerprint only while the MAC verifies. Fail closed: no key, no MAC, a MAC that does not verify, or a Keychain that cannot be
/// read all read as "this launch is not the confirmed one", which puts the warning on a card the owner taps once.
public protocol LaunchTrust: Sendable {
  /// The MAC of `message`. With `createKey` (the owner's own confirm) a missing key is made first; without it a missing key gives nil.
  /// nil also when the key store cannot be used.
  func mac(_ message: String, createKey: Bool) -> String?
  /// Whether `mac` is the MAC of `message` under the stored key. False for a missing or unreadable key, a malformed MAC and a wrong one.
  func verify(_ message: String, mac: String) -> Bool
}

public enum LaunchSeal {
  /// The owner's confirm of `fingerprint`: stores it with its parts and the MAC (making the key on the first one). False when no MAC could be
  /// made (the Keychain cannot be used): the fingerprint is stored anyway, unsealed, so the guard does not trust it and the next start asks again.
  @discardableResult
  public static func confirm(_ c: inout DesktopConfig, fingerprint: String, parts: [String: String], trust: LaunchTrust) -> Bool {
    c.confirmedLaunch = fingerprint
    c.confirmedLaunchParts = parts.isEmpty ? nil : parts
    c.confirmedLaunchMac = trust.mac(message(fingerprint: fingerprint, parts: c.confirmedLaunchParts), createKey: true)
    return c.confirmedLaunchMac != nil
  }

  /// Whether `c` holds a confirmed launch equal to `fingerprint`, described by these same `parts`, whose seal verifies. The one place the guard's
  /// "not changed" is decided.
  public static func isConfirmed(_ c: DesktopConfig, fingerprint: String, parts: [String: String], trust: LaunchTrust) -> Bool {
    guard let stored = c.confirmedLaunch, stored == fingerprint, let mac = c.confirmedLaunchMac,
      c.confirmedLaunchParts == (parts.isEmpty ? nil : parts)
    else { return false }
    return trust.verify(message(fingerprint: stored, parts: c.confirmedLaunchParts), mac: mac)
  }

  /// What is sealed: the fingerprint and the sorted per-piece hashes next to it. A change to either breaks the MAC.
  public static func message(fingerprint: String, parts: [String: String]?) -> String {
    let rows = (parts ?? [:]).keys.sorted().map { "\($0)=\(parts?[$0] ?? "")" }
    return (["talos-launch-seal/v1", fingerprint] + rows).joined(separator: "\n")
  }

  /// HMAC-SHA256 as lowercase hex.
  static func hmac(_ message: String, key: SymmetricKey) -> String {
    HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key).map { String(format: "%02x", $0) }.joined()
  }

  /// Constant-time check of a hex MAC.
  static func valid(_ mac: String, for message: String, key: SymmetricKey) -> Bool {
    guard mac.utf8.count == 64, mac.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }) else { return false }
    var bytes: [UInt8] = []
    var i = mac.startIndex
    while i < mac.endIndex {
      let j = mac.index(i, offsetBy: 2)
      guard let b = UInt8(mac[i..<j], radix: 16) else { return false }
      bytes.append(b)
      i = j
    }
    return HMAC<SHA256>.isValidAuthenticationCode(Data(bytes), authenticating: Data(message.utf8), using: key)
  }
}

/// The store the default test suite uses: a key in memory, no Keychain. `available: false` plays a Keychain that cannot be read.
public final class MemoryLaunchTrust: LaunchTrust, @unchecked Sendable {
  private let lock = NSLock()
  private var key: SymmetricKey?
  public var available = true

  public init(key: SymmetricKey? = nil) { self.key = key }

  public func mac(_ message: String, createKey: Bool) -> String? {
    lock.withLock {
      guard available else { return nil }
      if key == nil, createKey { key = SymmetricKey(size: .bits256) }
      return key.map { LaunchSeal.hmac(message, key: $0) }
    }
  }

  public func verify(_ message: String, mac: String) -> Bool {
    lock.withLock {
      guard available, let key else { return false }
      return LaunchSeal.valid(mac, for: message, key: key)
    }
  }

  /// A test that plays "the key is gone" (a new Mac, a deleted item).
  public func dropKey() { lock.withLock { key = nil } }
  public var hasKey: Bool { lock.withLock { key != nil } }
}

/// The key in the Keychain: one generic password (`kSecClassGenericPassword`) under a Talos service name, this device only, never synced,
/// read with no UI. User interaction is switched off around every call, so a read the Keychain would ask about FAILS (and fails closed)
/// instead of putting a prompt on the owner's screen. Only the item named by `service` and `account` is ever touched.
///
/// Whether the item survives an update of the app was checked before this was written (apps/desktop/scripts/keychain-survival-probe.sh): an
/// item made by a build signed with the owner's team is read by the next build signed with it, with no prompt. A build that cannot read the
/// existing item (signed another way, ad hoc) never re-seals: it only makes a key when none exists, so every start of that build shows the
/// card. That is fail-closed and the cost is a tap, not a hole.
public final class KeychainLaunchTrust: LaunchTrust, @unchecked Sendable {
  public static let service = "com.talos.app.launch-seal"
  public static let account = "confirmed-launch-v1"
  private let service: String
  private let account: String
  private let lock = NSLock()

  public init(service: String = KeychainLaunchTrust.service, account: String = KeychainLaunchTrust.account) {
    self.service = service
    self.account = account
  }

  private func base() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
    ]
  }

  /// Runs `body` with Keychain prompts switched off for this process, and puts the setting back.
  private func quietly<T>(_ body: () -> T) -> T {
    var prior = DarwinBoolean(true)
    SecKeychainGetUserInteractionAllowed(&prior)
    SecKeychainSetUserInteractionAllowed(false)
    defer { SecKeychainSetUserInteractionAllowed(prior.boolValue) }
    return body()
  }

  /// The 32 key bytes, or nil (missing, locked, not ours to read). A key is made only when the item is missing (`errSecItemNotFound`) and
  /// `create` is set; an item that exists but cannot be read is never replaced.
  private func loadKey(create: Bool) -> SymmetricKey? {
    lock.withLock {
      quietly {
        var q = base()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let s = SecItemCopyMatching(q as CFDictionary, &out)
        if s == errSecSuccess, let d = out as? Data, d.count == 32 { return SymmetricKey(data: d) }
        guard create, s == errSecItemNotFound else { return nil }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        var add = base()
        add[kSecValueData as String] = Data(bytes)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
        return SymmetricKey(data: Data(bytes))
      }
    }
  }

  public func mac(_ message: String, createKey: Bool) -> String? {
    loadKey(create: createKey).map { LaunchSeal.hmac(message, key: $0) }
  }

  public func verify(_ message: String, mac: String) -> Bool {
    guard let key = loadKey(create: false) else { return false }
    return LaunchSeal.valid(mac, for: message, key: key)
  }

  /// Removes this store's own item (a test's throwaway service). True when it is gone.
  @discardableResult
  public func deleteKey() -> Bool {
    lock.withLock {
      quietly {
        let s = SecItemDelete(base() as CFDictionary)
        return s == errSecSuccess || s == errSecItemNotFound
      }
    }
  }
}

/// The one-time step that comes with the seal (standing rule 6: a changed default ships with a re-runnable migration and a way back).
/// Version 2 also changed the fingerprint from FNV-1a to SHA-256 over a length-prefixed encoding, so every earlier seal is cleared.
/// Before the seal, `confirmed_launch` was a plain fingerprint. It cannot be told from one an agent wrote, so it is not trusted: the first
/// start after the update puts the warning on a card, the owner's tap seals it. This step removes the unsealed value (so the card says "not
/// confirmed on this Mac yet" rather than "changed") and records that it ran, in `launch_trust`. It does nothing a second time; setting
/// `launch_trust` back to 0 (or deleting the key) in desktop.json runs it again. The way back to the old behaviour: turn "Press Enter for me"
/// (`auto_confirm_restart`) off, and press Enter in the pane (or tap the card) yourself.
public enum LaunchTrustMigration {
  public static let version = 2

  /// Loads desktop.json, runs the step and saves the file when it changed it (only a file that exists is rewritten). `migrated` is true when it ran now.
  public static func load(_ path: String) -> (config: DesktopConfig?, migrated: Bool) {
    guard var c = (try? ConfigFile.load(path)) ?? nil else { return (nil, false) }
    let migrated = run(&c)
    if migrated { try? ConfigFile.save(c, to: path) }
    return (c, migrated)
  }

  /// True when it changed the config.
  @discardableResult
  public static func run(_ c: inout DesktopConfig) -> Bool {
    guard (c.launchTrust ?? 0) < version else { return false }
    c.launchTrust = version
    // an earlier value is either unsealed or sealed over the old fingerprint: neither is the current format, so the owner taps once
    c.confirmedLaunch = nil
    c.confirmedLaunchParts = nil
    c.confirmedLaunchMac = nil
    return true
  }
}
