import Foundation
import UserNotifications

/// A button on a notification. Both open the app, and neither approves anything from the lock screen. Approve opens the card
/// armed (the page keeps that in memory; no URL carries it): a high-risk card then starts its normal Approve flow, which asks for Face ID before
/// anything is sent; any other card is shown with its button focused. A card that changed since the push is simply shown.
/// Approve also needs the phone unlocked (`authenticationRequired`), so a lock-screen tap cannot even open that flow.
public struct PushButton: Equatable, Sendable {
    public let identifier: String
    public let title: String
    /// What the page hears: "open" or "approve".
    public let name: String
    public var requiresAuthentication: Bool = false
    /// False for a button that does its work in the background (Reply, Approve on a low-risk card): the app is not brought forward.
    public var opensApp: Bool = true
    /// A button that takes typed text (Reply).
    public var takesText: Bool = false
}

public struct PushCategory: Equatable, Sendable {
    public let identifier: String
    public let buttons: [PushButton]
}

public enum PushCore {
    public static let openButton = PushButton(identifier: "TALOS_ACT_OPEN", title: "Open", name: "open")
    public static let approveButton = PushButton(identifier: "TALOS_ACT_APPROVE", title: "Approve", name: "approve", requiresAuthentication: true)

    /// Must match `APNS_CATEGORIES` in packages/protocol/src/push.ts (a test on the web side pins the same strings).
    public static let categories: [PushCategory] = [
        PushCategory(identifier: "TALOS_OPEN", buttons: [openButton]),
        PushCategory(identifier: "TALOS_CARD", buttons: [openButton, approveButton]),
        // The two below are never sent by the relay: only the notification extension picks them, after it has opened the seal
        // (RichPush.category). Both buttons act in the background and need the phone unlocked, so a lock-screen tap cannot send
        // anything as the owner.
        PushCategory(identifier: RichPush.replyCategory, buttons: [openButton, replyButton]),
        PushCategory(identifier: RichPush.cardLowCategory, buttons: [openButton, approveLowButton]),
    ]

    /// The iOS option set for one button. Turning `requiresAuthentication` into `.authenticationRequired` happens here, in code
    /// the tests run, so a dropped option cannot ship green: without it a locked phone could send a Reply or a low-risk Approve.
    public static func actionOptions(for button: PushButton) -> UNNotificationActionOptions {
        var options: UNNotificationActionOptions = button.opensApp ? [.foreground] : []
        if button.requiresAuthentication { options.insert(.authenticationRequired) }
        return options
    }

    /// The categories handed to the notification center, built from `categories`.
    public static func notificationCategories() -> Set<UNNotificationCategory> {
        Set(categories.map { category in
            UNNotificationCategory(
                identifier: category.identifier,
                actions: category.buttons.map { b in
                    if b.takesText {
                        return UNTextInputNotificationAction(
                            identifier: b.identifier, title: b.title, options: actionOptions(for: b),
                            textInputButtonTitle: "Send", textInputPlaceholder: "Reply")
                    }
                    return UNNotificationAction(identifier: b.identifier, title: b.title, options: actionOptions(for: b))
                },
                intentIdentifiers: [],
                options: []
            )
        })
    }

    public static let replyButton = PushButton(
        identifier: RichPush.replyActionId, title: "Reply", name: "reply", requiresAuthentication: true, opensApp: false, takesText: true)
    public static let approveLowButton = PushButton(
        identifier: RichPush.approveLowActionId, title: "Approve", name: "approve_low", requiresAuthentication: true, opensApp: false)

    /// The two buttons the app handles itself, with no web page involved: a Reply, or an Approve for a low-risk card.
    public enum QuickAction: Equatable, Sendable { case reply, approveLow }
    public static func quickAction(identifier: String) -> QuickAction? {
        switch identifier {
        case RichPush.replyActionId: return .reply
        case RichPush.approveLowActionId: return .approveLow
        default: return nil
        }
    }

    /// Lowercase hex, which is what the relay and Apple's `/3/device/<token>` path take.
    public static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// The APNs host a token belongs to, from how THIS build was signed: its provisioning profile says
    /// `aps-environment` = `development` (a build run from Xcode) or `production` (TestFlight, App Store). A Release
    /// configuration signed for development is still sandbox, which a `#if DEBUG` guess would get wrong (review L7). A build
    /// with no profile (App Store installs carry none) is production. Anything unreadable falls back to production.
    public static func environment(provisioningProfile: Data?) -> String {
        guard let data = provisioningProfile else { return "production" }
        // The profile is a signed blob with a plain-text plist inside; Latin-1 reads every byte without failing.
        let text = String(data: data, encoding: .isoLatin1) ?? ""
        guard let key = text.range(of: "<key>aps-environment</key>") else { return "production" }
        let rest = text[key.upperBound...]
        guard let open = rest.range(of: "<string>"), let close = rest.range(of: "</string>"), open.upperBound <= close.lowerBound
        else { return "production" }
        return rest[open.upperBound..<close.lowerBound] == "development" ? "sandbox" : "production"
    }

    /// Whether this build can get a push token at all: its provisioning profile carries `aps-environment`. A build with no
    /// profile (App Store installs) is capable. A free Personal Team's profile has no such entry, so the page can say
    /// "Needs setup" up front instead of showing the iOS permission dialog for nothing (review R9).
    public static func hasPushEntitlement(provisioningProfile: Data?) -> Bool {
        guard let data = provisioningProfile else { return true }
        return (String(data: data, encoding: .isoLatin1) ?? "").contains("<key>aps-environment</key>")
    }

