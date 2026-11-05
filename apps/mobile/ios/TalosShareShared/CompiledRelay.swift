import Foundation

/// The relay origin is the build-time `server.url` in Capacitor's generated `capacitor.config.json`, which sits in the app
/// bundle. The share extension lives in `App.app/PlugIns/TalosShare.appex`, so it reads the same file from its parent
/// bundle. It is never taken from a web page, a share, or a plugin argument (IOS-SPEC I5, E15).
enum CompiledRelay {
    static func url(bundle: Bundle = .main) -> URL? {
        for root in candidates(bundle) {
            let file = root.appendingPathComponent("capacitor.config.json")
            guard let data = try? Data(contentsOf: file),
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let server = json["server"] as? [String: Any],
                let raw = server["url"] as? String,
                let url = URL(string: raw), url.host != nil
            else { continue }
            return url
        }
        return nil
    }

    private static func candidates(_ bundle: Bundle) -> [URL] {
        var roots = [bundle.bundleURL]
        if bundle.bundleURL.pathExtension == "appex" {
            roots.append(bundle.bundleURL.deletingLastPathComponent().deletingLastPathComponent())
        }
        return roots
    }
}
