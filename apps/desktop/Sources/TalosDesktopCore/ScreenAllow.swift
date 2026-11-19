import Foundation

/// Lane 3: which apps an agent may see and drive on this Mac, bound to the app's code signature, not to its name.
///
/// A bundle id is only a claim: any app, signed or not, can put any id in its Info.plist. So an entry on the owner's list holds the
/// app's designated requirement (the rule macOS itself uses to tell one signed app from another) and its team id, and an app counts
/// as allowed only while the running code (or, for opening it, the app on disk) satisfies that requirement and has that team id.
///
/// Signing kinds, decided here:
/// - Apple's own apps and apps signed by a developer: the requirement names the signer, so updates of the same app keep the grant.
/// - Ad-hoc signed (no developer, common for apps built at home): the requirement is the exact build's hash, so the grant covers that
///   one build. A rebuilt or updated app asks again. Never widened to the bundle id.
/// - Unsigned, or no app id at all: never allowed and never asked about; the agent is told why.

/// Who a refusal is about, so the Mac can measure that app's signature for the owner's card.
public enum ScreenSubject: Sendable, Equatable {
  /// A running process (the app in front, the window under the pointer, the window asked for).
  case running(pid: Int32)
  /// An app on disk (opening one that is not running yet).
  case installed(path: String)
}

/// What macOS says an app's signature is.
public struct ScreenCodeIdentity: Sendable, Equatable {
  public enum Signer: String, Sendable, Equatable {
    /// Signed by Apple (the system's own apps).
    case apple
    /// Signed with a developer's certificate (team id set).
    case developer
    /// Signed with no certificate: the requirement is this one build.
    case adhoc
  }

  public var bundleID: String
  public var teamID: String?
  /// The designated requirement, as macOS prints it.
  public var requirement: String
  public var name: String
  public var signer: Signer

  public init(bundleID: String, teamID: String?, requirement: String, name: String, signer: Signer) {
    self.bundleID = bundleID
    self.teamID = teamID
    self.requirement = requirement
    self.name = name
    self.signer = signer
  }
}

public enum ScreenCodeLookup: Sendable, Equatable {
  case signed(ScreenCodeIdentity)
  /// No valid signature: it can never be put on the list.
  case unsigned(name: String)
  /// No bundle id: nothing to put on the list.
  case noBundleID(name: String)
  /// The process ended or the app is not there.
  case gone
}

/// The Security framework, or a fake.
public protocol ScreenCodeSigning: Sendable {
  func lookup(pid: Int32) -> ScreenCodeLookup
  func lookup(appPath: String) -> ScreenCodeLookup
  /// The running code satisfies `app`'s requirement and has its team id. False whenever it cannot be told.
  func matches(pid: Int32, app: ScreenAllowedApp) -> Bool
  /// The app on disk satisfies `app`'s requirement and has its team id. False whenever it cannot be told.
  func matches(appPath: String, app: ScreenAllowedApp) -> Bool
  /// The running process is Apple's own code and is the program it claims to be (`identifier "<id>" and anchor apple`). False
  /// whenever it cannot be told.
  func isApple(pid: Int32, identifier: String) -> Bool
}

/// One app the owner let agents use on this Mac, as the screen gates read it. Only `ScreenAllowStore` makes these from the owner's
/// signed approvals; the gates never trust the bundle id alone.
public struct ScreenAllowedApp: Sendable, Equatable, Codable {
  public var bundleID: String
  public var teamID: String?
  public var designatedRequirement: String?
  public var name: String
  /// When the owner allowed it (ISO 8601), "" when not known.
  public var addedAt: String
  public init(bundleID: String, teamID: String? = nil, designatedRequirement: String? = nil, name: String = "", addedAt: String = "") {
    self.bundleID = bundleID
    self.teamID = teamID
    self.designatedRequirement = designatedRequirement
    self.name = name.isEmpty ? bundleID : name
    self.addedAt = addedAt
  }
}

/// The list for one request: the entries and the signature check. An app is allowed when its bundle id is on the list exactly and its
/// code passes that entry's signature check. Each pid is checked once per request.
public struct ScreenAllowed: Sendable {
  public let apps: [ScreenAllowedApp]
  let signing: any ScreenCodeSigning
  private let memo = PidMemo()

  public init(apps: [ScreenAllowedApp], signing: any ScreenCodeSigning) {
    self.apps = apps.compactMap { a in
      var a = a
      a.bundleID = a.bundleID.trimmingCharacters(in: .whitespaces)
      return a.bundleID.isEmpty ? nil : a
    }
    self.signing = signing
  }

  public var bundleIDs: Set<String> { Set(apps.map(\.bundleID)) }

  func entry(_ bundleID: String?) -> ScreenAllowedApp? {
    guard let b = bundleID, !b.isEmpty, !ScreenDenied.contains(b) else { return nil }
    return apps.first { $0.bundleID == b }
  }

  public func allows(bundleID: String?, pid: Int32) -> Bool {
    guard let e = entry(bundleID) else { return false }
    return memo.get(pid: pid, bundleID: e.bundleID) { signing.matches(pid: pid, app: e) }
  }

  /// Apple's own code, asked once per pid per request (the desktop windows).
  public func isAppleProcess(_ pid: Int32, claiming id: String) -> Bool {
    memo.get(pid: pid, bundleID: "apple:" + id) { signing.isApple(pid: pid, identifier: id) }
  }

  public func allowsInstalled(bundleID: String, appPath: String) -> Bool {
    guard let e = entry(bundleID) else { return false }
    return signing.matches(appPath: appPath, app: e)
  }

  final class PidMemo: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String: Bool] = [:]
    func get(pid: Int32, bundleID: String, _ check: () -> Bool) -> Bool {
      let k = "\(pid)|\(bundleID)"
      if let v = lock.withLock({ seen[k] }) { return v }
      let v = check()
      lock.withLock { seen[k] = v }
      return v
    }
  }
}