    /// Why iOS could not register for remote notifications, as the code the page understands. Only the missing-entitlement
    /// error (NSCocoaErrorDomain 3000, "no valid aps-environment") means the build has no push capability; a network or
    /// Apple outage is `failed`, a retry, not a reason to say "rebuild with a paid account" (review L3).
    public static func registrationFailureCode(domain: String, code: Int) -> String {
        domain == "NSCocoaErrorDomain" && code == 3000 ? "unavailable" : "failed"
    }

    /// The name the page hears for a tap, or nil when the owner dismissed it (no event). The default tap is "open".
    public static func actionName(identifier: String, defaultIdentifier: String, dismissIdentifier: String) -> String? {
        if identifier == dismissIdentifier { return nil }
        if identifier == defaultIdentifier { return openButton.name }
        for category in categories {
            // A quick action never reaches the page: the app does it in the background (see `quickAction`).
            if let b = category.buttons.first(where: { $0.identifier == identifier }), b.opensApp { return b.name }
        }
        return nil
    }

    /// Whether a push that arrives while the app is open should stay quiet: the owner is looking at the thread it is about.
    /// `viewing` is the key Apple's notifications carry for that thread: the thread id for General and Inbox, the relay's
    /// opaque reference for any other (the page learns it from the relay). A payload matches by `talos.thread_id` (General and
    /// Inbox only) or by its `aps.thread-id` (`thread:<key>`), which is the only name a named thread's push has.
    public static func suppressInForeground(_ userInfo: [AnyHashable: Any], viewing: String?) -> Bool {
        guard let viewing, !viewing.isEmpty else { return false }
        if let talos = userInfo["talos"] as? [String: Any], let thread = talos["thread_id"] as? String, thread == viewing { return true }
        if let aps = userInfo["aps"] as? [String: Any], let tag = aps["thread-id"] as? String, tag == "thread:" + viewing { return true }
        return false
    }

    /// The most tags one `clearDelivered` call may name.
    public static let maxClearTags = 50

    /// Which delivered notifications to take away: those whose `threadIdentifier` (the push's `aps.thread-id`: `thread:<key>`
    /// or `card:<id>`) is one of `tags`. Empty tags, and blank tags, match nothing, so a notification
    /// with no thread (an empty `threadIdentifier`) can never be swept up.
    public static func identifiersToClear(delivered: [(identifier: String, threadIdentifier: String)], tags: [String]) -> [String] {
        let wanted = Set(tags.prefix(maxClearTags).filter { !$0.isEmpty })
        guard !wanted.isEmpty else { return [] }
        return delivered.filter { wanted.contains($0.threadIdentifier) }.map { $0.identifier }
    }

    /// What the notification extension adds to `userInfo` once it has put the words from inside the seal on screen. Only a
    /// notification carrying it holds message text, so only those are taken back when text goes off or the owner signs out.
    public static let textMarkerKey = "talos_text"
    public static let textMarkerValue = "1"

    /// Which delivered notifications show message text this phone opened: those the extension marked. A fixed-phrase
    /// notification (no marker) is never named, so nothing else the app delivered is swept up.
    public static func identifiersShowingText(delivered: [(identifier: String, userInfo: [AnyHashable: Any])]) -> [String] {
        delivered.filter { ($0.userInfo[textMarkerKey] as? String) == textMarkerValue }.map { $0.identifier }
    }

    /// The Keychain accounts that hold the notification keys and the grant. Turn off and sign out delete every one of them.
    public static let keychainAccounts = ["enc", "act", "grant"]

    /// Turn off / sign out: deletes every account, even if one deletion is a no-op, so no key or grant is left behind.
    public static func deleteNotificationSecrets(deleteAccount: (String) -> Void) {
        for account in keychainAccounts { deleteAccount(account) }
    }

    private static let pathCharacters: CharacterSet = {
        var s = CharacterSet.alphanumerics
        s.insert(charactersIn: "._~!$&'()*+,;=:@%/?#-")
        return s
    }()
    private static let blockedPrefixes = ["/media", "/api", "/bridge", "/hook", "/ws"]

    /// The in-app path a notification asks to open, from the payload's `talos.navigate`, or nil. A path that is not a plain
    /// in-app path (another host, a scheme, a double slash, a backslash, the media/API spaces, even percent-encoded) is
    /// dropped, so a forged or malformed payload can only fail to open anything. The page validates again.
    public static func navigatePath(_ userInfo: [AnyHashable: Any]) -> String? {
        guard let talos = userInfo["talos"] as? [String: Any], let path = talos["navigate"] as? String else { return nil }
        guard path.count <= 512, path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
        guard path.unicodeScalars.allSatisfy({ pathCharacters.contains($0) }) else { return nil }
        var decoded = path
        for _ in 0..<4 {
            guard let next = decoded.removingPercentEncoding else { return nil }
            if next == decoded { break }
            decoded = next
        }
        if decoded.hasPrefix("//") || decoded.contains("\\") { return nil }
        let lower = decoded.lowercased()
        let bare = lower.split(whereSeparator: { "?#".contains($0) }).first.map(String.init) ?? lower
        for p in blockedPrefixes where bare == p || bare.hasPrefix(p + "/") { return nil }
        return path
    }
}
