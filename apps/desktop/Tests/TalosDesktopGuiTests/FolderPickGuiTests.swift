import AppKit
import Foundation
import Testing
import TalosDesktopCore
import WebKit
@testable import TalosDesktop

/// `pick_folder` in the Talos window: the message handler runs the Mac's open panel (here a stand-in, so no panel is shown) and
/// tells the page what the owner chose. Nothing is saved here: the page saves it through the checked thread patch.
extension GuiSerial {
@MainActor
@Suite("Folder pick (window)", .serialized, .enabled(if: guiTestsEnabled))
struct FolderPickGuiTests {
  func page(signedIn: Bool = true) -> WebController {
    let c = WebController()
    c.useWebViewForTest(WKWebView(frame: CGRect(x: 0, y: 0, width: 800, height: 600), configuration: WKWebViewConfiguration()), windowVisible: true)
    c.nativeMessage(.ready(signedIn: signedIn, features: []))
    return c
  }

  @Test func theOwnersChoiceGoesBackToThePageWithTheRequestId() {
    let c = page()
    var seen: [FolderPanelSpec] = []
    c.folderPanel = { spec in seen.append(spec); return "/Users/alex/Projects" }
    var told: [NativeToWeb] = []
    c.deliveredForTest = { told.append($0) }
    c.nativeMessage(.pickFolder(req: "r12", start: nil))
    #expect(told == [.folderPicked(req: "r12", path: "/Users/alex/Projects")])
    #expect(seen.count == 1 && seen[0].canChooseDirectories && !seen[0].canChooseFiles && !seen[0].canCreateDirectories)
  }

  @Test func cancellingTheMacsPanelAnswersNull() {
    let c = page()
    c.folderPanel = { _ in nil }
    var told: [NativeToWeb] = []
    c.deliveredForTest = { told.append($0) }
    c.nativeMessage(.pickFolder(req: "r12", start: "/Users/alex"))
    #expect(told == [.folderPicked(req: "r12", path: nil)])
  }

  @Test func aSignedOutPageGetsNoPanelAndIsToldNotNow() {
    let c = page(signedIn: false)
    var asked = 0
    c.folderPanel = { _ in asked += 1; return "/Users/alex" }
    var told: [NativeToWeb] = []
    c.deliveredForTest = { told.append($0) }
    c.nativeMessage(.pickFolder(req: "r12", start: nil))
    #expect(asked == 0)
    #expect(told == [.folderPicked(req: "r12", path: nil, why: .notNow)])
  }

  @Test func aNameTheAppCannotUseIsSaidSoNotTakenForCancelling() {
    let c = page()
    c.folderPanel = { _ in "/Users/alex/bad\u{7}name" }
    var told: [NativeToWeb] = []
    c.deliveredForTest = { told.append($0) }
    c.nativeMessage(.pickFolder(req: "r12", start: nil))
    #expect(told == [.folderPicked(req: "r12", path: nil, why: .badName)])
  }

  @Test func aSecondRequestWhileOneIsOpenIsRefusedNotStacked() {
    let c = page()
    var asked = 0
    var inner: (() -> Void)?
    c.folderPanel = { _ in
      asked += 1
      inner?()
      return "/Users/alex"
    }
    inner = { c.nativeMessage(.pickFolder(req: "r13", start: nil)) }
    var told: [NativeToWeb] = []
    c.deliveredForTest = { told.append($0) }
    c.nativeMessage(.pickFolder(req: "r12", start: nil))
    #expect(asked == 1)
    #expect(told.contains(.folderPicked(req: "r13", path: nil, why: .notNow)))
  }
}
}
