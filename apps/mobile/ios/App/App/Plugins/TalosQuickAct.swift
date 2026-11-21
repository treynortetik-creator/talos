import CryptoKit
import Foundation
import TalosPushCore
import TalosRelayCore
import UIKit
import UserNotifications

/// Reply and Approve from a notification button. iOS wakes the app in the background for these (they do not bring it forward);
/// this signs the action with the key in the shared Keychain and posts it to the active relay's origin (SharedRelayOrigin). There is
/// no web page involved and no cookie: the credential is the signature chain (device key, grant, action key).
///
/// Nothing is ever shown as sent that was not accepted: a refusal or a failure after one retry becomes a notification that
/// says what to do, with no message text in it. The id is made once per press and reused by the retry, so the relay answers
/// "done" at most once for it.
///
/// A press acts only for the pairing that is active now, and only on button data the notification extension made (it carries a
/// MAC the active pairing's seal key checks). Both are checked before anything is signed or sent; the first, before any key is read.
enum TalosQuickAct {
    /// Everything a press touches outside itself, so a test can stand in for the Keychain, the network and the clock.
    struct Env {
        /// The pairing the app is on now: its key id (names its Keychain items) and the origin its frame goes to.
        var activeRelay: () -> (keyId: String, origin: URL)?
        var encKey: (_ keyId: String) -> P256.KeyAgreement.PrivateKey?
        var actKey: (_ keyId: String) -> P256.Signing.PrivateKey?
        var grant: (_ keyId: String) -> String?
        var post: (_ url: URL, _ body: Data, _ reply: @escaping (Int?, String?) -> Void) -> Void
        var fail: (_ message: String, _ done: @escaping () -> Void) -> Void
        /// Whether this pairing may act: its last check did not fail and it was verified less than 24 hours ago (read from its stored profile).
        var trusted: (_ keyId: String) -> Bool
        var now: () -> Date
        /// Asks iOS for background time; `expired` runs if it runs out. Returns what ends the task.
        var startBackgroundTask: (_ expired: @escaping () -> Void) -> () -> Void
        var retryLater: (_ work: @escaping () -> Void) -> Void

        static var live: Env {
            Env(
                activeRelay: {
                    guard let active = SharedRelayOrigin.currentActive(), let keyId = active.profile?.keyId else { return nil }
                    return (keyId, active.origin)
                },
                encKey: { NativeKeyStore.encKey(keyId: $0) },
                actKey: { NativeKeyStore.actKey(keyId: $0) },
                grant: { NativeKeyStore.grant(keyId: $0) },
                post: { url, body, reply in TalosQuickAct.post(url, body, reply) },
                fail: { message, done in TalosQuickAct.fail(message, done: done) },
                trusted: { keyId in TalosQuickAct.trusts(profile: SharedRelayOrigin.currentActive()?.profile, keyId: keyId, now: Date()) },
                now: Date.init,
                startBackgroundTask: { expired in
                    var task = UIBackgroundTaskIdentifier.invalid
                    let lock = NSLock()
                    let started = UIApplication.shared.beginBackgroundTask(withName: "talos.quickact") { expired() }
                    lock.lock(); task = started; lock.unlock()
                    return {
                        lock.lock(); let t = task; task = .invalid; lock.unlock()
                        if t != .invalid { UIApplication.shared.endBackgroundTask(t) }
                    }
                },
                retryLater: { work in DispatchQueue.global().asyncAfter(deadline: .now() + 1, execute: work) })
        }
    }

    /// The stored facts of the active pairing decide: no profile, another pairing's profile, a failed check or no verification in the
    /// last 24 hours all refuse. (Unverified inside the 24 hours is allowed: no worse than the readable page.)
    static func trusts(profile: RelayProfile?, keyId: String, now: Date) -> Bool {
        guard let profile, profile.keyId == keyId else { return false }
        return profile.allowsQuickAct(now: now)
    }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        // iOS gives a background wake about 30 seconds. One try, one wait, one retry must fit well inside that:
        // 8 + 1 + 8 = 17 seconds at worst, so the answer (sent, or a failure notification) is always posted before time runs out.
        c.timeoutIntervalForRequest = 8
        c.timeoutIntervalForResource = 8
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    static func handle(_ action: PushCore.QuickAction, response: UNNotificationResponse, done: @escaping () -> Void) {
        let text = (response as? UNTextInputNotificationResponse)?.userText
        let content = response.notification.request.content
        let shown = RichPush.Shown(title: content.title, subtitle: content.subtitle, body: content.body)
        run(action, shown: shown, userInfo: content.userInfo, userText: text, env: .live, done: done)
    }

