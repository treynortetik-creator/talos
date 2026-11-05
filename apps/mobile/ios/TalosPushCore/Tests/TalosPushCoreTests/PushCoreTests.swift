import XCTest
import UserNotifications
@testable import TalosPushCore

final class PushCoreTests: XCTestCase {
    func testHexIsLowercaseAndFullLength() {
        XCTAssertEqual(PushCore.hex(Data([0x00, 0xAB, 0xFF, 0x0A])), "00abff0a")
        XCTAssertEqual(PushCore.hex(Data(repeating: 0xAB, count: 32)), String(repeating: "ab", count: 32))
        XCTAssertEqual(PushCore.hex(Data()), "")
    }

    private func profile(_ env: String?) -> Data {
        var body = "\u{1}\u{2}binary<?xml?><plist><dict><key>Name</key><string>x</string>"
        if let env { body += "<key>Entitlements</key><dict><key>aps-environment</key><string>\(env)</string></dict>" }
        return Data((body + "</dict></plist>\u{3}").utf8)
    }

    func testEnvironmentFollowsHowTheBuildWasSigned() {
        XCTAssertEqual(PushCore.environment(provisioningProfile: profile("development")), "sandbox")
        XCTAssertEqual(PushCore.environment(provisioningProfile: profile("production")), "production")
        // no profile (App Store), no aps entry, or garbage: production
        XCTAssertEqual(PushCore.environment(provisioningProfile: nil), "production")
        XCTAssertEqual(PushCore.environment(provisioningProfile: profile(nil)), "production")
        XCTAssertEqual(PushCore.environment(provisioningProfile: Data([0xff, 0x00, 0xfe])), "production")
        XCTAssertEqual(PushCore.environment(provisioningProfile: Data()), "production")
        XCTAssertEqual(PushCore.environment(provisioningProfile: Data("<key>aps-environment</key>".utf8)), "production")
    }

    func testCapabilityFollowsTheProfile() {
        XCTAssertTrue(PushCore.hasPushEntitlement(provisioningProfile: profile("development")))
        XCTAssertTrue(PushCore.hasPushEntitlement(provisioningProfile: profile("production")))
        XCTAssertFalse(PushCore.hasPushEntitlement(provisioningProfile: profile(nil))) // a free Personal Team
        XCTAssertTrue(PushCore.hasPushEntitlement(provisioningProfile: nil)) // App Store installs carry no profile
    }

    func testOnlyApproveNeedsTheDeviceUnlocked() {
        XCTAssertTrue(PushCore.approveButton.requiresAuthentication)
        XCTAssertFalse(PushCore.openButton.requiresAuthentication)
    }

    func testAnOpenReferenceIsAnInAppPath() {
        XCTAssertEqual(PushCore.navigatePath(["talos": ["navigate": "/open/r_AbC-123_xYz45678"]]), "/open/r_AbC-123_xYz45678")
    }

    func testOnlyAMissingEntitlementIsReportedAsUnavailable() {
        XCTAssertEqual(PushCore.registrationFailureCode(domain: "NSCocoaErrorDomain", code: 3000), "unavailable")
        XCTAssertEqual(PushCore.registrationFailureCode(domain: "NSCocoaErrorDomain", code: 3010), "failed")
        XCTAssertEqual(PushCore.registrationFailureCode(domain: "NSURLErrorDomain", code: -1009), "failed")
        XCTAssertEqual(PushCore.registrationFailureCode(domain: "x", code: 3000), "failed")
    }

    func testCategoriesMatchTheRelaysAndOnlyCardsHaveApprove() {
        XCTAssertEqual(PushCore.categories.map(\.identifier), ["TALOS_OPEN", "TALOS_CARD", "TALOS_REPLY", "TALOS_CARD_LOW"])
        XCTAssertEqual(PushCore.categories[0].buttons.map(\.title), ["Open"])
        XCTAssertEqual(PushCore.categories[1].buttons.map(\.title), ["Open", "Approve"])
        XCTAssertEqual(PushCore.categories[2].buttons.map(\.title), ["Open", "Reply"])
        XCTAssertEqual(PushCore.categories[3].buttons.map(\.title), ["Open", "Approve"])
    }

    func testQuickButtonsActInTheBackgroundAndNeedTheUnlockedPhone() {
        for b in [PushCore.replyButton, PushCore.approveLowButton] {
            XCTAssertFalse(b.opensApp, b.title)
            XCTAssertTrue(b.requiresAuthentication, b.title)
        }
        XCTAssertTrue(PushCore.replyButton.takesText)
        XCTAssertFalse(PushCore.approveLowButton.takesText)
        // the page never hears them; the app does the work
        XCTAssertEqual(PushCore.quickAction(identifier: "TALOS_ACT_REPLY"), .reply)
        XCTAssertEqual(PushCore.quickAction(identifier: "TALOS_ACT_APPROVE_LOW"), .approveLow)
        XCTAssertNil(PushCore.quickAction(identifier: "TALOS_ACT_APPROVE"))
        XCTAssertNil(PushCore.actionName(identifier: "TALOS_ACT_REPLY", defaultIdentifier: "d", dismissIdentifier: "x"))
        XCTAssertNil(PushCore.actionName(identifier: "TALOS_ACT_APPROVE_LOW", defaultIdentifier: "d", dismissIdentifier: "x"))
    }

