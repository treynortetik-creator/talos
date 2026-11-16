import CryptoKit
import Foundation
import Security

/// What the allowed list keeps where other programs of the owner's cannot write (review R1-3): the key that seals the file, the
/// file's generation, and the removal memory (the approvals the owner removed or replaced). One record per list.
public struct ScreenListState: Sendable {
  public var key: SymmetricKey
  public var generation: UInt64
  /// SHA-256 (hex) of each removed or replaced approval's signed bytes, newest last.
  public var removed: [String]
  public init(key: SymmetricKey, generation: UInt64, removed: [String] = []) {
    self.key = key
    self.generation = generation
    self.removed = removed
  }
}

public struct ScreenListKeyError: Error, Equatable, Sendable {
  public var why: String
  public init(_ why: String) { self.why = why }
}

/// The record's store. The app's is the Keychain (`KeychainListKeyStore`); tests use one in memory and never touch the Keychain.
public protocol ScreenListKeyStore: Sendable {
  /// The list's record, made (a new key, generation 0, nothing removed) when there is none yet.
  func load(account: String) -> Result<ScreenListState, ScreenListKeyError>
  func save(_ state: ScreenListState, account: String) -> Result<Void, ScreenListKeyError>
}

/// The record as one generic password, kept the way the launch seal keeps its key (`KeychainItem`: this device only, never synced,
/// no prompt ever; a call the Keychain would ask about fails, and the list then allows nothing). A record that exists but cannot be
/// read is never replaced: a build signed by another signer keeps its own record beside it (`SignerScopedItem`), starting empty, so
/// the owner allows the apps again once instead of the list allowing nothing for good.
public struct KeychainListKeyStore: ScreenListKeyStore, @unchecked Sendable {
  public static let service = "com.talos.app.screen-allowed-apps"
  let service: String
  let keychain: SecKeychain?
  let signer: String?
  /// `keychain` limits every call to that one keychain (a test's throwaway one); nil is the owner's Keychain, as the app uses.
  public init(service: String = KeychainListKeyStore.service, keychain: SecKeychain? = nil, signer: String? = SignerKey.current()) {
    self.service = service
    self.keychain = keychain
    self.signer = signer
  }

  public func load(account: String) -> Result<ScreenListState, ScreenListKeyError> {
    let (item, d, st) = SignerScopedItem(service: service, account: account, keychain: keychain, signer: signer).resolve()
    if st == errSecSuccess {
      guard let d, let s = Self.decode(d) else { return .failure(ScreenListKeyError("the Keychain record is not one Talos made")) }
      return .success(s)
    }
    guard st == errSecItemNotFound else { return .failure(ScreenListKeyError(Self.text(st))) }
    let made = ScreenListState(key: SymmetricKey(size: .bits256), generation: 0)
    let a = item.add(Self.encode(made))
    guard a == errSecSuccess else { return .failure(ScreenListKeyError(Self.text(a))) }
    return .success(made)
  }

  public func save(_ state: ScreenListState, account: String) -> Result<Void, ScreenListKeyError> {
    let st = SignerScopedItem(service: service, account: account, keychain: keychain, signer: signer).resolve().item.update(Self.encode(state))
    return st == errSecSuccess ? .success(()) : .failure(ScreenListKeyError(Self.text(st)))
  }

  static func encode(_ s: ScreenListState) -> Data {
    let o: [String: Any] = [
      "v": 1, "key": s.key.withUnsafeBytes { Data($0) }.base64EncodedString(), "generation": NSNumber(value: s.generation),
      "removed": s.removed,
    ]
    return (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data()
  }

  static func decode(_ d: Data) -> ScreenListState? {
    guard let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], JSONValue.int(o["v"]) == 1,
      let k = (o["key"] as? String).flatMap({ Data(base64Encoded: $0) }), k.count == 32, let g = JSONValue.int(o["generation"]), g >= 0
    else { return nil }
    let removed = ((o["removed"] as? [Any]) ?? []).compactMap { $0 as? String }
    return ScreenListState(key: SymmetricKey(data: k), generation: UInt64(g), removed: removed)
  }

  static func text(_ st: OSStatus) -> String {
    (SecCopyErrorMessageString(st, nil) as String?) ?? "Keychain error \(st)"
  }
}
