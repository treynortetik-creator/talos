import Foundation

/// What `Talos --selftest` prints as one JSON line (DESKTOP-SPEC 7.1). Never starts a session or opens a window.
public struct SelfTestReport: Codable, Equatable, Sendable {
  public var version: String
  public var bundleId: String
  public var swiftterm: Bool
  public var notificationsReachable: Bool
  public var loginItemStatus: Int
  public var configDefaultsDecode: Bool

  public init(
    version: String, bundleId: String, swiftterm: Bool, notificationsReachable: Bool,
    loginItemStatus: Int, configDefaultsDecode: Bool
  ) {
    self.version = version
    self.bundleId = bundleId
    self.swiftterm = swiftterm
    self.notificationsReachable = notificationsReachable
    self.loginItemStatus = loginItemStatus
    self.configDefaultsDecode = configDefaultsDecode
  }

  enum CodingKeys: String, CodingKey {
    case version, swiftterm
    case bundleId = "bundle_id"
    case notificationsReachable = "notifications_reachable"
    case loginItemStatus = "login_item_status"
    case configDefaultsDecode = "config_defaults_decode"
  }

  /// The checks that must hold for exit 0. Notifications and login-item status are informational (they depend on the
  /// machine's privacy state, and an unbundled debug run has neither).
  public var ok: Bool { swiftterm && configDefaultsDecode && bundleId == SelfTestReport.expectedBundleId }

  public static let expectedBundleId = "app.talos.desktop"

  public func jsonLine() throws -> String {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys]
    return String(decoding: try e.encode(self), as: UTF8.self)
  }
}
