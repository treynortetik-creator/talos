import Foundation

public protocol LoginItemService {
  var status: LoginItemPlan.Service { get }
  func register() throws
  func unregister() throws
}

public protocol LaunchAgentFiles {
  func exists(_ path: String) -> Bool
  func write(_ data: Data, to path: String) throws
  func remove(_ path: String) throws
}

/// Start at login, default off (DESKTOP-SPEC 6.5). Uses the system service when it will register this app; otherwise a
/// LaunchAgent plist. Turning it off removes whichever was used. Both seams are injected, so the tests never touch the
/// machine's real login items.
public struct LoginItemManager {
  public let service: LoginItemService
  public let files: LaunchAgentFiles
  public let home: String
  public let bundleId: String
  public let executable: String

  public init(service: LoginItemService, files: LaunchAgentFiles, home: String, bundleId: String, executable: String) {
    self.service = service
    self.files = files
    self.home = home
    self.bundleId = bundleId
    self.executable = executable
  }

  var agentPath: String { LoginItemPlan.launchAgentPath(home: home, bundleId: bundleId) }

  public var isOn: Bool { service.status == .enabled || service.status == .requiresApproval || files.exists(agentPath) }

  /// The switch is on but macOS has not approved it yet: Talos will not start at login until it does.
  public var isPendingApproval: Bool { service.status == .requiresApproval }

  public func turnOn() -> LoginItemPlan.Outcome {
    do {
      try service.register()
    } catch {
      return writeAgent()  // register threw: fall back
    }
    if let o = LoginItemPlan.outcome(afterRegister: service.status) {
      if o == .fellBackToLaunchAgent {
        try? service.unregister()
        return writeAgent()
      }
      return o
    }
    return writeAgent()
  }

  public func turnOff() -> LoginItemPlan.Outcome? {
    var failure: String?
    if service.status != .notRegistered && service.status != .notFound {
      do { try service.unregister() } catch { failure = "\(error)" }
    }
    if files.exists(agentPath) {
      do { try files.remove(agentPath) } catch { failure = "\(error)" }
    }
    return failure.map { .failed($0) }
  }

  private func writeAgent() -> LoginItemPlan.Outcome {
    guard let data = LoginItemPlan.launchAgentPlist(bundleId: bundleId, executable: executable) else {
      return .failed("couldn't build the LaunchAgent")
    }
    do {
      try files.write(data, to: agentPath)
      return .fellBackToLaunchAgent
    } catch {
      return .failed("\(error)")
    }
  }
}
