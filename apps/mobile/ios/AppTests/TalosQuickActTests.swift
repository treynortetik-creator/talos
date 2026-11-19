import CryptoKit
import Foundation
import XCTest
@testable import TalosPushCore
import BridgeGuard
import TalosRelayCore

@testable import App

/// The Reply press, end to end through `TalosQuickAct.run` with the Keychain, the network and the clock replaced: what it reads,
/// what it sends and what it tells the owner, for a press on another relay's notification, on a relay that took an old relay's
/// place, on button data the extension did not make, and when the app moves on while the press is being signed.
final class TalosQuickActTests: XCTestCase {
    private let keyA = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"
    private let keyB = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB"
    private let keyHostile = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD"
    private let originA = URL(string: "https://a.example.com")!
    private let originB = URL(string: "https://b.example.com")!

    private struct Keys {
        let enc = P256.KeyAgreement.PrivateKey()
        let act = P256.Signing.PrivateKey()
        func grant(device: String) -> String {
            let osig = String(repeating: "A", count: 86)
            return """
            {"type":"native.grant","device_id":"\(device)","osig":"\(osig)","exp":"2099-01-01T00:00:00Z","scopes":["reply"],"enc_pub":"\(Base64URL.encode(enc.publicKey.x963Representation))","act_pub":"\(Base64URL.encode(act.publicKey.x963Representation))"}
            """
        }
    }

    /// Everything the press touched, and the stand-ins for the Keychain (one set of keys per key id), the active relay and the network.
    private final class Rig {
        var keychain: [String: Keys] = [:]
        var grants: [String: String] = [:]
        var active: [(keyId: String, origin: URL)?] = []   // each look at the active relay takes the next; the last one repeats
        var looks = 0
        var keyReads: [String] = []
        var posts: [(url: URL, body: Data)] = []
        var failures: [String] = []
        var finished = 0
        /// The pairings the trust check refuses (a failed pairing, or one not verified in the last 24 hours). Anything else is allowed.
        var untrusted: Set<String> = []
        /// When set, each look at the trust answers the next value (the last one repeats): a fail that lands in the middle of a press.
        var trustScript: [Bool]?
        var trustLooks = 0

        func env() -> TalosQuickAct.Env {
            TalosQuickAct.Env(
                activeRelay: { [unowned self] in
                    defer { looks += 1 }
                    return active[min(looks, active.count - 1)]
                },
                encKey: { [unowned self] id in keyReads.append("enc.\(id)"); return keychain[id]?.enc },
                actKey: { [unowned self] id in keyReads.append("act.\(id)"); return keychain[id]?.act },
                grant: { [unowned self] id in keyReads.append("grant.\(id)"); return grants[id] },
                post: { [unowned self] url, body, reply in posts.append((url, body)); reply(200, nil) },
                fail: { [unowned self] message, done in failures.append(message); done() },
                trusted: { [unowned self] id in
                    defer { trustLooks += 1 }
                    if let trustScript { return trustScript[min(trustLooks, trustScript.count - 1)] }
                    return !untrusted.contains(id)
                },
                now: { Date(timeIntervalSince1970: 1_800_000_000) },
                startBackgroundTask: { _ in {} },
                retryLater: { $0() })
        }
    }

    private func pair(_ rig: Rig, _ keyId: String) -> Keys {
        let keys = Keys()
        rig.keychain[keyId] = keys
        rig.grants[keyId] = keys.grant(device: "dev-\(keyId)")
        return keys
    }

    /// The button data the extension leaves on a Reply notification for the pairing `keyId`, with its MAC.
    private func buttonData(_ keyId: String, sealedWith keys: Keys, thread: String = "general") -> [AnyHashable: Any] {
        var rich = ["r": keyId, "t": thread, "shown": "sha256:x"]
        rich["m"] = RichPush.richMac(rich, key: keys.enc)
        return [RichPush.richKey: rich]
    }

    private func press(_ rig: Rig, _ userInfo: [AnyHashable: Any]) {
        TalosQuickAct.run(.reply, shown: RichPush.Shown(title: "Talos", subtitle: "", body: "x"), userInfo: userInfo,
                          userText: "on my way", env: rig.env(), done: { rig.finished += 1 })
    }

    private let anotherRelay = "That notification is from another relay. Open Talos."

