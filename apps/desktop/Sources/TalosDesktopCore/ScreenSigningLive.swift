import AppKit
import Foundation
import Security

/// The Security framework behind `ScreenCodeSigning`. Read-only questions about code that is already running or already on disk:
/// nothing here asks the owner anything or changes any setting.
///
/// A running app is named by its pid, so a pid that ends and is reused between the check and the event could in theory be another
/// program; the gates check again at every event, which keeps that window to one event.
public struct LiveCodeSigning: ScreenCodeSigning {
  public init() {}

  public func lookup(pid: Int32) -> ScreenCodeLookup {
    guard let run = NSRunningApplication(processIdentifier: pid) else { return .gone }
    let name = run.localizedName ?? run.bundleIdentifier ?? "an app"
    guard let code = Self.code(pid: pid), let st = Self.staticCode(code) else { return .gone }
    return Self.identity(st, bundleID: run.bundleIdentifier, name: name)
  }

  public func lookup(appPath: String) -> ScreenCodeLookup {
    guard FileManager.default.fileExists(atPath: appPath), let st = Self.staticCode(path: appPath) else { return .gone }
    let name = FileManager.default.displayName(atPath: appPath).replacingOccurrences(of: ".app", with: "")
    return Self.identity(st, bundleID: Bundle(path: appPath)?.bundleIdentifier, name: name)
  }

  public func matches(pid: Int32, app: ScreenAllowedApp) -> Bool {
    guard let req = Self.requirement(app.designatedRequirement), let code = Self.code(pid: pid),
      SecCodeCheckValidity(code, SecCSFlags(), req) == errSecSuccess, let st = Self.staticCode(code)
    else { return false }
    return Self.teamID(st) == app.teamID
  }

  public func matches(appPath: String, app: ScreenAllowedApp) -> Bool {
    guard let req = Self.requirement(app.designatedRequirement), let st = Self.staticCode(path: appPath),
      SecStaticCodeCheckValidity(st, SecCSFlags(rawValue: kSecCSDoNotValidateResources), req) == errSecSuccess
    else { return false }
    return Self.teamID(st) == app.teamID
  }

  public func isApple(pid: Int32, identifier: String) -> Bool {
    // the id goes into the requirement's text: only an id made of the characters bundle ids use, so it cannot change the rule
    guard !identifier.isEmpty, identifier.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x2e || $0 == 0x2d }),
      let req = Self.requirement("identifier \"\(identifier)\" and anchor apple"), let code = Self.code(pid: pid)
    else { return false }
    return SecCodeCheckValidity(code, SecCSFlags(), req) == errSecSuccess
  }

  // MARK: pieces

  static func code(pid: Int32) -> SecCode? {
    var code: SecCode?
    let attrs = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attrs, SecCSFlags(), &code) == errSecSuccess else { return nil }
    return code
  }

  static func staticCode(_ code: SecCode) -> SecStaticCode? {
    var st: SecStaticCode?
    guard SecCodeCopyStaticCode(code, SecCSFlags(), &st) == errSecSuccess else { return nil }
    return st
  }

  static func staticCode(path: String) -> SecStaticCode? {
    var st: SecStaticCode?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, SecCSFlags(), &st) == errSecSuccess else { return nil }
    return st
  }

  /// A requirement from its text. Nil for none, an empty one, or text macOS does not read: an entry without a requirement matches
  /// nothing.
  static func requirement(_ text: String?) -> SecRequirement? {
    guard let text, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    var req: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, SecCSFlags(), &req) == errSecSuccess else { return nil }
    return req
  }

  static func info(_ st: SecStaticCode) -> [String: Any]? {
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(st, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { return nil }
    return info as? [String: Any]
  }

  static func teamID(_ st: SecStaticCode) -> String? {
    info(st)?[kSecCodeInfoTeamIdentifier as String] as? String
  }

  static func identity(_ st: SecStaticCode, bundleID: String?, name: String) -> ScreenCodeLookup {
    guard let b = bundleID?.trimmingCharacters(in: .whitespaces), !b.isEmpty else { return .noBundleID(name: name) }
    // An unsigned or broken signature has no designated requirement to bind to.
    guard SecStaticCodeCheckValidity(st, SecCSFlags(rawValue: kSecCSDoNotValidateResources), nil) == errSecSuccess else {
      return .unsigned(name: name)
    }
    var req: SecRequirement?
    var text: CFString?
    guard SecCodeCopyDesignatedRequirement(st, SecCSFlags(), &req) == errSecSuccess, let req,
      SecRequirementCopyString(req, SecCSFlags(), &text) == errSecSuccess, let text
    else { return .unsigned(name: name) }
    let i = info(st) ?? [:]
    let team = i[kSecCodeInfoTeamIdentifier as String] as? String
    let flags = (i[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    let adhoc = flags & SecCodeSignatureFlags.adhoc.rawValue != 0
    let r = text as String
    let apple = team == nil && r.contains("anchor apple") && !r.contains("anchor apple generic")
    let signer: ScreenCodeIdentity.Signer = adhoc ? .adhoc : (apple ? .apple : .developer)
    return .signed(ScreenCodeIdentity(bundleID: b, teamID: team, requirement: r, name: name, signer: signer))
  }
}
