import CryptoKit
import Foundation
import TalosDesktopCore

/// A problem the Mac app finds in itself, filed in the bridge's problem folder (`$TALOS_APP_HOME/problems/open/<fingerprint>.json`,
/// docs/ERRORS.md) in the same stored shape, so `talos-app errors list` shows it. A repeat raises the count. The caller's text holds no
/// message content, thread name or id. Nothing is thrown: a report that can't be written must never get in the way of the app.
enum MacProblem {
  /// The folder's cap (open and closed together): a new problem is not filed past it.
  static let maxFiles = 200

  static func file(home: String, name: String, message: String, key: String, at: Date) {
    let open = home + "/problems/open"
    let closed = home + "/problems/closed"
    let fp = fingerprint(name: name, key: key)
    let path = open + "/\(fp).json"
    let now = ISOTime.string(at.timeIntervalSince1970)
    let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    var o: [String: Any]
    if let d = FileManager.default.contents(atPath: path), let old = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
      o = old
      o["count"] = ((old["count"] as? Int) ?? 1) + 1
      o["last_seen"] = now
      o["message"] = String(message.prefix(300))
    } else {
      let count = [open, closed].reduce(0) { $0 + ((try? FileManager.default.contentsOfDirectory(atPath: $1))?.count ?? 0) }
      guard count < maxFiles else { return }
      o = [
        "v": 1, "trust": "external", "fingerprint": fp, "source": "mac", "kind": "auto", "name": name,
        "message": String(message.prefix(300)), "frames": [Any](), "device": "mac_app", "routes": [Any](),
        "versions_seen": [["app": version]], "count": 1, "first_seen": now, "last_seen": now, "truncated": false, "ids": [Any](),
      ]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
    try? AtomicFile.write(data, to: path, mode: 0o600)
  }

  /// The same kind of problem in the same step is one file.
  static func fingerprint(name: String, key: String) -> String {
    SHA256.hash(data: Data("auto\nmac\n\(name)\n\(key)".utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description
  }
}
