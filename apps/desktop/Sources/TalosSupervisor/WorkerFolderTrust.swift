import Foundation
import TalosDesktopCore

extension WorkerManager {
  /// What the thread is told when the owner answered "No, exit" to the folder-trust question (the Linux twin: DECLINED_TRUST in workers.ts).
  public static let declinedTrustText =
    "you chose not to trust this folder, so its session was stopped. Send a message to start it again and be asked again, or pick another folder"

  /// What the thread is told when the owner answered "No, exit" to the bypass disclaimer, or "Exit" to the development-channels question
  /// (the Linux twin: `declinedTrustText` in worker-dialogs.ts).
  public static func declinedExitText(_ kind: DialogReader.Kind) -> String {
    kind == .bypass
      ? "you chose not to run with permission checks off, so its session was stopped. Send a message to start it again and be asked again"
      : "you chose to exit instead of loading the development channel, so its session was stopped. Send a message to start it again and be asked again"
  }

  /// The owner chose this folder for the thread, so Claude Code's trust question for it is answered now (`FolderTrust`), before the
  /// session starts. Never the agent folder (Main's trust is first-start's). A refusal or a failure never stops the start: it is audited,
  /// and the question on the pane then reaches the phone as a card (`WorkerDialogOffer.swift`). The Linux twin is `acceptFolderTrust`
  /// in workers-wiring.ts.
  func acceptFolderTrust(_ id: String, _ s: ThreadSessionSettings, cwd: String, base: [String: String]) {
    guard cwd != options.agentDir, realFolder(cwd) != realFolder(options.agentDir) else { return }
    // only a folder the owner chose (a signed config.patch, recorded by the bridge: `OwnerFolders`), never one `lead init` or a hand edit
    // wrote: for those the trust card shows the folder and the owner decides
    let ids = [id] + (s.sub.map { $0.shares && $0.refusal == nil ? [$0.parentId] : [] } ?? [])
    guard OwnerFolders.chose(talosHome: options.talosHome, ids: ids, configured: s.cwd ?? "", folder: cwd) else {
      audit("worker_folder_trust_refused thread=\(id) why=\"the folder is not recorded as the owner's choice\"")
      return
    }
    let configHome = WorkerMcp.configDirSet(env: base) ? WorkerMcp.claudeDir(home: options.home, env: base) : options.home
    switch FolderTrust.preAccept(
      configFile: FolderTrust.configFile(configHome: configHome), folder: cwd, chosen: s.cwd.map { [$0] } ?? [], home: options.home,
      talosHome: options.talosHome, agentDir: options.agentDir)
    {
    case .wrote: audit("worker_folder_trust_accepted thread=\(id)")
    case .already: break
    case .refused(let why): audit("worker_folder_trust_refused thread=\(id) why=\"\(WorkerNotice.logValue(why))\"")
    }
  }

  private func realFolder(_ p: String) -> String? {
    guard let r = realpath(p, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
  }
}
