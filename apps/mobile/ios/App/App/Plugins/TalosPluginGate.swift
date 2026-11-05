import BridgeGuard
import Capacitor
import Foundation

/// Second line of defence for the app's own plugins (IOS-SPEC I14): even if a call got past the bridge filter, a local
/// plugin runs only while the web view is on the relay origin, outside /media/. The origin is the compiled `server.url`.
enum TalosPluginGate {
    /// Capacitor runs plugin methods on a background queue, and `WKWebView.url` may only be read on the main thread, so the
    /// check hops to main (the main thread never waits on a plugin queue, so this cannot deadlock).
    static func allows(_ bridge: CAPBridgeProtocol?) -> Bool {
        if Thread.isMainThread { return check(bridge) }
        return DispatchQueue.main.sync { check(bridge) }
    }

    private static func check(_ bridge: CAPBridgeProtocol?) -> Bool {
        guard let bridge = bridge as? CapacitorBridge,
              let guardian = BridgeGuard(relayURL: bridge.config.serverURL),
              let url = bridge.webView?.url,
              guardian.isRelayURL(url) else { return false }
        return !BridgeGuard.isMediaPath(url)
    }
}