    static func run(
        _ action: PushCore.QuickAction, shown: RichPush.Shown, userInfo: [AnyHashable: Any], userText: String?, env: Env,
        done: @escaping () -> Void
    ) {
        guard let act = RichPush.act(for: action, shown: shown, userInfo: userInfo, userText: userText) else {
            return env.fail("Talos couldn't read that notification. Open Talos.", done)
        }
        // One read of the active relay gives both the address the frame goes to and the id whose keys and grant sign it.
        guard let active = env.activeRelay(), let url = RichPush.actURL(relay: active.origin) else {
            return env.fail("This phone has no Talos server set up. Open Talos.", done)
        }
        let keyId = active.keyId
        // A button on a push from another relay (the app has moved on) refuses here, before any key is read: nothing is signed
        // and nothing is sent, so no text reaches a relay it was not meant for.
        guard RichPush.pressMatchesActiveKey(userInfo: userInfo, activeKeyId: keyId) else {
            return env.fail("That notification is from another Talos server. Open Talos.", done)
        }
        // A pairing whose check failed, or that was last verified a day ago or more, signs and sends nothing (the app shows no page for it
        // either). Before any key is read, like the check above.
        guard env.trusted(keyId) else {
            return env.fail("Talos can't confirm your Mac. Open Talos.", done)
        }
        // Button data that names the active pairing could still have been written by a push that skipped the extension: only the
        // extension can make the MAC, because only it and this app hold the seal key.
        guard let sealKey = env.encKey(keyId), RichPush.pressIsAuthentic(userInfo: userInfo, sealKey: sealKey) else {
            return env.fail("Talos couldn't read that notification. Open Talos.", done)
        }
        guard let grant = env.grant(keyId), let key = env.actKey(keyId) else {
            return env.fail("Notification buttons are off on this phone. Open Talos and tap Show message text.", done)
        }
        var endBackgroundTask: () -> Void = {}
        let runLock = NSLock()
        let run = QuickActRun(
            notifyFailure: { message, then in env.fail(message, then) },
            complete: done,
            endBackgroundTask: {
                runLock.lock(); let end = endBackgroundTask; runLock.unlock()
                end()
            })
        let end = env.startBackgroundTask { run.timeExpired() }
        runLock.lock(); endBackgroundTask = end; runLock.unlock()
        let id = RichPush.newActId()
        let frame: [String: String]
        do {
            frame = try RichPush.signAct(act, grantJson: grant, id: id, now: env.now(), key: key)
        } catch let e as RichPush.ActError {
            return run.conclude(e == .grantExpired || e == .noGrant || e == .noScope
                ? "Notification buttons need Talos opened once to renew. Open Talos." : "Talos couldn't send that. Open Talos.")
        } catch {
            return run.conclude("Talos couldn't send that. Open Talos.")
        }
        // The app may have moved to another relay while this was signed: send only if the same pairing is still the active one.
        guard env.activeRelay()?.keyId == keyId else {
            return run.conclude("That notification is from another Talos server. Open Talos.")
        }
        // A failed check may have landed while this was signed: the same look as at the start, just before the post.
        guard env.trusted(keyId) else {
            return run.conclude("Talos can't confirm your Mac. Open Talos.")
        }
        run.send(
            body: RichPush.wireJson(frame),
            transport: { body, reply in env.post(url, body, reply) },
            retryLater: { work in env.retryLater(work) })
    }

    private static func post(_ url: URL, _ body: Data, _ reply: @escaping (Int?, String?) -> Void) {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        session.dataTask(with: req) { data, resp, _ in
            let status = (resp as? HTTPURLResponse)?.statusCode
            let code = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }?["error"] as? String
            reply(status, code)
        }.resume()
    }

    private static func fail(_ message: String, done: @escaping () -> Void) {
        let content = UNMutableNotificationContent()
        content.title = "Talos"
        content.body = message
        content.sound = .default
        content.threadIdentifier = "talos.quickact.failed"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { _ in done() }
    }
}
