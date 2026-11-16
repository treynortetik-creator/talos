import Foundation

/// Claude Code's managed settings, which outrank every other source and are always read: `managed-settings.json`, then each
/// `managed-settings.d/*.json` in name order (never a dotfile), regular files only, an empty file counting as `{}`. A document that
/// cannot be read is left out, as Claude Code leaves it out (for main and its workers alike), and counted.
///
/// The folder is an input: the app passes `systemDir`, a test passes a folder of its own, so no test reads this Mac's.
public struct MainManagedSettings: Equatable, Sendable {
  /// The folder on macOS.
  public static let systemDir = "/Library/Application Support/ClaudeCode"

  /// The mode each document gives, as Claude Code reads it: one it cannot read (not text, not a mode it knows), or one next to a
  /// deny or ask list it cannot read, is withheld there and `default` stands in for it.
  public var modes: [String] = []
  /// Every deny rule, made absolute where it was defined (a `/` rule at its document's folder).
  public var deny: [String] = []
  public var unreadable = 0
  /// `disableBypassPermissionsMode` with any value but false, or a `permissions` that cannot be read: the restrictive reading.
  public var bypassDisabled = false

  /// A settings object's `permissions` turn bypass off.
  public static func bypassLocked(_ perms: [String: Any]?) -> Bool {
    guard let v = perms?["disableBypassPermissionsMode"] else { return false }
    // only JSON's own `false` turns it off (`SettingsJSON` reads that as a Swift Bool; a number is never one): 0 or "no" do not
    return !(type(of: v) == Bool.self && (v as? Bool) == false)
  }

  public static func read(dir: String?, agentDir: String) -> MainManagedSettings {
    var out = MainManagedSettings()
    guard let dir else { return out }
    var files = [dir + "/managed-settings.json"]
    let dropIns = (try? FileManager.default.contentsOfDirectory(atPath: dir + "/managed-settings.d")) ?? []
    for n in dropIns.sorted() where n.hasSuffix(".json") && !n.hasPrefix(".") { files.append(dir + "/managed-settings.d/" + n) }
    let cwd = MainOwnSettings.real(agentDir) ?? agentDir
    func listOfText(_ v: Any?) -> Bool { v == nil || ((v as? [Any])?.allSatisfy { $0 is String } ?? false) }
    for f in files {
      var st = stat()
      guard lstat(f, &st) == 0 else { continue }  // not there
      guard let data = MainOwnSettings.regularFile(f) else {
        out.unreadable += 1
        continue
      }
      let blank = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      guard let root = blank ? [:] : SettingsJSON.object(data) else {
        out.unreadable += 1
        continue
      }
      guard let raw = root["permissions"] else { continue }
      guard let perms = raw as? [String: Any] else {
        out.bypassDisabled = true  // a permissions value it cannot read holds its locks at their restrictive values
        continue
      }
      if bypassLocked(perms) { out.bypassDisabled = true }
      if let m = perms["defaultMode"] {
        let readable = listOfText(perms["deny"]) && listOfText(perms["ask"])
        if let name = m as? String, PrivilegeCeiling.Mode.isKnown(name), readable { out.modes.append(name) } else { out.modes.append("default") }
      }
      for case let r as String in (perms["deny"] as? [Any]) ?? [] {
        let a = PrivilegeCeiling.absolutize(r, slashAnchor: (f as NSString).deletingLastPathComponent, cwdAnchor: cwd)
        if !out.deny.contains(a) { out.deny.append(a) }
      }
    }
    return out
  }

  /// The narrowest of these mode names; a name Claude Code does not know stands as `default`, as it does there.
  public static func narrowest(_ modes: [String]) -> String? {
    var best: (name: String, rank: Int)?
    for raw in modes {
      let m = PrivilegeCeiling.Mode.isKnown(raw) ? raw : "default"
      let r = PrivilegeCeiling.Mode.ranks[m == "manual" ? "default" : m] ?? 1
      if best == nil || r < best!.rank { best = (m, r) }
    }
    return best?.name
  }
}
