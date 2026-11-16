import XCTest

/// Drives the real iPhone shell on a simulator, against the composer fixture page (apps/mobile/ui-test, started by
/// apps/mobile/scripts/ui-test.sh). The system pickers are the real ones: PHPicker and the document picker, both reached through the
/// shell's TalosPicker plugin. The library is seeded with two PNGs (talos-ui-red, talos-ui-blue) and "On My iPhone" with
/// talos-ui-note.txt by the script; the test fails with a clear message if the seed is missing.
final class PickerUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        XCTAssertTrue(plus.waitForExistence(timeout: 30), "the fixture composer did not load: is ui-test.sh's server up?\n\(app.debugDescription)")
    }

    // MARK: lookups (the page's elements surface as "Other" in the web view, so match on the accessibility label)

    private func any(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: label).firstMatch
    }

    private var plus: XCUIElement { any("Attach") }
    private var box: XCUIElement { app.textViews["Message"].firstMatch }
    private var attachmentCount: XCUIElement { app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Attachments: '")).firstMatch }

    private func waitForAttachments(_ n: Int) {
        let done = NSPredicate(format: "label == %@", "Attachments: \(n)")
        let result = XCTWaiter().wait(for: [expectation(for: done, evaluatedWith: attachmentCount)], timeout: 20)
        XCTAssertEqual(result, .completed, "expected \(n) attachment(s), the page says '\(attachmentCount.label)'\n\(app.debugDescription)")
    }

    private func openMenu() {
        plus.tap()
        XCTAssertTrue(any("Photo library").waitForExistence(timeout: 5), "the + menu did not open")
    }

    private func tapWhenReady(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 20) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(what) did not appear\n\(app.debugDescription)")
        element.tap()
    }

    /// After a picker is dismissed the composer must be usable: + opens the menu again and the box takes typing.
    private func assertComposerUsable(_ message: String) {
        // The page refocuses the box once the picker is over, which raises the keyboard; type into it.
        XCTAssertTrue(box.waitForExistence(timeout: 10), "\(message): no message box")
        box.tap()
        let word = "hello\(Int.random(in: 100...999))"
        box.typeText(word)
        XCTAssertEqual(box.value as? String, word, "\(message): the box did not take input")
        // + works again: its menu opens, then it is closed with a second tap.
        openMenu()
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "Attach menu").count, 1, "\(message): + did not give exactly one menu")
        plus.tap()
        XCTAssertTrue(app.buttons["Photo library"].waitForNonExistence(timeout: 5), "\(message): + did not close the menu")
    }

    // MARK: 1. the + menu

    func testPlusShowsExactlyOneMenuWithThreeChoices() {
        XCTAssertFalse(any("Photo library").exists, "the menu is open before + was tapped")
        openMenu()
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "Attach menu").count, 1, "more or fewer than one menu")
        for label in ["Photo library", "Camera", "Files"] {
            XCTAssertEqual(app.buttons.matching(identifier: label).count, 1, "\(label) should appear exactly once")
        }
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label IN {'Photo library','Camera','Files'}")).count, 3)
        // iOS's own attach sheet (Take Photo or Video / Choose File) must not sit on top of ours.
        XCTAssertEqual(app.sheets.count, 0)
        XCTAssertEqual(app.popovers.count, 0)
        XCTAssertFalse(app.buttons["Take Photo or Video"].exists)
        XCTAssertFalse(app.buttons["Choose File"].exists)
    }

    // MARK: 2. photos

    func testPhotosPicksTwoImagesAndBothReachTheComposer() {
        openMenu()
        any("Photo library").tap()
        let cells = app.images.matching(identifier: "PXGGridLayout-Info")
        XCTAssertTrue(cells.firstMatch.waitForExistence(timeout: 20), "the photo picker showed no photos (is the simulator library seeded?)\n\(app.debugDescription)")
        // Newest first: the two PNGs the script added last.
        cells.element(boundBy: 0).tap()
        cells.element(boundBy: 1).tap()
        tapWhenReady(app.buttons.matching(NSPredicate(format: "label IN {'Add','Done'}")).firstMatch, "the picker's Add button")
        waitForAttachments(2)
        let items = app.staticTexts.matching(NSPredicate(format: "label CONTAINS ' | image/'"))
        XCTAssertEqual(items.count, 2, "each attachment should be listed with an image mime type")
        XCTAssertNotEqual(items.element(boundBy: 0).label, items.element(boundBy: 1).label, "the two attachments should be different files")
        // Done: the system picker is gone and the composer is usable.
        XCTAssertFalse(app.images["PXGGridLayout-Info"].exists)
    }

    // MARK: 3. files

    func testFilesOpensTheDocumentPickerWithoutPhotosAndReturnsTheSeededFile() {
        openMenu()
        any("Files").tap()
        tapWhenReady(app.buttons["Browse"], "the document picker's Browse tab")
        // The document picker is not the photo picker: no Photos source and no photo grid.
        XCTAssertFalse(app.images["PXGGridLayout-Info"].exists, "the photo picker opened instead of the document picker")
        XCTAssertFalse(app.staticTexts["Photos"].exists, "the document picker offers Photos")
        tapWhenReady(app.staticTexts["On My iPhone"].firstMatch, "'On My iPhone'")
        tapWhenReady(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'talos-ui-note'")).firstMatch,
                     "the seeded file talos-ui-note.txt (is 'On My iPhone' seeded?)")
        if app.buttons["Open"].waitForExistence(timeout: 3) { app.buttons["Open"].tap() }
        waitForAttachments(1)
        let item = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'talos-ui-note.txt | text/plain | 19 bytes'")).firstMatch
        XCTAssertTrue(item.exists, "the file should arrive with its name, type and size\n\(app.debugDescription)")
    }

    // MARK: 4. dismissing leaves the composer usable

    func testDismissingThePhotoPickerLeavesTheComposerUsable() {
        openMenu()
        any("Photo library").tap()
        tapWhenReady(app.buttons["Cancel"].firstMatch, "the photo picker's Cancel")
        XCTAssertTrue(app.buttons["Cancel"].waitForNonExistence(timeout: 10), "the photo picker is still up")
        XCTAssertEqual(attachmentCount.label, "Attachments: 0")
        assertComposerUsable("after cancelling the photo picker")
    }

    func testDismissingTheDocumentPickerLeavesTheComposerUsable() {
        openMenu()
        any("Files").tap()
        tapWhenReady(app.buttons["Cancel"].firstMatch, "the document picker's Cancel")
        XCTAssertTrue(app.buttons["Browse"].waitForNonExistence(timeout: 10), "the document picker is still up")
        XCTAssertEqual(attachmentCount.label, "Attachments: 0")
        assertComposerUsable("after cancelling the document picker")
    }

    // MARK: 5. camera

    func testCameraButtonExists() {
        // A simulator has no camera, so the button is only checked to be there (and to say so rather than crash when tapped
        // is the shell's job, covered by the page's error line, not asserted here).
        openMenu()
        XCTAssertTrue(app.buttons["Camera"].exists)
    }
}
