import Foundation
import Testing
@testable import TalosDesktopCore

/// `pick_folder` / `folder_picked`: the Talos window's own open panel for a thread's folder. The page is the less trusted side;
/// the panel is always the same (folders only, nothing created) and what it returns is only an absolute path for the page to
/// save through the usual checked patch.
@Suite("Folder pick messages")
struct FolderPickTests {
  @Test func aRequestIdAndAnOptionalAbsoluteStartDecode() {
    #expect(WebToNative.decode(["type": "pick_folder", "req": "r12"]) == .pickFolder(req: "r12", start: nil))
    #expect(
      WebToNative.decode(["type": "pick_folder", "req": "r12", "start": "/Users/alex/Projects"])
        == .pickFolder(req: "r12", start: "/Users/alex/Projects"))
  }

  @Test func anythingElseIsRefusedNotIgnored() {
    #expect(WebToNative.decode(["type": "pick_folder"]) == nil)
    #expect(WebToNative.decode(["type": "pick_folder", "req": ""]) == nil)
    #expect(WebToNative.decode(["type": "pick_folder", "req": "has space"]) == nil)
    #expect(WebToNative.decode(["type": "pick_folder", "req": "r12", "start": "Projects"]) == nil)
    #expect(WebToNative.decode(["type": "pick_folder", "req": "r12", "start": "/a\u{0}b"]) == nil)
    #expect(WebToNative.decode(["type": "pick_folder", "req": "r12", "files": true]) == nil)
    #expect(WebToNative.decode(["type": "pick_folder", "req": "r12", "canChooseFiles": true]) == nil)
  }

  @Test func theAnswerCarriesTheRequestAndAnAbsolutePathOrNull() {
    let ok = NativeToWeb.folderPicked(req: "r12", path: "/Users/alex/Projects")
    #expect(ok.object["type"] as? String == "folder_picked")
    #expect(ok.object["req"] as? String == "r12")
    #expect(ok.object["path"] as? String == "/Users/alex/Projects")
    #expect(ok.javascript() != nil)
    let cancelled = NativeToWeb.folderPicked(req: "r12", path: nil)
    #expect(cancelled.object["path"] is NSNull)
    #expect(cancelled.javascript() != nil)
  }

  @Test func theAnswerIsOnlyBuiltWhenItPassesThePagesOwnRules() {
    #expect(NativeToWeb.validated(.folderPicked(req: "r12", path: "relative/dir")) == nil)
    #expect(NativeToWeb.validated(.folderPicked(req: "r12", path: "/a\u{0}b")) == nil)
    #expect(NativeToWeb.validated(.folderPicked(req: "r12", path: "/a\nb")) == nil)
    #expect(NativeToWeb.validated(.folderPicked(req: "bad req", path: "/Users/alex")) == nil)
    #expect(NativeToWeb.validated(.folderPicked(req: "r12", path: "/" + String(repeating: "a", count: 600))) == nil)
    #expect(NativeToWeb.validated(.folderPicked(req: "r12", path: nil)) != nil)
  }

  @Test func theAnswerCanSayWhyNothingWasChosen() {
    let notNow = NativeToWeb.folderPicked(req: "r12", path: nil, why: .notNow)
    #expect(notNow.object["why"] as? String == "not_now")
    #expect(notNow.javascript() != nil)
    #expect(NativeToWeb.folderPicked(req: "r12", path: nil, why: .badName).object["why"] as? String == "bad_name")
    #expect(NativeToWeb.folderPicked(req: "r12", path: nil).object["why"] == nil)
    // a path and a reason together is nonsense and is not built
    #expect(NativeToWeb.validated(.folderPicked(req: "r12", path: "/Users/alex", why: .notNow)) == nil)
  }

  @Test func theOpenPanelOnlyChoosesOneFolderAndCreatesNothing() {
    let s = FolderPanelSpec.make(start: nil, home: "/Users/alex")
    #expect(s.canChooseDirectories)
    #expect(!s.canChooseFiles)
    #expect(!s.canCreateDirectories)
    #expect(!s.allowsMultipleSelection)
    #expect(s.directory == "/Users/alex")
    #expect(FolderPanelSpec.make(start: "/Users/alex/Projects", home: "/Users/alex").directory == "/Users/alex/Projects")
  }

  @Test func theUserAgentTellsThePageWhichShellFeaturesThisMacAppHas() {
    let name = WebPolicy.userAgentApplicationName(version: "1.2.3")
    #expect(name.hasPrefix("TalosDesktop/1.2.3"))
    #expect(name.contains("TalosFeatures/pick-folder"))
    #expect(WebPolicy.userAgentSuffix(version: "1.2.3") == "TalosDesktop/1.2.3")
  }
}
