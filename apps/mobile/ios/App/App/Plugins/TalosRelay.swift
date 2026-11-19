import Capacitor
import UIKit

/// "Add relay" and "recheck" for the web (BYOR 3.1, 10d; phase 4b): `openAddRelay()` only asks the native side to open its own sheet. It takes NO
/// arguments and ignores any that come, so a page can never hand the app a link or an origin: the origin comes only from the
/// camera scan inside the sheet.
@objc(TalosRelayPlugin)
public class TalosRelayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TalosRelayPlugin"
    public let jsName = "TalosRelay"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openAddRelay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recheck", returnType: CAPPluginReturnPromise)
    ]

    /// Asks for one more Mac check. It takes no arguments, never waits for the answer and never sets a result: the phone's own check
    /// decides. It runs only while the relay is verified (`TalosPluginGate`), one check at a time and 30 s apart.
    @objc func recheck(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("Not available here.") }
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? TalosBridgeViewController)?.attestCoordinator?.recheckFromPage()
            call.resolve()
        }
    }

    @objc func openAddRelay(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("Not available here.") }
        DispatchQueue.main.async { [weak self] in
            guard let host = self?.bridge?.viewController else { return call.reject("Not available here.") }
            // One sheet at a time: a second ask is refused, so the page never sees a false success.
            guard host.presentedViewController == nil else { return call.reject("Already open.") }
            AddRelayViewController.present(from: host)
            call.resolve()
        }
    }
}
