import Foundation

/// workers.json read entry by entry, as the protocol's contract says (`packages/protocol/src/workers-unreadable.ts`, which a test
/// reads to keep the names and the words the same). One entry this build cannot read never costs the others: it is set aside as
/// its JSON text under `unreadable_threads`, carried on unchanged by every save, and comes back once it reads. A file that cannot
/// be read at all is refused, so nothing is saved over it.
public struct WorkersFileRead: Equatable, Sendable {
  public static let unreadableKey = "unreadable_threads"
  public static let entriesNoticeId = "workers_entries_unreadable"
  public static let fileNoticeId = "workers_file_unreadable"
  public static let entriesNoticeText =
    "Talos could not read the saved sessions of {threads}. They are kept in workers.json. To start their own sessions again, quit Talos, fix or delete those entries, and open Talos again."
  public static let fileNoticeText =
    "Talos could not read workers.json, so it will not save over it. Thread sessions are paused until the file is fixed or removed."

  public enum Outcome: Equatable, Sendable {
    /// No file, or an empty one: nothing to lose, a fresh start.
    case none
    /// The whole file cannot be read: never save over it.
    case refused
    case read(WorkersFileRead)
  }

  /// The entries that read. The supervisor block is the file's when it reads, else a blank one (adopt never reads it, and the next
  /// save writes a new one).
  public var file: WorkersFile
  /// Every entry that does not read, by its key as found: its JSON text.
  public var unreadable: [String: String] = [:]

  /// The keys set aside that are thread ids, sorted: what the notice names.
  public var unreadableThreadIds: [String] { unreadable.keys.filter(WorkerSpec.isThreadId).sorted() }
  /// Keys set aside that are not thread ids: counted in the notice, never named.
  public var unnamedCount: Int { unreadable.count - unreadableThreadIds.count }
  /// The one line about the entries set aside; nil when there are none.
  public var entriesNotice: String? {
    unreadable.isEmpty ? nil : Self.entriesNotice(threads: unreadableThreadIds, others: unnamedCount)
  }

  public static func entriesNotice(threads: [String], others: Int) -> String {
    let names = threads + (others > 0 ? ["\(others) other"] : [])
    return entriesNoticeText.replacingOccurrences(of: "{threads}", with: names.joined(separator: ", "))
  }

  public static func read(_ data: Data?) -> Outcome {
    guard let data, !data.isEmpty else { return .none }
    guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let v = root["v"] as? NSNumber, !isBool(v), v == 1,
      let threads = root["threads"] as? [String: Any]
    else { return .refused }
    var kept: [String: Any] = [:]
    if let k = root[unreadableKey] {
      guard let k = k as? [String: Any] else { return .refused }
      kept = k
    }
    let supervisor =
      (root["supervisor"].flatMap { try? JSONDecoder().decode(WorkersFile.Supervisor.self, from: text($0)) })
      ?? .init(pid: 0, heartbeat_at: "", workers_supported: false, main_pane_pid: 0)
    var out = WorkersFileRead(file: WorkersFile(supervisor: supervisor))
    for (key, value) in threads {
      if let e = entry(key, value) { out.file.threads[key] = e } else { out.unreadable[key] = String(decoding: text(value), as: UTF8.self) }
    }
    for (key, value) in kept {
      let s = (value as? String) ?? String(decoding: text(value), as: UTF8.self)
      if out.file.threads[key] == nil, out.unreadable[key] == nil,
        let v = try? JSONSerialization.jsonObject(with: Data(s.utf8), options: .fragmentsAllowed), let e = entry(key, v)
      {
        out.file.threads[key] = e
      } else if out.unreadable[key] != s {
        // `threads` has this key too: both are kept, this one under a key that is not a thread id, so it never holds a
        // thread that reads back from starting
        var k = key
        while out.file.threads[k] != nil || out.unreadable[k] != nil { k += "#" }
        out.unreadable[k] = s
      }
    }
    return .read(out)
  }

  /// `file` as `WorkersFile.encoded()` writes it, with the entries set aside under their key. With none, byte for byte the same.
  public static func encoded(_ file: WorkersFile, keeping unreadable: [String: String]) throws -> Data {
    let data = try file.encoded()
    guard !unreadable.isEmpty else { return data }
    guard var root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CocoaError(.coderInvalidValue) }
    root[unreadableKey] = unreadable
    return try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
  }

  private static func entry(_ key: String, _ value: Any) -> WorkersFile.Entry? {
    guard WorkerSpec.isThreadId(key), value is [String: Any] else { return nil }
    return try? JSONDecoder().decode(WorkersFile.Entry.self, from: text(value))
  }

  /// A value's JSON text, keys sorted, so the same value is always the same text.
  private static func text(_ value: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]))
      ?? Data("null".utf8)
  }

  private static func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }
}
