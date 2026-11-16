import CryptoKit
import Foundation
import TalosPushCore
import UserNotifications

/// Opens the seal the relay added to an iPhone push and shows the words inside it. Apple delivers the fixed phrase and the
/// sealed bytes and cannot read the words; the relay can, because it builds the seal from the plain text. On this phone the
/// key that opens the seal is in a Keychain group the app and the other extensions that list it can reach; the words exist in
/// the clear only inside this process and on the screen. Any failure at all (no grant, no key, a wrong seal, the time limit)
/// delivers the fixed phrase Apple sent, with no button that signs and none of the relay's button data.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    /// What is delivered if the seal cannot be opened in time: the push with no button data and no button that signs.
    private var plain: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let inbound = RichPush.Delivery(
            title: request.content.title, subtitle: request.content.subtitle, body: request.content.body,
            category: request.content.categoryIdentifier, userInfo: request.content.userInfo)
        let plain = Self.content(RichPush.deliver(inbound, opened: nil), from: request.content)
        handler = contentHandler
        self.plain = plain
        let opened = Self.open(request.content.userInfo)
        contentHandler(opened.map { Self.content(RichPush.deliver(inbound, opened: $0), from: request.content) } ?? plain)
        handler = nil
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler, let plain { handler(plain) }
        handler = nil
    }

    /// The seal's words, or nil for anything that is not a seal made for this phone (no grant, no key, a wrong seal).
    static func open(_ info: [AnyHashable: Any]) -> RichContent? {
        guard let talos = info["talos"] as? [String: Any], let kind = talos["kind"] as? String,
              let envelope = talos["enc"] as? [String: Any],
              let grantJson = NativeKeyStore.grant(), let grant = RichPush.grantInfo(grantJson), let key = NativeKeyStore.encKey()
        else { return nil }
        return RichPush.open(envelope: envelope, key: key, deviceId: grant.deviceId, kind: kind, cardId: talos["card_id"] as? String)
    }

    static func content(_ d: RichPush.Delivery, from c: UNNotificationContent) -> UNNotificationContent {
        let out = (c.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        out.title = d.title
        out.subtitle = d.subtitle
        out.body = d.body
        out.categoryIdentifier = d.category
        out.userInfo = d.userInfo
        return out
    }
}
