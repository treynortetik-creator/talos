import CryptoKit
import Foundation
import TalosPushCore
import UIKit
import UserNotifications

/// Reply and Approve from a notification button. iOS wakes the app in the background for these (they do not bring it forward);
/// this signs the action with the key in the shared Keychain and posts it to the relay origin compiled into the build. There is
/// no web page involved and no cookie: the credential is the signature chain (device key, grant, action key).
///
/// Nothing is ever shown as sent that was not accepted: a refusal or a failure after one retry becomes a notification that
/// says what to do, with no message text in it. The id is made once per press and reused by the retry, so the relay answers
/// "done" at most once for it.
enum TalosQuickAct {
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
        let info = response.notification.request.content.userInfo
        guard let act = RichPush.act(for: action, userInfo: info, userText: text) else {
            return fail("Talos couldn't read that notification. Open Talos.", done: done)
        }
        guard let grant = NativeKeyStore.grant(), let key = NativeKeyStore.actKey() else {
            return fail("Notification buttons are off on this phone. Open Talos and tap Show message text.", done: done)
        }
        guard let relay = CompiledRelay.url(), let url = RichPush.actURL(relay: relay) else {
            return fail("Talos couldn't find its server. Open Talos.", done: done)
        }
        var task = UIBackgroundTaskIdentifier.invalid
        let taskLock = NSLock()
        let run = QuickActRun(
            notifyFailure: { message, then in fail(message, done: then) },
            complete: done,
            endBackgroundTask: {
                taskLock.lock(); let t = task; task = .invalid; taskLock.unlock()
                if t != .invalid { UIApplication.shared.endBackgroundTask(t) }
            })
        let started = UIApplication.shared.beginBackgroundTask(withName: "talos.quickact") { run.timeExpired() }
        taskLock.lock(); task = started; taskLock.unlock()
        let id = RichPush.newActId()
        let frame: [String: String]
        do {
            frame = try RichPush.signAct(act, grantJson: grant, id: id, now: Date(), key: key)
        } catch let e as RichPush.ActError {
            return run.conclude(e == .grantExpired || e == .noGrant || e == .noScope
                ? "Notification buttons need Talos opened once to renew. Open Talos." : "Talos couldn't send that. Open Talos.")
        } catch {
            return run.conclude("Talos couldn't send that. Open Talos.")
        }
        run.send(
            body: RichPush.wireJson(frame),
            transport: { body, reply in post(url, body, reply) },
            retryLater: { work in DispatchQueue.global().asyncAfter(deadline: .now() + 1, execute: work) })
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