    func testAPressOnTheActivePairingsOwnNotificationIsSignedAndSentToItsRelay() throws {
        let rig = Rig()
        let keys = pair(rig, keyA)
        rig.active = [(keyA, originA)]
        press(rig, buttonData(keyA, sealedWith: keys))
        XCTAssertEqual(rig.failures, [])
        XCTAssertEqual(rig.posts.count, 1)
        XCTAssertEqual(rig.posts.first?.url.absoluteString, "https://a.example.com/api/native/act")
        let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(rig.posts.first?.body)) as? [String: Any])
        XCTAssertEqual(frame["type"] as? String, "native.act")
        XCTAssertEqual(frame["device_id"] as? String, "dev-\(keyA)")
        XCTAssertEqual(rig.finished, 1)
    }

    func testAPressOnAFailedOrUnverifiedForADayPairingReadsNoKeySendsNothingAndSaysSo() {
        let rig = Rig()
        let keys = pair(rig, keyA)
        rig.active = [(keyA, originA)]
        rig.untrusted = [keyA]
        press(rig, buttonData(keyA, sealedWith: keys))
        XCTAssertEqual(rig.keyReads, [], "no Keychain read at all")
        XCTAssertTrue(rig.posts.isEmpty, "and nothing sent")
        XCTAssertEqual(rig.failures, ["Talos can't confirm your Mac. Open Talos."])
        XCTAssertEqual(rig.finished, 1)
    }

    func testAFailThatLandsWhileThePressIsBeingSignedStopsItBeforeThePost() {
        let rig = Rig()
        let keys = pair(rig, keyA)
        rig.active = [(keyA, originA)]
        rig.trustScript = [true, false]   // trusted at the start of the press, failed by the time it is signed
        press(rig, buttonData(keyA, sealedWith: keys))
        XCTAssertTrue(rig.posts.isEmpty, "nothing is sent")
        XCTAssertEqual(rig.failures, ["Talos can't confirm your Mac. Open Talos."])
        XCTAssertEqual(rig.trustLooks, 2, "looked at the start and again just before the post")
        XCTAssertEqual(rig.finished, 1)
    }

    func testTheTrustFactsQuickActReadsComeFromTheActivePairingsOwnProfile() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func profile(key: String, verified: Date?, failed: Bool = false) -> RelayProfile {
            RelayProfile(id: "r_abcdefghijklmnopqrst", origin: originA, kind: .self, label: "a", bridgeFp: String(repeating: "A", count: 43),
                         deviceId: "", dataStoreId: UUID(uuidString: key)!, addedAt: now, lastVerifiedAt: verified, attestFailed: failed)!
        }
        let fresh = now.addingTimeInterval(-3600)
        XCTAssertTrue(TalosQuickAct.trusts(profile: profile(key: keyA, verified: fresh), keyId: keyA, now: now))
        XCTAssertFalse(TalosQuickAct.trusts(profile: profile(key: keyA, verified: fresh, failed: true), keyId: keyA, now: now), "failed")
        XCTAssertFalse(TalosQuickAct.trusts(profile: profile(key: keyA, verified: now.addingTimeInterval(-25 * 3600)), keyId: keyA, now: now), "25 hours")
        XCTAssertFalse(TalosQuickAct.trusts(profile: profile(key: keyA, verified: now.addingTimeInterval(-24 * 3600)), keyId: keyA, now: now), "exactly 24 hours")
        XCTAssertFalse(TalosQuickAct.trusts(profile: profile(key: keyA, verified: nil), keyId: keyA, now: now), "never verified")
        XCTAssertFalse(TalosQuickAct.trusts(profile: profile(key: keyA, verified: now.addingTimeInterval(60)), keyId: keyA, now: now), "a future time")
        XCTAssertFalse(TalosQuickAct.trusts(profile: profile(key: keyB, verified: fresh), keyId: keyA, now: now), "another pairing's facts never count")
        XCTAssertFalse(TalosQuickAct.trusts(profile: nil, keyId: keyA, now: now), "no stored pairing")
        XCTAssertEqual(RelayProfile.trustWindow, RelayTrust.hardBlockAfter, "the screen and the button use the same 24 hours")
    }

    func testAPressOnAnotherRelaysNotificationReadsNoKeyAndSendsNothing() {
        let rig = Rig()
        let keysA = pair(rig, keyA)
        _ = pair(rig, keyB)
        rig.active = [(keyB, originB)]          // the app moved to B; the notification is A's
        press(rig, buttonData(keyA, sealedWith: keysA))
        XCTAssertEqual(rig.keyReads, [], "no Keychain read at all")
        XCTAssertTrue(rig.posts.isEmpty, "and nothing sent: the text never reaches B")
        XCTAssertEqual(rig.failures, [anotherRelay])
        XCTAssertEqual(rig.finished, 1)
    }

    func testARelayThatTookTheOldRelaysPlaceNeverGetsTheOldKeysOrGrant() {
        // The hostile relay claimed relay A's id, so the app now shows it as "the same relay". The phone gave it a new key id
        // when it was scanned, and A's keys were deleted. Even if A's keys were still in the Keychain, a press on A's
        // notification names A's key id, which is not the active pairing, so nothing is read or sent.
        let rig = Rig()
        let keysA = pair(rig, keyA)
        rig.active = [(keyHostile, originB)]
        press(rig, buttonData(keyA, sealedWith: keysA))
        XCTAssertEqual(rig.keyReads, [])
        XCTAssertTrue(rig.posts.isEmpty)
        XCTAssertEqual(rig.failures, [anotherRelay])
    }

    func testTheHostilePairingHasNoKeysOfItsOwnUntilItsPageMakesThem() {
        let rig = Rig()
        let keysA = pair(rig, keyA)
        rig.active = [(keyHostile, originB)]
        // a notification that claims the hostile pairing, made with A's seal key (all a hostile relay could attempt)
        press(rig, buttonData(keyHostile, sealedWith: keysA))
        XCTAssertTrue(rig.posts.isEmpty, "there are no keys under the hostile pairing's id, so nothing can be signed")
        XCTAssertFalse(rig.keyReads.contains("act.\(keyA)"), "A's action key is never read")
        XCTAssertFalse(rig.keyReads.contains("grant.\(keyA)"))
        XCTAssertEqual(rig.failures.count, 1)
    }

    func testButtonDataWithNoMacIsRefusedBeforeAnyActionKeyOrGrantIsRead() {
        let rig = Rig()
        _ = pair(rig, keyA)
        rig.active = [(keyA, originA)]
        // what a push that skipped the extension could carry: the right names, no MAC
        press(rig, [RichPush.richKey: ["r": keyA, "t": "general", "shown": "sha256:x"]])
        XCTAssertTrue(rig.posts.isEmpty)
        XCTAssertFalse(rig.keyReads.contains { $0.hasPrefix("act.") || $0.hasPrefix("grant.") })
        XCTAssertEqual(rig.failures.count, 1)
        XCTAssertEqual(rig.finished, 1)
    }

    func testButtonDataWithAForgedOrChangedMacIsRefused() {
        let rig = Rig()
        let keys = pair(rig, keyA)
        rig.active = [(keyA, originA)]
        // a MAC made with some other key
        press(rig, buttonData(keyA, sealedWith: Keys()))
        // a real MAC, but a field changed afterwards (the Reply is sent to another thread)
        var changed = buttonData(keyA, sealedWith: keys)
        var rich = changed[RichPush.richKey] as! [String: String]
        rich["t"] = "someone-elses-thread"
        changed[RichPush.richKey] = rich
        press(rig, changed)
        XCTAssertTrue(rig.posts.isEmpty)
        XCTAssertEqual(rig.failures.count, 2)
        XCTAssertFalse(rig.keyReads.contains { $0.hasPrefix("act.") || $0.hasPrefix("grant.") })
    }

    func testThePressIsNotSentIfTheAppMovedToAnotherRelayWhileItWasSigned() {
        let rig = Rig()
        let keys = pair(rig, keyA)
        _ = pair(rig, keyB)
        rig.active = [(keyA, originA), (keyB, originB)]   // A when the press starts, B just before it would be sent
        press(rig, buttonData(keyA, sealedWith: keys))
        XCTAssertTrue(rig.posts.isEmpty)
        XCTAssertEqual(rig.failures, [anotherRelay])
        XCTAssertEqual(rig.finished, 1)
    }

    func testAPairingWithNoGrantYetSaysButtonsAreOff() {
        let rig = Rig()
        let keys = pair(rig, keyA)
        rig.grants[keyA] = nil
        rig.active = [(keyA, originA)]
        press(rig, buttonData(keyA, sealedWith: keys))
        XCTAssertTrue(rig.posts.isEmpty)
        XCTAssertEqual(rig.failures, ["Notification buttons are off on this phone. Open Talos and tap Show message text."])
    }
}
