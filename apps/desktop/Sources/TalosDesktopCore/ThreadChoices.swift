import Foundation

/// The threads Mac settings offers for the crash post (`notify_thread`). Read-only from `$TALOS_APP_HOME/config.json`, the
/// way the supervisor reads `default_thread`: the Mac app never writes that file.
public enum ThreadChoices {
  public struct Item: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
  }

  public struct Listing: Equatable, Sendable {
    public var threads: [Item]
    public var defaultThread: String?
    /// False when the file is missing or isn't a JSON object: the picker says so instead of showing an empty list.
    public var readable: Bool
    public static let unreadable = Listing(threads: [], defaultThread: nil, readable: false)
  }

  /// `$TALOS_APP_HOME/config.json`, with the same home the rest of the app resolves (the desktop.json `env`, then the process
  /// environment, then `~/.config/talos/app`).
  public static func configPath(configEnv: [String: String], processEnv: [String: String], home: String) -> String {
    func nonEmpty(_ v: String?) -> String? { v.flatMap { $0.isEmpty ? nil : $0 } }
    let appHome = nonEmpty(configEnv["TALOS_APP_HOME"]) ?? nonEmpty(processEnv["TALOS_APP_HOME"]) ?? home + "/.config/talos/app"
    return PathUtil.expandTilde(appHome, home: home) + "/config.json"
  }

  /// One bad thread entry costs that thread, never the list. Archived threads and the Inbox are not offered: a crash post
  /// there would never be seen.
  public static func read(_ data: Data?) -> Listing {
    guard let data, let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return .unreadable }
    var out: [Item] = []
    for t in (root["threads"] as? [Any]) ?? [] {
      guard let o = t as? [String: Any], let id = o["id"] as? String, !id.isEmpty else { continue }
      if o["archived"] as? Bool == true { continue }
      if o["kind"] as? String == "system" { continue }
      let name = (o["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id
      out.append(Item(id: id, name: name))
    }
    return Listing(threads: out, defaultThread: root["default_thread"] as? String, readable: true)
  }

  public struct Option: Equatable, Sendable, Identifiable {
    /// nil = the default thread.
    public var value: String?
    public var label: String
    public var id: String { value ?? "" }
  }

  /// The picker's rows. The first is always "default thread" (empty means the default). A saved id the listing doesn't contain
  /// stays selectable and says it can't be found, so opening Mac settings never rewrites it.
  public static func options(_ l: Listing, current: String?) -> [Option] {
    let defName = l.defaultThread.flatMap { id in l.threads.first { $0.id == id }?.name ?? id }
    var rows = [Option(value: nil, label: defName.map { "Default thread (\($0))" } ?? "Default thread")]
    rows += l.threads.map { Option(value: $0.id, label: $0.name) }
    if let c = current, !c.isEmpty, !l.threads.contains(where: { $0.id == c }) {
      rows.append(Option(value: c, label: "\(c) (not found in your threads)"))
    }
    return rows
  }

  public static func note(_ l: Listing) -> String {
    l.readable
      ? "Where the post goes when the agent keeps crashing. It uses the choice at the moment it posts."
      : "Couldn't read your threads (the Talos config.json is missing or damaged). The post goes to the default thread."
  }

  /// What a pick means in the file: the default thread is stored as nothing.
  public static func stored(_ pick: String?) -> String? { (pick?.isEmpty ?? true) ? nil : pick }
}
