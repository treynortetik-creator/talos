import Capacitor
import Foundation
import TalosShareCore

/// `TalosShare.setToken({token, scopes})` and `TalosShare.clearToken()` (IOS-SPEC 6.1). The token goes straight into the
/// shared Keychain group for the share extension. There is no read method, and no relay argument: the extension posts to
/// the relay compiled into the app (`CompiledRelay`). Any extra field in the call (a `relay`, say) is ignored.
@objc(TalosSharePlugin)
public class TalosSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TalosSharePlugin"
    public let jsName = "TalosShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearToken", returnType: CAPPluginReturnPromise),
    ]

    @objc func setToken(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        // A missing `scopes` means text only; a present but malformed one is rejected, never quietly narrowed.
        let scopes: [String]?
        if call.hasOption("scopes") { scopes = call.getArray("scopes", String.self) } else { scopes = ["text"] }
        guard let secret = call.getString("token"), let scopes,
            let data = StoredShareToken.encode(secret: secret, scopes: scopes)
        else { return call.reject("that share token is not valid") }
        do {
            try KeychainTokenStore.save(data)
            call.resolve()
        } catch {
            call.reject("could not store the share token")
        }
    }

    @objc func clearToken(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        do {
            try KeychainTokenStore.clear()
            call.resolve()
        } catch {
            call.reject("could not clear the share token")
        }
    }
}
