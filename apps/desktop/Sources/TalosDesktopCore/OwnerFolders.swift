import Foundation

/// Which thread folders the OWNER chose, as the supervisor may rely on it (the bridge writes it: apps/bridge/src/supervisor/owner-folders.ts).
/// Folder trust (`FolderTrust`) is answered only for a folder recorded here. config.json is not enough: `talos-app lead init` and a hand
/// edit write `session_opts.cwd` without the owner looking at the folder, and the trust card that shows the folder is then the owner's check.
/// `<talos home>/owner-folders.json` is `{"v":1,"threads":{"<thread id>":{"cwd":"<as configured>","real":"<its real path then>"}}}`, written only
/// by the bridge after a signed `config.patch` set the folder. A record counts only while the configured folder is still exactly `cwd` and the
/// folder still resolves to `real`: a later change of folder, by anyone, leaves the old record with nothing to match.
public enum OwnerFolders {
  public static let fileName = "owner-folders.json"
  static let maxBytes = 256 * 1024

  public static func read(talosHome: String) -> [String: (cwd: String, real: String)] {
    let path = talosHome + "/" + fileName
    var st = stat()
    guard lstat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= maxBytes,
      let data = FileManager.default.contents(atPath: path),
      let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], j["v"] as? Int == 1,
      let threads = j["threads"] as? [String: Any]
    else { return [:] }
    var out: [String: (cwd: String, real: String)] = [:]
    for (id, r) in threads {
      if let o = r as? [String: Any], let cwd = o["cwd"] as? String, let real = o["real"] as? String { out[id] = (cwd, real) }
    }
    return out
  }

  /// Is `folder` (the resolved folder a start launches in) the owner's choice for the thread: a record for one of `ids` (the thread, and for a
  /// sub-thread sharing its parent's folder, its parent) naming the folder as configured now and as it resolves now.
  public static func chose(talosHome: String, ids: [String], configured: String, folder: String) -> Bool {
    let all = read(talosHome: talosHome)
    return ids.contains { all[$0]?.cwd == configured && all[$0]?.real == folder }
  }
}
