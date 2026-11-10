import Capacitor
import Foundation
import TalosPushCore
import UIKit
import UserNotifications

extension Notification.Name {
    static let talosPushToken = Notification.Name("talos.push.token")
    static let talosPushFailed = Notification.Name("talos.push.failed")
}

/// Notification categories, the notification-center delegate and the tap hand-off. Lives for the whole process: a tap that
/// launches the app arrives before any web page (or plugin instance) exists, so the last one waits here.
final class TalosPushCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = TalosPushCenter()
    /// Set by the plugin once the page can hear it.
    var deliver: (([String: Any]) -> Bool)?
    /// The thread the page is showing right now (or nil), set by the page through `setViewing`.
    var viewingThread: String?
    private var waiting: [String: Any]?
    /// The last tap that went through to a page, and when. The page never says it acted on it, so a page that is replaced
    /// right after (`requeueRecentlyDelivered`) may have lost it.
    private var delivered: (event: [String: Any], at: Date)?
    /// The clock, so a test can say how long ago the tap went through.
    var now: () -> Date = Date.init

    /// Capacitor would take the delegate when its bridge is built (after launch) unless `ios.handleApplicationNotifications`
    /// is false in capacitor.config.ts; with it off, this stays the delegate and taps reach `didReceive` (review R2). The
    /// plugin installs it again when it loads, in case a build ever turns that setting back on.
    func install() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(PushCore.notificationCategories())
    }

    /// Hands the waiting tap to the page. It is kept until `deliver` says it went through: the gate refuses while the web
    /// view is not on the relay yet (a tap that launched the app), and the page's own `addListener` flushes again.
    func flush() {
        guard let deliver, let event = waiting else { return }
        if deliver(event) {
            waiting = nil
            delivered = (event, now())
        }
    }

    /// The web view is being replaced. A tap that went through to the old page within `window` seconds may never have been acted
    /// on, so the new page gets it again (a tap that landed on the right route twice only opens that route twice). Older taps were
    /// long since seen, and no tap that is still waiting is overwritten.
    func requeueRecentlyDelivered(within window: TimeInterval = 60) {
        let last = delivered
        delivered = nil
        guard let last, waiting == nil, now().timeIntervalSince(last.at) <= window else { return }
        waiting = last.event
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        // Reply and Approve-on-a-low-risk-card are done here in the background, with no web page: the page never hears them.
        if let quick = PushCore.quickAction(identifier: response.actionIdentifier) {
            return TalosQuickAct.handle(quick, response: response, done: completionHandler)
        }
        defer { completionHandler() }
        guard let action = PushCore.actionName(identifier: response.actionIdentifier,
                                               defaultIdentifier: UNNotificationDefaultActionIdentifier,
                                               dismissIdentifier: UNNotificationDismissActionIdentifier),
              let path = PushCore.navigatePath(response.notification.request.content.userInfo) else { return }
        tapped(action: action, path: path)
    }

    /// A tap on a notification (or one of its buttons): kept until a page takes it.
    func tapped(action: String, path: String) {
        waiting = ["action": action, "navigate": path]
        flush()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // The owner is looking at the thread this is about: the reply is already on screen, so no banner or sound.
        if PushCore.suppressInForeground(notification.request.content.userInfo, viewing: viewingThread) {
            return completionHandler([])
        }
        completionHandler([.banner, .list, .sound, .badge])
    }
}

