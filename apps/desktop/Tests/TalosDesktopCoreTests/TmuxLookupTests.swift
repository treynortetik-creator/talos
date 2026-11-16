import Foundation
import Testing

@testable import TalosDesktopCore

/// Where the app looks for tmux. An app started from Finder or as a login item has a bare PATH, so a tmux installed without
/// admin (micromamba, into ~/.local; install.sh prints the route) must be found by folder, not by PATH.
@Suite("tmux lookup")
struct TmuxLookupTests {
  /// A scratch home holding an executable tmux at `rel`. Only files under it count as executable, so this Mac's own
  /// /opt/homebrew/bin/tmux (if any) cannot answer for it.
  final class Home {
    let root: String
    init(_ rel: String?) throws {
      root = FileManager.default.temporaryDirectory.appendingPathComponent("tmux-lookup-\(UUID().uuidString)").path
      try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
      if let rel {
        let p = root + "/" + rel
        try FileManager.default.createDirectory(
          atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: p, contents: Data("#!/bin/sh\necho tmux 3.8\n".utf8))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: p)
      }
    }
    func isExecutable(_ p: String) -> Bool { p.hasPrefix(root + "/") && FileManager.default.isExecutableFile(atPath: p) }
    deinit { try? FileManager.default.removeItem(atPath: root) }
  }

  @Test func aTmuxInLocalBinIsFoundWithTheBarePathOfAFinderLaunch() throws {
    let h = try Home(".local/bin/tmux")
    let found = TalosAppLocator.findTmux(envPath: "/usr/bin:/bin:/usr/sbin:/sbin", home: h.root, isExecutable: h.isExecutable)
    #expect(found == h.root + "/.local/bin/tmux")
  }

  @Test func micromambasOwnFolderIsLookedInToo() throws {
    let h = try Home(".local/talos-tmux/bin/tmux")
    let found = TalosAppLocator.findTmux(envPath: nil, home: h.root, isExecutable: h.isExecutable)
    #expect(found == h.root + "/.local/talos-tmux/bin/tmux")
  }

  @Test func thePathStillComesFirstAndNoTmuxIsNil() throws {
    let h = try Home(".local/bin/tmux")
    let mine = try Home("bin/tmux")
    let both: (String) -> Bool = { h.isExecutable($0) || mine.isExecutable($0) }
    #expect(TalosAppLocator.findTmux(envPath: mine.root + "/bin", home: h.root, isExecutable: both) == mine.root + "/bin/tmux")
    let none = try Home(nil)
    #expect(TalosAppLocator.findTmux(envPath: "/usr/bin:/bin", home: none.root, isExecutable: none.isExecutable) == nil)
  }

  @Test func theSetupChecklistLooksInTheSameFolders() {
    // PrereqProbe passes these as the folders after the login PATH
    let dirs = TalosAppLocator.tmuxFolders(home: "/home/alex")
    #expect(dirs.contains("/home/alex/.local/bin") && dirs.contains("/home/alex/.local/talos-tmux/bin"))
    #expect(dirs.contains("/opt/homebrew/bin"))
  }
}