    func testButtonsAndDefaultTapAreNamedForThePage() {
        let d = "default", x = "dismiss"
        XCTAssertEqual(PushCore.actionName(identifier: d, defaultIdentifier: d, dismissIdentifier: x), "open")
        XCTAssertEqual(PushCore.actionName(identifier: "TALOS_ACT_OPEN", defaultIdentifier: d, dismissIdentifier: x), "open")
        XCTAssertEqual(PushCore.actionName(identifier: "TALOS_ACT_APPROVE", defaultIdentifier: d, dismissIdentifier: x), "approve")
        // dismissing is not an action, and an identifier we never registered is not one either
        XCTAssertNil(PushCore.actionName(identifier: x, defaultIdentifier: d, dismissIdentifier: x))
        XCTAssertNil(PushCore.actionName(identifier: "TALOS_ACT_DELETE_EVERYTHING", defaultIdentifier: d, dismissIdentifier: x))
        XCTAssertNil(PushCore.actionName(identifier: "", defaultIdentifier: d, dismissIdentifier: x))
    }

    private func info(_ navigate: Any?) -> [AnyHashable: Any] { ["talos": ["navigate": navigate as Any]] }

    func testOnlyPlainInAppPathsOpen() {
        for ok in ["/", "/t/general", "/card/c_01JBF3V7Q8K2M4N6P8R0S2T4V6", "/settings/health", "/schedules", "/t/inbox?x=1"] {
            XCTAssertEqual(PushCore.navigatePath(info(ok)), ok, ok)
        }
    }

    func testForgedOrMalformedPathsOpenNothing() {
        let bad: [Any?] = [
            "//evil.example", "https://evil.example/x", "javascript:alert(1)", "talos://x", "evil", "", "\\\\x",
            "/api/devices", "/media/abc", "/bridge", "/hook/x", "/ws", "/%6dedia/x", "/%61pi/x", "/%256dedia/x", "/%2F%2Fevil",
            "/a b", "/a\nb", "/" + String(repeating: "a", count: 600), 42, nil,
        ]
        for b in bad { XCTAssertNil(PushCore.navigatePath(info(b)), "\(String(describing: b))") }
        XCTAssertNil(PushCore.navigatePath([:]))
        XCTAssertNil(PushCore.navigatePath(["talos": "nope"]))
        XCTAssertNil(PushCore.navigatePath(["aps": ["alert": "x"]]))
    }

    func testPathsThatMerelyStartWithABlockedWordAreFine() {
        XCTAssertEqual(PushCore.navigatePath(info("/apiary")), "/apiary")
        XCTAssertEqual(PushCore.navigatePath(info("/t/media")), "/t/media")
    }

    func testAPushForTheThreadOnScreenStaysQuietInTheOpenApp() {
        let general: [AnyHashable: Any] = ["talos": ["thread_id": "general", "kind": "reply"]]
        XCTAssertTrue(PushCore.suppressInForeground(general, viewing: "general"))
        XCTAssertFalse(PushCore.suppressInForeground(general, viewing: "inbox"))
        XCTAssertFalse(PushCore.suppressInForeground(general, viewing: nil))
        XCTAssertFalse(PushCore.suppressInForeground(general, viewing: ""))
        // an opaque Apple payload names no thread: it always shows
        XCTAssertFalse(PushCore.suppressInForeground(["talos": ["kind": "reply"]], viewing: "general"))
        XCTAssertFalse(PushCore.suppressInForeground([:], viewing: "general"))
    }

    func testANamedThreadOnScreenStaysQuietByItsReference() {
        // Apple's payload for a named thread has no talos.thread_id, only the opaque ref in aps.thread-id
        let named: [AnyHashable: Any] = ["aps": ["thread-id": "thread:r_AbCdEfGhIjKlMnOp"], "talos": ["kind": "reply", "navigate": "/open/r_AbCdEfGhIjKlMnOp"]]
        XCTAssertTrue(PushCore.suppressInForeground(named, viewing: "r_AbCdEfGhIjKlMnOp"))
        XCTAssertFalse(PushCore.suppressInForeground(named, viewing: "r_ZzZzZzZzZzZzZzZz"))
        XCTAssertFalse(PushCore.suppressInForeground(named, viewing: "general"))
        // the viewing key must be the whole tag, not a prefix of it
        XCTAssertFalse(PushCore.suppressInForeground(named, viewing: "r_AbCdEf"))
        // a card's push carries card:<id>, never a thread tag, so a viewed thread does not silence it
        let card: [AnyHashable: Any] = ["aps": ["thread-id": "card:c_01"], "talos": ["kind": "card"]]
        XCTAssertFalse(PushCore.suppressInForeground(card, viewing: "c_01"))
    }

