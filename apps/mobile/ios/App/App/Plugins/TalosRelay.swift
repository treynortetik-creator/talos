import Capacitor
import UIKit

/// "Add relay" for the web (BYOR 3.1, 10d): `openAddRelay()` only asks the native side to open its own sheet. It takes NO
/// arguments and ignores any that come, so a page can never hand the app a link or an origin: the origin comes only from the
/// camera scan inside the sheet.
@objc(TalosRelayPlugin)
public class TalosRelayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TalosRelayPlugin"
    public let jsName = "TalosRelay"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openAddRelay", returnType: CAPPluginReturnPromise)
    ]

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
