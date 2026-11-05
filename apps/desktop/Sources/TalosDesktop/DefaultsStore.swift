import Foundation
import TalosDesktopCore

/// `SettingsStore` over UserDefaults: where settings changed before setup wait (U8).
final class DefaultsStore: SettingsStore, @unchecked Sendable {
  private let defaults: UserDefaults
  init(_ d: UserDefaults = .standard) { defaults = d }
  func data(forKey key: String) -> Data? { defaults.data(forKey: key) }
  func string(forKey key: String) -> String? { defaults.string(forKey: key) }
  func set(_ data: Data?, forKey key: String) {
    if let data { defaults.set(data, forKey: key) } else { defaults.removeObject(forKey: key) }
  }
}
