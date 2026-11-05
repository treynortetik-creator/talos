import CryptoKit
import Foundation
import TalosPushCore
import UserNotifications

/// Opens the seal the relay added to an iPhone push and shows the words inside it. Apple delivers the fixed phrase and the
/// sealed bytes and cannot read the words; the relay can, because it builds the seal from the plain text. On this phone the
/// key that opens the seal is in a Keychain group the app and the other extensions that list it can reach; the words exist in
/// the clear only inside this process and on the screen. Any failure at all (no grant, no key, a wrong seal, the time limit) delivers the push exactly as Apple sent it.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        original = request.content
        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else { return contentHandler(request.content) }
        contentHandler(Self.rewritten(mutable, from: request.content) ?? request.content)
        handler = nil
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler, let original { handler(original) }
        handler = nil
    }

    static func rewritten(_ out: UNMutableNotificationContent, from c: UNNotificationContent) -> UNNotificationContent? {
        var info = c.userInfo
        guard var talos = info["talos"] as? [String: Any], let kind = talos["kind"] as? String,
              let envelope = talos["enc"] as? [String: Any],
              let grantJson = NativeKeyStore.grant(), let grant = RichPush.grantInfo(grantJson), let key = NativeKeyStore.encKey(),
              let content = RichPush.open(envelope: envelope, key: key, deviceId: grant.deviceId, kind: kind, cardId: talos["card_id"] as? String)
        else { return nil }
        out.body = content.body
        // Marks this notification as holding opened words, so sign-out and "fixed phrase only" can take it off the screen.
        info[PushCore.textMarkerKey] = PushCore.textMarkerValue
        if let s = content.subtitle { out.subtitle = s }
        if let category = RichPush.category(for: content) {
            out.categoryIdentifier = category
            // What the app needs to act on a button press, taken from inside the seal: where a Reply goes, which card an
            // Approve is for and the hash of the words shown. The sealed bytes are dropped.
            var rich: [String: String] = ["shown": RichPush.shownHash(content.body, subtitle: content.subtitle)]
            if let t = content.threadId { rich["t"] = t }
            if let id = content.cardId { rich["c"] = id }
            if let h = content.payloadHash { rich["h"] = h }
            info["talos_rich"] = rich
        }
        talos.removeValue(forKey: "enc")
        info["talos"] = talos
        out.userInfo = info
        return out
    }
}
