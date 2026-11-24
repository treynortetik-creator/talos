import Foundation
import TalosDesktopCore

/// Putting things back after a failed update, and checking that it worked (split from AutoUpdater.swift to keep that file under its
/// size limit). The record of a failed update (`pending.json`) is removed only once the app and the Talos code folder are seen to be
/// together again; otherwise it stays, marked `repair`, the owner gets one line, and only the owner's Try again looks again.
extension AutoUpdater {
  /// The swap was stopped before it could say how it ended: the checkout goes back to where it was, if it moved. True: it is back (it
  /// was already, or the way back ran and said ok).
  @discardableResult
  func restoreCheckout(_ p: AutoUpdate.Pending) -> Bool {
    // a checkout that is not a plain clone is not read by git here: the script refuses it too, and says so
    if readableForRestore(p.checkout),
      git(p.checkout, ["rev-parse", "HEAD"]) == p.old_head, git(p.checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]) == p.old_ref
    {
      audit("restore_not_needed")
      return true
    }
    var args = ["--restore", "--checkout", p.checkout, "--to", p.old_ref]
    if let c = p.commit { args += ["--commit", c] }
    let r = runApply(args + ["--result", dir + "/restore.json"], deps: true, timeout: 900)
    audit("restore", ["ok": r.ok ? "1" : "0", "exit": "\(r.status)"])
    return r.ok
  }

  /// What the apply script's `--preflight` answered about a folder. `unreadable`: it answered, and said the folder is not a plain clone
  /// (settings of its own) or is missing or moved. `unknown`: no answer (no git, the script could not run, no result, or an answer this
  /// app does not know): nothing is assumed from it.
  enum FolderLook { case clean, dirty, unreadable, unknown }

  func folderLook(_ co: String) -> FolderLook {
    guard resolvedGit != nil else { return .unknown }
    try? FileManager.default.removeItem(atPath: preflightPath)
    let out = runApply(["--preflight", "--checkout", co, "--result", preflightPath], deps: false, timeout: options.gitTimeout)
    guard let res = readResult(preflightPath) else { return .unknown }
    if out.ok, res.ok { return .clean }
    switch res.why.flatMap(AutoUpdate.Failure.init(rawValue:)) {
    case .dirty?: return .dirty
    case .checkoutConfig?, .checkout?: return .unreadable
    default: return .unknown
    }
  }

  /// Whether the app and the code are together on the OLD version after a failed update, looked at now (not taken from what a script
  /// said). `restore`: put the code back first. The new app running (a rollback that failed) is the one case with nothing to put back:
  /// the folder then belongs with the app that is installed. The app is not back when the app on disk is the new version while the old
  /// one still runs. The code is not back when the folder's commit is not the one it was on (commits are compared, not branch names) or
  /// the way back did not say ok. A folder the script really answered is not a plain clone is never read or moved by Talos, so there is
  /// nothing to check there; no answer at all is NOT that: the code then counts as not back.
  func checkedBack(_ p: AutoUpdate.Pending, restore: Bool) -> Bool {
    if let v = options.appVersion, ReleaseManifest.compare(v, p.version) == 0 { return true }
    let ran = restore ? restoreCheckout(p) : true
    // read from the app's own file: the main bundle caches the version of the app that was started
    let plist = NSDictionary(contentsOfFile: options.appPath + "/Contents/Info.plist")
    let onDisk = plist?["CFBundleShortVersionString"] as? String
    let appBack = onDisk.map { ReleaseManifest.compare($0, p.version) != 0 } ?? true
    let codeBack: Bool
    switch folderLook(p.checkout) {
    case .clean, .dirty: codeBack = ran && git(p.checkout, ["rev-parse", "HEAD"])?.lowercased() == p.old_head.lowercased()
    case .unreadable: codeBack = true
    case .unknown: codeBack = false
    }
    audit("back_checked", ["version": p.version, "app": appBack ? "1" : "0", "code": codeBack ? "1" : "0"])
    return appBack && codeBack
  }

  /// Every file of a settled update goes. Called only after `checkedBack` passed (or when nothing needed putting back).
  func clearUpdateFiles(_ p: AutoUpdate.Pending) {
    for f in [pendingPath, resultPath, preparePath, scriptPath, dir + "/" + p.version, healthPath(p.version)] {
      try? FileManager.default.removeItem(atPath: f)
    }
  }

  /// The record that needs repair, kept in memory as well as on disk: a disk that cannot be written must not make every look run the
  /// way back again and say it again. Cleared by a repair that passed, a record that cleared itself, or nothing else.
  var repairHold: AutoUpdate.Pending? {
    get { repairLock.withLock { heldForRepair } }
    set { repairLock.withLock { heldForRepair = newValue } }
  }

  /// Whether a failed update is waiting for the owner's Try again (read from the memory hold or the record on disk; cheap, any thread).
  public func needsRepair() -> Bool { repairHold != nil || readPending()?.repair == true }

  private func repairLine(_ p: AutoUpdate.Pending) -> String {
    AutoUpdate.repairLine(p.version, old: p.old_version.isEmpty ? (options.appVersion ?? "the previous version") : p.old_version)
  }

  /// The record stays, marked, and the owner is told once in the chat and in the update window. False: nothing else may start.
  @discardableResult
  func keepForRepair(_ p: AutoUpdate.Pending) -> Bool {
    var q = p
    q.repair = true
    repairHold = q
    if !writePending(q) { audit("repair_record_not_written", ["version": p.version]) }  // the hold in memory still stands
    audit("repair_needed", ["version": p.version])
    stopAskedAt = nil
    phase = .idle(next: nextCheck(hooks.awake()))
    let line = repairLine(q)
    fail(line)
    sayOnce(p.version + "|repair", line)
    return false
  }

  /// A repair that is no longer needed clears itself, with nothing moved: the owner put another app in place (the running version is
  /// not the one the update came from), or the folder is a clean plain clone that someone moved to a commit that is neither the release's
  /// nor the old one. Commits are compared, never branch names. A reason, or nil.
  func staleRepair(_ p: AutoUpdate.Pending, lookAtFolder: Bool) -> String? {
    if let v = options.appVersion, !p.old_version.isEmpty, ReleaseManifest.compare(v, p.old_version) != 0 { return "app_replaced" }
    guard lookAtFolder, let commit = p.commit?.lowercased(), folderLook(p.checkout) == .clean,
      let head = git(p.checkout, ["rev-parse", "HEAD"])?.lowercased()
    else { return nil }
    return head != commit && head != p.old_head.lowercased() ? "code_moved" : nil
  }

  private func dropRepair(_ p: AutoUpdate.Pending, why: String) {
    audit("repair_dropped", ["version": p.version, "why": why])
    clearUpdateFiles(p)
    repairHold = nil
    stopAskedAt = nil
    phase = .idle(next: nextCheck(hooks.awake()))
  }

  /// A look that is not the owner's Try again: the line stands (and is shown again if another status replaced it), nothing is tried. The
  /// folder is looked at only the first time in this process (it runs a script). False: nothing else starts.
  func holdForRepair(_ p: AutoUpdate.Pending) -> Bool {
    let line = repairLine(p)
    let first = status != .failed(line: line, logPath: logPathForOwner)
    if let why = staleRepair(p, lookAtFolder: first) {
      dropRepair(p, why: why)
      return true
    }
    if first { audit("repair_waiting", ["version": p.version]) }
    fail(line)
    return false
  }

  /// The owner's Try again on a marked record: the way back runs once more and is checked. True: it passed (or was not needed any
  /// more) and the record is gone.
  func repairAgain(_ p: AutoUpdate.Pending) -> Bool {
    audit("repair_retry", ["version": p.version])
    if let why = staleRepair(p, lookAtFolder: true) {
      dropRepair(p, why: why)
      return true
    }
    guard checkedBack(p, restore: true) else {
      audit("repair_failed", ["version": p.version])
      return holdForRepair(p)
    }
    clearUpdateFiles(p)
    repairHold = nil
    stopAskedAt = nil
    phase = .idle(next: nextCheck(hooks.awake()))
    audit("repair_done", ["version": p.version])
    return true
  }

  /// The owner's Try again (the one entry the update window, the menu and About all use). Only this (never a timer, a launch or a
  /// check) looks again, so a failing repair cannot loop. `done(true)`: nothing is left to repair (the caller goes on to its check); false:
  /// it still is, and the failed line is shown again.
  public func retryRepair(done: @escaping @Sendable (Bool) -> Void) {
    queue.async {
      guard !self.ownsPending, self.needsRepair() else { return done(true) }
      self.setStatus(.checking)
      let passed = self.settlePending(retryRepair: true)
      if passed { self.setStatus(.idle) }  // not passed: the failed line was published again by the look that failed
      done(passed)
    }
  }

  /// The owner opened the update window or the menu while a repair waits: the failed line is published again, whatever replaced it.
  public func showRepairLine() {
    queue.async {
      guard !self.ownsPending, self.needsRepair() else { return }
      self.setStatus(.idle)
      _ = self.settlePending()
    }
  }
}
