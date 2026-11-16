import Foundation
import TalosDesktopCore

/// Option C, the privilege ceiling: main's own `--settings` (`MainOwnSettings`) at a thread session's start. Split out of
/// `WorkerManager` to keep that file under the size limit.
///
/// One read per start: `requestStart` makes it, refuses the start when it cannot be read, and hands the same read to `start` for the
/// ceiling. A file saved between two reads can then never leave the ceiling without the deny rules the refusal let through.
extension WorkerManager {
  static let mainSettingsKind = "main settings unreadable: "

  /// Main's own `--settings` for this start, or nil when it cannot be read: then the start is refused here (`start_failed`), before
  /// it takes a slot, so a start that cannot run never parks another session to make room. Each refusal is one audit line; the
  /// thread gets one line per episode (`tell`), naming the file and the fix. An episode ends with the first read that works.
  func mainSettingsOrRefuse(_ id: String) -> MainOwnSettings? {
    let own = readMainOwnSettings()
    guard case .unreadable(let raw) = own else {
      mainSettingsRead(id)
      return own
    }
    // a path is the owner's text: one line, no control or line-breaking characters, bounded
    func plain(_ u: Unicode.Scalar) -> Bool { u.value >= 0x20 && !(0x7f...0x9f).contains(u.value) && u.value != 0x2028 && u.value != 0x2029 }
    let what = String(String(raw.unicodeScalars.map { plain($0) ? Character($0) : " " }).prefix(200))
    audit("worker_start_refused thread=\(id) why=main_settings_unreadable settings=\(what)")
    fail(id, "start_failed", MainOwnSettings.unreadableDetail(what: what))
    tell(id, slot: \.mainSettingsNote, kind: Self.mainSettingsKind + what, MainOwnSettings.unreadableLine(what: what))
    return nil
  }

  /// The one place main's own `--settings` are read: once by each start (`mainSettingsOrRefuse`), once by each dry plan (`dryPlan`).
  func readMainOwnSettings() -> MainOwnSettings { MainOwnSettings.read(args: options.mainArgs, agentDir: options.agentDir, env: baseEnv()) }

  /// What main has for the ceiling, from the start's one read (`MainOwnSettings.ceiling`). Said in the audit log: a mode name
  /// Claude Code does not know (never guessed at: the ceiling is `plan`), and managed documents that could not be read.
  /// `quiet`: the update check's dry plan, which audits nothing.
  func mainCeiling(_ own: MainOwnSettings, claudeDir: String, quiet: Bool = false) -> MainOwnSettings.Ceiling {
    // with no arguments recorded, main's are just its permission flag
    let args = options.mainArgs.isEmpty ? (options.permissionFlag.map { [$0] } ?? []) : options.mainArgs
    let c = MainOwnSettings.ceiling(
      own, args: args, agentDir: options.agentDir, talosHome: options.talosHome, claudeDir: claudeDir, managedDir: options.managedDir)
    if quiet { return c }
    func shown(_ s: String) -> String { String(s.unicodeScalars.filter { $0.value > 0x20 && !(0x7f...0x9f).contains($0.value) && $0.value != 0x2028 && $0.value != 0x2029 }.prefix(40)) }
    let named = c.unknownMode ?? PrivilegeCeiling.Mode.from(args: c.permissionArgs, settingsDefault: c.defaultMode).name
    if let named, !PrivilegeCeiling.Mode.isKnown(named) { audit("worker_ceiling_narrowed why=unknown_mode mode=\(shown(named))") }
    if c.managedUnreadable > 0 { audit("managed_settings_unreadable files=\(c.managedUnreadable)") }
    return c
  }

  /// The file reads: the episode of refused starts is over, so a file that breaks again is told again. The records are removed by
  /// their prefix, since a relaunched app does not remember which file it named.
  func mainSettingsRead(_ id: String) {
    guard rt[id] != nil else { return }
    if rt[id]?.fenceKinds[\Runtime.mainSettingsNote] != nil {
      rt[id]?.mainSettingsNote.reset()
      rt[id]?.fenceKinds[\Runtime.mainSettingsNote] = nil
    }
    var m = readNotices(id)
    let stale = m.keys.filter { $0.hasPrefix(Self.mainSettingsKind) }
    guard !stale.isEmpty else { return }
    for k in stale { m[k] = nil }
    writeNotices(id, m)
  }

  /// Each tick: the line of a refused start whose post failed clearly is tried again (`sendNotice` keeps the count and the wait).
  /// Only while that refusal is still why the thread is failed: a line about a file that reads again would be false.
  func retryMainSettingsNotes() {
    for (id, r) in rt where r.entry.state == "failed" && !r.mainSettingsNote.sent {
      let mine = r.entry.error?.detail?.hasPrefix(MainOwnSettings.detailPrefix) == true
      guard mine, let kind = r.fenceKinds[\Runtime.mainSettingsNote] else { continue }
      sendNotice(id, \.mainSettingsNote, kind: kind, text: MainOwnSettings.unreadableLine(what: String(kind.dropFirst(Self.mainSettingsKind.count))))
    }
  }
}
