import AppKit
import Foundation
import Testing
import TalosDesktopCore

@testable import TalosDesktop

/// QuickCompose with the new anchor and thread parameters (DESKTOP-COMPANION-SPEC section 8). Needs TALOS_GUI_TESTS=1.
/// Nothing here calls `show()`, which would activate the app: `prepareShow` is everything `show` does before the window comes up.
@MainActor
@Suite("Companion compose", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct CompanionComposeGuiTests {
  func threadItem(_ id: String, _ name: String) -> [String: Any] { ["id": id, "name": name] }

  func signIn(_ list: [[String: Any]]) throws {
    _ = NSApplication.shared
    UserDefaults.standard.removeObject(forKey: QuickCompose.lastThreadKey)
    WebController.shared.nativeMessage(.ready(signedIn: true, features: []))
    WebController.shared.nativeMessage(try #require(WebToNative.decode(["type": "threads", "items": list])))
  }

  func setThreads(_ list: [[String: Any]]) throws {
    WebController.shared.nativeMessage(try #require(WebToNative.decode(["type": "threads", "items": list])))
  }

  func cleanUp() {
    QuickCompose.shared.resetForTest()
    UserDefaults.standard.removeObject(forKey: QuickCompose.lastThreadKey)
    if let none = WebToNative.decode(["type": "threads", "items": [[String: Any]]()]) { WebController.shared.nativeMessage(none) }
    WebController.shared.nativeMessage(.ready(signedIn: false, features: []))
  }

  func popup() throws -> NSPopUpButton {
    func find(_ v: NSView) -> NSPopUpButton? { (v as? NSPopUpButton) ?? v.subviews.lazy.compactMap(find).first }
    let root = try #require(QuickCompose.shared.contentViewForTest())
    return try #require(find(root))
  }

  @Test func aKeptDraftKeepsItsThreadWhenAnotherEntryPointPreselectsOne() throws {
    cannotTakeTheKeyboard()
    try signIn([threadItem("work", "Work"), threadItem("home", "Home")])
    defer {
      cleanUp()
      QuickCompose.shared.dropPreviousAppForTest()  // a stray hand-back must not activate whatever app was in front
    }
    UserDefaults.standard.set("work", forKey: QuickCompose.lastThreadKey)  // the last thread used is not the draft's
    QuickCompose.shared.resetForTest()
    QuickCompose.shared.prepareShow(thread: nil)  // builds and fills the panel; it is never put on screen
    QuickCompose.shared.dropPreviousAppForTest()
    QuickCompose.shared.pickThreadForTest("home")
    QuickCompose.shared.setTextForTest("a draft for Home")
    QuickCompose.shared.panelForTest?.cancelOperation(nil)  // Esc: the draft is kept, with its thread
    QuickCompose.shared.prepareShow(thread: "work")  // the pencil or a tray row asks for Work
    #expect(QuickCompose.shared.textForTest == "a draft for Home", "Esc keeps the words")
    #expect(QuickCompose.shared.pickedThreadForTest == "home", "a message must never go to a different thread than it was written for")
    #expect(QuickCompose.shared.statusForTest == "Keeping your draft for Home.")
    #expect(QuickCompose.shared.sendEnabledForTest)
  }

  @Test func pressingThePencilWhileComposeIsOpenWithATypedDraftDoesNotResetThePicker() throws {
    try signIn([threadItem("work", "Work"), threadItem("home", "Home")])
    defer { cleanUp() }
    let pop = try popup()  // the panel is up and visible
    pop.selectItem(withTitle: "Home")
    QuickCompose.shared.setTextForTest("typed, not yet Esc'd")
    QuickCompose.shared.prepareShow(thread: nil)  // every entry point calls show() on an open panel
    #expect(QuickCompose.shared.pickedThreadForTest == "home", "the picker stays where the draft was written")
    QuickCompose.shared.prepareShow(thread: "work")
    #expect(QuickCompose.shared.pickedThreadForTest == "home")
  }

  @Test func aTypedDraftWithNoRememberedThreadIsNeverRedirectedByARequest() throws {
    try signIn([threadItem("work", "Work"), threadItem("home", "Home")])
    defer { cleanUp() }
    QuickCompose.shared.resetForTest()
    QuickCompose.shared.setTextForTest("typed into a hidden panel")
    QuickCompose.shared.prepareShow(thread: "home")
    #expect(QuickCompose.shared.pickedThreadForTest == "work", "the request only applies to an empty field")
  }

  @Test func anEmptyFieldTakesTheRequestedThreadAndAnUnknownIdIsIgnored() throws {
    try signIn([threadItem("work", "Work"), threadItem("home", "Home")])
    defer { cleanUp() }
    QuickCompose.shared.prepareShow(thread: "home")
    #expect(QuickCompose.shared.pickedThreadForTest == "home")
    QuickCompose.shared.resetForTest()
    QuickCompose.shared.prepareShow(thread: "t_not_in_the_list")
    #expect(QuickCompose.shared.pickedThreadForTest == "work", "an id absent from threads can't be selected, let alone sent to")
  }

  @Test func aDraftWhoseThreadLeftTheListSelectsNothingAndSendIsOff() throws {
    try signIn([threadItem("work", "Work"), threadItem("home", "Home")])
    defer { cleanUp() }
    let pop = try popup()
    pop.selectItem(withTitle: "Home")
    QuickCompose.shared.setTextForTest("for a thread that goes away")
    QuickCompose.shared.toggle()
    try setThreads([threadItem("work", "Work")])  // Home is gone
    QuickCompose.shared.prepareShow(thread: nil)
    #expect(QuickCompose.shared.pickedThreadForTest == nil, "no fall-through to item 0")
    #expect(!QuickCompose.shared.sendEnabledForTest)
    #expect(QuickCompose.shared.statusForTest.hasPrefix("That thread is gone"))
  }

  @Test func theGoneThreadGuardHoldsOnASecondOpenOnAnOpenPanelAndAfterEsc() throws {
    try signIn([threadItem("work", "Work"), threadItem("home", "Home")])
    defer { cleanUp() }
    let pop = try popup()
    pop.selectItem(withTitle: "Home")
    QuickCompose.shared.setTextForTest("for a thread that goes away")
    QuickCompose.shared.toggle()  // Esc
    try setThreads([threadItem("work", "Work")])  // Home is gone
    QuickCompose.shared.prepareShow(thread: nil)  // the first open
    #expect(QuickCompose.shared.pickedThreadForTest == nil && !QuickCompose.shared.sendEnabledForTest)
    // The pencil or the menu asks again on the open panel: it must not fall through to item 0.
    QuickCompose.shared.panelForTest?.orderFrontRegardless()
    for _ in 0..<2 {
      QuickCompose.shared.prepareShow(thread: nil)
      #expect(QuickCompose.shared.pickedThreadForTest == nil, "still no thread picked")
      #expect(!QuickCompose.shared.sendEnabledForTest, "Send stays off")
      #expect(QuickCompose.shared.statusForTest.hasPrefix("That thread is gone"))
      #expect(QuickCompose.shared.textForTest == "for a thread that goes away", "the text is kept")
    }
    // Esc and reopen: the same.
    QuickCompose.shared.panelForTest?.orderOut(nil)
    QuickCompose.shared.prepareShow(thread: "work")  // an entry point asking for Work does not redirect a draft
    #expect(QuickCompose.shared.pickedThreadForTest == nil && !QuickCompose.shared.sendEnabledForTest)
    QuickCompose.shared.panelForTest?.orderOut(nil)
  }

  @Test func inTheGoneStateTypingKeepsTheExplanationAndPickingAThreadBringsSendBack() throws {
    try signIn([threadItem("work", "Work"), threadItem("home", "Home")])
    defer { cleanUp() }
    let pop = try popup()
    pop.selectItem(withTitle: "Home")
    QuickCompose.shared.setTextForTest("draft")
    QuickCompose.shared.toggle()
    try setThreads([threadItem("work", "Work")])
    QuickCompose.shared.prepareShow(thread: nil)
    #expect(QuickCompose.shared.threadGoneForTest)
    // Typing: the text view tells its delegate, and the explanation must not vanish while Send is off for it.
    QuickCompose.shared.textDidChange(Notification(name: NSText.didChangeNotification))
    #expect(QuickCompose.shared.statusForTest.hasPrefix("That thread is gone"))
    #expect(!QuickCompose.shared.sendEnabledForTest)
    // The owner picks a thread through the popup's own action.
    QuickCompose.shared.pickThreadForTest("work")
    #expect(QuickCompose.shared.pickedThreadForTest == "work")
    #expect(QuickCompose.shared.sendEnabledForTest, "a deliberate pick brings Send back")
    #expect(QuickCompose.shared.statusForTest.isEmpty)
    #expect(!QuickCompose.shared.threadGoneForTest)
    QuickCompose.shared.textDidChange(Notification(name: NSText.didChangeNotification))
    #expect(QuickCompose.shared.statusForTest.isEmpty)
  }

  @Test func composeAnchorsToHimOnlyWhenHeIsOnThePointersScreen() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let v = fx.screens[0].visibleFrame
    fx.pointer = CGPoint(x: v.midX, y: v.midY)
    let anchor = try #require(QuickCompose.shared.anchorProvider?())
    #expect(anchor == fx.controller.spritePanelForTest?.frame)
    let other = CompanionScreen(
      uuid: "TEST-B", frame: CGRect(x: v.maxX, y: v.minY, width: 800, height: 600), visibleFrame: CGRect(x: v.maxX, y: v.minY, width: 800, height: 600),
      isPrimary: false)
    fx.screens = [fx.screens[0], other]
    fx.pointer = CGPoint(x: other.frame.midX, y: other.frame.midY)  // the pointer is on another display
    #expect(QuickCompose.shared.anchorProvider?() == nil, "otherwise it centers as it does today")
    fx.turnOff()
    fx.pointer = CGPoint(x: v.midX, y: v.midY)
    #expect(QuickCompose.shared.anchorProvider?() == nil, "off: no anchor")
  }

  @Test func theAnchoredPanelOpensClearOfHimAndOnScreenWhereverHeStands() throws {
    try signIn([threadItem("work", "Work")])
    defer { cleanUp() }
    _ = try popup()
    let v = CGRect(x: 0, y: 40, width: 1440, height: 840)
    for origin in [CGPoint(x: 0, y: 40), CGPoint(x: 1344, y: 40), CGPoint(x: 0, y: 736), CGPoint(x: 1344, y: 736), CGPoint(x: 600, y: 400)] {
      let sprite = CGRect(origin: origin, size: CompanionPlacement.standardSize)
      let f = try #require(QuickCompose.shared.anchoredOriginForTest(sprite, visible: v))
      #expect(v.contains(f) && !f.intersects(sprite), "\(origin) -> \(f)")
    }
  }

  @Test func theControllerRaisesComposeActivityBeforeItOpens() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    #expect(QuickCompose.shared.onShown != nil, "opening compose keeps him awake")
    fx.controller.shutdown()
    #expect(QuickCompose.shared.onShown == nil && QuickCompose.shared.anchorProvider == nil, "shutdown unhooks compose")
  }
}
