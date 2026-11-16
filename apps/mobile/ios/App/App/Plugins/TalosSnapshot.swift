import Capacitor
import UIKit
import WebKit

/// A picture of what the app shows, for Report a bug (apps/web/src/features/bugreport/store.ts). The page's own capture
/// (a copy of the page drawn into a canvas) gives no picture in the iPhone app, so the page asks here first: the web view's
/// own snapshot, taken before the report sheet opens. It is the app's own view, so no permission is involved. Nothing is
/// sent from here; the page decides what to do with the picture, and the owner sees it before anything leaves.
@objc(TalosSnapshotPlugin)
public class TalosSnapshotPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TalosSnapshotPlugin"
    public let jsName = "TalosSnapshot"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capture", returnType: CAPPluginReturnPromise)
    ]

    /// Bigger than this as a PNG and it goes as a JPEG (the page caps a picture at 5 MB and 12 megapixels anyway).
    private static let pngMaxBytes = 3 * 1024 * 1024

    /// `{ dataUrl: "data:image/png;base64,..." }` (or image/jpeg). Refused outside the relay's own page (TalosPluginGate).
    @objc func capture(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed here") }
        DispatchQueue.main.async { [weak self] in
            guard let web = self?.bridge?.webView else { return call.reject("no web view") }
            let config = WKSnapshotConfiguration()
            config.afterScreenUpdates = false // what is on screen now, not after the sheet the page is about to open
            web.takeSnapshot(with: config) { image, error in
                guard let image, error == nil else { return call.reject("snapshot failed") }
                DispatchQueue.global(qos: .userInitiated).async {
                    if let png = image.pngData(), png.count <= Self.pngMaxBytes {
                        return call.resolve(["dataUrl": "data:image/png;base64," + png.base64EncodedString()])
                    }
                    guard let jpg = image.jpegData(compressionQuality: 0.85) else { return call.reject("could not encode") }
                    call.resolve(["dataUrl": "data:image/jpeg;base64," + jpg.base64EncodedString()])
                }
            }
        }
    }
}
