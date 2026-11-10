import AppKit
import Foundation
import TalosDesktopCore

/// Choose… for a thread's folder: the page asks (`pick_folder`), the Mac shows its own open panel and answers `folder_picked`.
/// Nothing is saved here. The page saves the path through the owner-signed thread patch, and the bridge checks it there.
extension WebController {
  /// The real open panel, the one thing `folderPanel` does outside tests.
  static func runOpenPanel(_ spec: FolderPanelSpec) -> String? {
    let p = NSOpenPanel()
    p.canChooseFiles = spec.canChooseFiles
    p.canChooseDirectories = spec.canChooseDirectories
    p.canCreateDirectories = spec.canCreateDirectories
    p.allowsMultipleSelection = spec.allowsMultipleSelection
    p.directoryURL = URL(fileURLWithPath: spec.directory, isDirectory: true)
    return p.runModal() == .OK ? p.url?.path : nil
  }

  /// Only a signed-in page gets a panel, and only one at a time. A page that is not ready or signed in, or asks while a panel is up,
  /// is told "not now" (never left waiting, never taken for the owner cancelling). A folder whose name has a character Talos cannot
  /// use is said so, not dropped as a cancel.
  func pickFolder(req: String, start: String?) {
    guard pageReady, signedIn, !pickingFolder else {
      deliver(.folderPicked(req: req, path: nil, why: .notNow))
      return
    }
    pickingFolder = true
    defer { pickingFolder = false }
    let spec = FolderPanelSpec.make(start: start, home: NSHomeDirectory())
    guard let chosen = folderPanel(spec) else {
      deliver(.folderPicked(req: req, path: nil))
      return
    }
    deliver(FolderPath.isValid(chosen) ? .folderPicked(req: req, path: chosen) : .folderPicked(req: req, path: nil, why: .badName))
  }
}
