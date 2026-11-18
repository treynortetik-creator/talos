import BridgeGuard
import Capacitor
import Foundation

/// Second line of defence for the app's own plugins (IOS-SPEC I14): even if a call got past the bridge filter, a local
/// plugin runs only while the web view is on the relay origin, outside /media/. The origin and the trust state are the web view controller's
/// own (`relayContext`, from the active relay profile), the same objects its bridge handler and navigation gate use.
enum TalosPluginGate {
    /// Capacitor runs plugin methods on a background queue, and `WKWebView.url` may only be read on the main thread, so the
    /// check hops to main (the main thread never waits on a plugin queue, so this cannot deadlock).
    static func allows(_ bridge: CAPBridgeProtocol?) -> Bool {
        if Thread.isMainThread { return check(bridge) }
        return DispatchQueue.main.sync { check(bridge) }
    }

    /// The key id of the pairing this web view is on (its controller's own profile; the phone minted it), for per-pairing native state such as the notification
    /// keys. nil when the page is on no stored relay (a development build's compiled-in address): that page gets no keys.
    static func keyId(_ bridge: CAPBridgeProtocol?) -> String? {
        let read = {
            ((bridge as? CapacitorBridge)?.viewController as? TalosBridgeViewController)?.relayContext?.active.profile?.keyId
        }
        return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
    }

    private static func check(_ bridge: CAPBridgeProtocol?) -> Bool {
        // Only the controller that is the window's root may act: a controller that a relay switch replaced is refused, so the old
        // relay's page cannot write a token or grant after the switch.
        guard let bridge = bridge as? CapacitorBridge,
              let controller = bridge.viewController as? TalosBridgeViewController,
              controller.view.window?.rootViewController === controller,
              let context = controller.relayContext,
              context.trust.state.allowsNativeFeatures,
              let url = bridge.webView?.url,
              context.guardian.isRelayURL(url) else { return false }
        return !BridgeGuard.isMediaPath(url)
    }
}