/// `TalosPush` (IOS-SPEC WP-I5). It asks iOS for notification permission and a device token and reports taps. It never
/// talks to the relay and is never told its address: the page signs the token and sends it. Calls run only while the web
/// view is on the relay origin (`TalosPluginGate`).
///   getStatus()            -> { permission: 'granted' | 'denied' | 'prompt', capable: Bool }
///   register({prompt})     -> { token, env }   rejects: denied | prompt | unavailable | timeout
///   unregister()
///   setBadge({count})
///   setViewing({thread})   thread = the key Apple's pushes carry for it (General/Inbox id, or the relay's opaque ref), or null
///   nativeKeys()           -> { enc_pub, act_pub }  makes the notification keys the first time (public halves only ever leave)
///   storeGrant({grant})    keeps the device-key-signed grant, only if it names these keys; rejects otherwise
///   clearGrant()           Turn off / sign out: deletes the grant and both private keys
///   clearDelivered({tags}) removes delivered notifications whose thread-id is one of tags (`thread:<key>`, `card:<id>`)
///   event "action"         -> { action: 'open' | 'approve', navigate: '/in/app/path' }
@objc(TalosPushPlugin)
public class TalosPushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TalosPushPlugin"
    public let jsName = "TalosPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setViewing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDelivered", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nativeKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeGrant", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearGrant", returnType: CAPPluginReturnPromise),
    ]

    private var waiting: [CAPPluginCall] = []
    /// The 10 s guard of the request in flight. Cancelled the moment it is answered, so a stale one can never reject a newer
    /// request (review L8).
    private var timeoutGuard: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []
    private static let timeout: TimeInterval = 10

    public override func load() {
        TalosPushCenter.shared.install()
        TalosPushCenter.shared.deliver = { [weak self] event in
            guard let self, TalosPluginGate.allows(self.bridge) else { return false }
            self.notifyListeners("action", data: event, retainUntilConsumed: true)
            return true
        }
        TalosPushCenter.shared.flush()
        observers.append(NotificationCenter.default.addObserver(forName: .talosPushToken, object: nil, queue: .main) { [weak self] n in
            guard let token = n.object as? String else { return }
            self?.finish { $0.resolve(["token": token, "env": PushCore.environment(provisioningProfile: Self.provisioningProfile)]) }
        })
        observers.append(NotificationCenter.default.addObserver(forName: .talosPushFailed, object: nil, queue: .main) { [weak self] n in
            let code = (n.object as? String) ?? "failed"
            self?.finish { $0.reject(code, code) }
        })
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    /// The profile this build was installed with (development builds and ad hoc carry one; App Store installs do not).
    private static var provisioningProfile: Data? {
        Bundle.main.path(forResource: "embedded", ofType: "mobileprovision").flatMap { FileManager.default.contents(atPath: $0) }
    }

    /// The page just asked to hear taps: if one is waiting (it launched the app), now is when it can go through.
    @objc public override func addListener(_ call: CAPPluginCall) {
        super.addListener(call)
        TalosPushCenter.shared.flush()
    }

    private func finish(_ f: (CAPPluginCall) -> Void) {
        timeoutGuard?.cancel()
        timeoutGuard = nil
        let calls = waiting
        waiting = []
        calls.forEach(f)
    }

    private func permission(_ s: UNNotificationSettings) -> String {
        switch s.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        // `capable` is false for a build signed without the push capability, so the page can say "Needs setup" up front.
        let capable = PushCore.hasPushEntitlement(provisioningProfile: Self.provisioningProfile)
        UNUserNotificationCenter.current().getNotificationSettings { s in
            call.resolve(["permission": self.permission(s), "capable": capable])
        }
    }

    @objc func register(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        // Only an explicit `prompt: true` (the page sends it from a tap) may show the iOS permission dialog.
        let mayPrompt = call.getBool("prompt") ?? false
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            switch self.permission(settings) {
            case "denied": call.reject("denied", "denied")
            case "granted": self.ask(call)
            default:
                guard mayPrompt else { return call.reject("prompt", "prompt") }
                center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
                    granted ? self.ask(call) : call.reject("denied", "denied")
                }
            }
        }
    }

    /// Asks iOS for a token and waits for AppDelegate's callback (or the timeout). Several calls share one request.
    private func ask(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.waiting.append(call)
            if self.waiting.count == 1 {
                UIApplication.shared.registerForRemoteNotifications()
                let guardItem = DispatchWorkItem { [weak self] in
                    self?.finish { $0.reject("timeout", "timeout") }
                }
                self.timeoutGuard = guardItem
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout, execute: guardItem)
            }
        }
    }

    @objc func unregister(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        DispatchQueue.main.async {
            UIApplication.shared.unregisterForRemoteNotifications()
            call.resolve()
        }
    }

    @objc func setBadge(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        let count = max(0, min(call.getInt("count") ?? 0, 99_999))
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in call.resolve() }
    }

    @objc func setViewing(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        TalosPushCenter.shared.viewingThread = call.getString("thread")
        call.resolve()
    }

    /// The thread (or card) was read: take its notifications off the lock screen and out of Notification Center. Matches on
    /// the push's `thread-id` only, so it can remove nothing else this app has delivered.
    @objc func clearDelivered(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        let tags = (call.getArray("tags") ?? []).compactMap { $0 as? String }
        removeDelivered(
            pick: { delivered in
                PushCore.identifiersToClear(
                    delivered: delivered.map { (identifier: $0.request.identifier, threadIdentifier: $0.request.content.threadIdentifier) },
                    tags: tags)
            },
            then: { call.resolve() })
    }

    /// The one place a delivered notification is removed; `pick` names which, from what PushCore decides.
    private func removeDelivered(pick: @escaping ([UNNotification]) -> [String], then done: @escaping () -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = pick(delivered)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
            done()
        }
    }

    @objc func nativeKeys(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        do {
            let keys = try NativeKeyStore.ensureKeys()
            call.resolve(["enc_pub": keys.encPub, "act_pub": keys.actPub])
        } catch {
            call.reject("keychain", "keychain")
        }
    }

    @objc func storeGrant(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        guard let grant = call.getString("grant"), grant.utf8.count <= 2048 else { return call.reject("invalid", "invalid") }
        do {
            try NativeKeyStore.saveGrant(grant) ? call.resolve() : call.reject("invalid", "invalid")
        } catch {
            call.reject("keychain", "keychain")
        }
    }

    @objc func clearGrant(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        NativeKeyStore.clearAll()
        // The words already on the lock screen and in Notification Center go with the keys: only notifications the extension
        // marked as showing text (a fixed phrase is left alone).
        removeDelivered(
            pick: { delivered in
                PushCore.identifiersShowingText(
                    delivered: delivered.map { (identifier: $0.request.identifier, userInfo: $0.request.content.userInfo) })
            },
            then: { call.resolve() })
    }
}