    func testClearDeliveredTakesOnlyTheNamedThreadsAndCards() {
        let delivered: [(identifier: String, threadIdentifier: String)] = [
            ("a", "thread:general"), ("b", "thread:r_AbCdEfGhIjKlMnOp"), ("c", "card:c_01"), ("d", ""), ("e", "thread:inbox"),
        ]
        XCTAssertEqual(PushCore.identifiersToClear(delivered: delivered, tags: ["thread:r_AbCdEfGhIjKlMnOp", "card:c_01"]), ["b", "c"])
        XCTAssertEqual(PushCore.identifiersToClear(delivered: delivered, tags: ["thread:general"]), ["a"])
        // nothing named, nothing removed; a blank tag never sweeps up a notification that has no thread
        XCTAssertEqual(PushCore.identifiersToClear(delivered: delivered, tags: []), [])
        XCTAssertEqual(PushCore.identifiersToClear(delivered: delivered, tags: [""]), [])
        // at most 50 tags are honoured
        let many = (0..<60).map { "thread:x\($0)" } + ["thread:general"]
        XCTAssertEqual(PushCore.identifiersToClear(delivered: delivered, tags: many), [])
    }

    func testOnlyNotificationsMarkedAsShowingTextAreNamed() {
        let delivered: [(identifier: String, userInfo: [AnyHashable: Any])] = [
            ("a", ["talos": ["kind": "reply"], PushCore.textMarkerKey: PushCore.textMarkerValue]),
            ("b", ["talos": ["kind": "reply"]]),  // fixed phrase: no marker
            ("c", [PushCore.textMarkerKey: "0"]),  // a wrong value is not the marker
            ("d", [PushCore.textMarkerKey: true]),  // nor is a different type
            ("e", [:]),
            ("f", [PushCore.textMarkerKey: PushCore.textMarkerValue]),
        ]
        XCTAssertEqual(PushCore.identifiersShowingText(delivered: delivered), ["a", "f"])
        XCTAssertEqual(PushCore.identifiersShowingText(delivered: []), [])
    }
}

// MARK: - what iOS is told about each button, and what sign-out removes

final class PushCoreIosWiringTests: XCTestCase {
    private func actions(_ category: String) -> [UNNotificationAction] {
        PushCore.notificationCategories().first { $0.identifier == category }?.actions ?? []
    }

    func testEveryButtonThatNeedsAnUnlockedPhoneAsksIosForOne() {
        // Built the way the app builds them (the real UNNotificationAction values), not read off the model flag.
        var checked = 0
        for category in PushCore.categories {
            for button in category.buttons where button.requiresAuthentication {
                let built = actions(category.identifier).first { $0.identifier == button.identifier }
                XCTAssertNotNil(built, button.identifier)
                XCTAssertTrue(built?.options.contains(.authenticationRequired) ?? false, "\(category.identifier)/\(button.identifier) works on a locked phone")
                checked += 1
            }
        }
        XCTAssertGreaterThanOrEqual(checked, 3, "Approve, Reply and the low-risk Approve")
    }

    func testReplyAndLowRiskApproveNeedAnUnlockAndStayInTheBackground() {
        for (category, id) in [(RichPush.replyCategory, RichPush.replyActionId), (RichPush.cardLowCategory, RichPush.approveLowActionId)] {
            let built = actions(category).first { $0.identifier == id }
            XCTAssertNotNil(built, id)
            XCTAssertTrue(built?.options.contains(.authenticationRequired) ?? false, id)
            XCTAssertFalse(built?.options.contains(.foreground) ?? true, "\(id) must not bring the app forward")
        }
    }

    func testReplyIsATextButtonAndOpenOpensTheApp() {
        XCTAssertTrue(actions(RichPush.replyCategory).first { $0.identifier == RichPush.replyActionId } is UNTextInputNotificationAction)
        XCTAssertTrue(actions("TALOS_OPEN").first?.options.contains(.foreground) ?? false)
        XCTAssertFalse(actions("TALOS_OPEN").first?.options.contains(.authenticationRequired) ?? true)
    }

    func testSignOutDeletesEveryKeychainItemTheNotificationsUse() {
        var deleted: [String] = []
        PushCore.deleteNotificationSecrets { deleted.append($0) }
        XCTAssertEqual(Set(deleted), ["enc", "act", "grant"])
        XCTAssertEqual(deleted.count, 3)
    }

    func testSignOutTakesOnlyOpenedWordsOffTheScreen() {
        let delivered: [(identifier: String, userInfo: [AnyHashable: Any])] = [
            ("a", [PushCore.textMarkerKey: PushCore.textMarkerValue]),
            ("b", [:]),
            ("c", [PushCore.textMarkerKey: "0"]),
            ("d", [PushCore.textMarkerKey: PushCore.textMarkerValue]),
        ]
        XCTAssertEqual(PushCore.identifiersShowingText(delivered: delivered), ["a", "d"])
    }
}
