import Foundation
import Security
import XCTest
@testable import TalosPushCore

@testable import App

/// Runs inside the real app on the simulator, against the real Keychain. These are the parts the Swift packages cannot reach
/// because they import Security with the app's access group: key creation, saving a grant, and what sign-out leaves behind.
final class NativeKeyStoreTests: XCTestCase {
    override func setUp() { NativeKeyStore.clearAll() }
    override func tearDown() { NativeKeyStore.clearAll() }

    private func grant(enc: String, act: String) -> String {
        let osig = String(repeating: "A", count: 86)
        return """
        {"type":"native.grant","device_id":"dev1","osig":"\(osig)","exp":"2099-01-01T00:00:00Z","scopes":["reply"],"enc_pub":"\(enc)","act_pub":"\(act)"}
        """
    }

    func testTheBuildCarriesAKeychainGroupAndKeysAreMadeOnce() throws {
        XCTAssertNotNil(NativeKeyStore.group(), "TalosKeychainGroup is in the app's Info.plist")
        let first = try NativeKeyStore.ensureKeys()
        let second = try NativeKeyStore.ensureKeys()
        XCTAssertEqual(first.encPub, second.encPub, "the second call reads the keys the first made")
        XCTAssertEqual(first.actPub, second.actPub)
        XCTAssertNotNil(NativeKeyStore.encKey())
        XCTAssertNotNil(NativeKeyStore.actKey())
    }

    func testAGrantThatNamesOtherKeysIsNotKept() throws {
        _ = try NativeKeyStore.ensureKeys()
        XCTAssertFalse(try NativeKeyStore.saveGrant(grant(enc: "other", act: "other")))
        XCTAssertNil(NativeKeyStore.grant())
    }

    func testSignOutLeavesNoKeyAndNoGrantInTheKeychain() throws {
        let keys = try NativeKeyStore.ensureKeys()
        XCTAssertTrue(try NativeKeyStore.saveGrant(grant(enc: keys.encPub, act: keys.actPub)))
        XCTAssertNotNil(NativeKeyStore.grant())

        NativeKeyStore.clearAll()

        XCTAssertNil(NativeKeyStore.encKey())
        XCTAssertNil(NativeKeyStore.actKey())
        XCTAssertNil(NativeKeyStore.grant())
        // and a new Turn on makes NEW keys, not the old ones
        let again = try NativeKeyStore.ensureKeys()
        XCTAssertNotEqual(again.encPub, keys.encPub)
    }
}
