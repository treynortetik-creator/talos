import Foundation

/// A sub-thread is a thread with a `parent_id`. Its session options follow `effectiveSessionOpts` in `packages/protocol/src/sub-threads.ts`:
/// the folder, model and effort come from the sub-thread's own `session_opts`, else from its live parent's. Its MCP list is its own list
/// limited to its parent's (`own ∩ parent`; no list on one side is no limit from it), or its parent's when it has none. Only one level is
/// followed: a parent that itself has a parent, an archived or missing parent, and a `parent_id` that cannot be read all count as no parent
/// (the sub-thread keeps its own list, and with none gets the empty list). `ops_read` and `idle_park_min` are never inherited. The Mac reads
/// the config itself, so this is that rule again, in Swift. Nothing in the launcher reads a sub-thread's `session_opts` any other way.
public enum SubThreads {
  public struct Opts: Equatable, Sendable {
    public var cwd: String?
    public var model: String?
    public var effort: String?
    public var mcpAllow: [String]?
    /// Which of `cwd`, `model`, `effort`, `mcp_allow` came from the parent, in that order.
    public var inherited: [String] = []
    /// Names on the sub-thread's own MCP list that its parent's list does not have: left out of `mcpAllow`.
    public var dropped: [String] = []
    /// A `model` or `effort` the thread sets that is not valid (read as not set), by name, with the value as a short plain string.
    public var unreadable: [String: String] = [:]
    /// A `cwd` the thread sets that is present, not null and not text: the value as a short plain string. The folder is then refused, never inherited.
    public var cwdUnreadable: String?
  }

  /// A value as a short, printable string for a message.
  static func shown(_ v: Any) -> String {
    var text: String
    if let s = v as? String {
      text = s
    } else if let a = v as? [Any], a.count == 1 {
      text = shown(a[0])
    } else if let d = v as? [String: Any], d.count == 1, let k = d.keys.first {
      text = k
    } else if let n = v as? NSNumber {
      text = n.stringValue
    } else {
      text = String(describing: v)
    }
    text = String(String.UnicodeScalarView(text.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7f ? " " : $0 }))
    return String(text.prefix(40))
  }

  static func isEffort(_ s: String) -> Bool { !s.isEmpty && s.utf8.count <= 16 && s.utf8.allSatisfy { $0 >= 97 && $0 <= 122 } }

  /// What the thread itself sets. A `session_opts` that is present but not an object, or a list that cannot be read, is the empty MCP list:
  /// never "no list". A model of `inherit` is not set. A model or effort that is not valid is not set and is reported in `unreadable`.
  static func own(_ t: [String: Any]) -> Opts {
    let raw = t["session_opts"]
    let broken = raw != nil && !(raw is NSNull) && !(raw is [String: Any])
    let o = raw as? [String: Any] ?? [:]
    var out = Opts(mcpAllow: broken ? [] : McpAllow.read(o["mcp_allow"]))
    if broken {
      out.cwdUnreadable = shown(raw as Any)
      return out
    }
    switch o["cwd"] {
    case nil, is NSNull: break
    case let s as String: out.cwd = s
    case let other?: out.cwdUnreadable = shown(other)
    }
    switch o["model"] {
    case nil, is NSNull: break
    case let s as String where s == "inherit": break
    case let s as String where WorkerSpec.isModel(s): out.model = s
    case let other?: out.unreadable["model"] = shown(other)
    }
    switch o["effort"] {
    case nil, is NSNull: break
    case let s as String where isEffort(s): out.effort = s
    case let other?: out.unreadable["effort"] = shown(other)
    }
    return out
  }

  /// The idle time before a session parks: the thread's own, never its parent's.
  public static func idleParkMin(_ t: [String: Any]) -> Int {
    let o = t["session_opts"] as? [String: Any]
    return min(720, max(5, (o?["idle_park_min"] as? Int) ?? 30))
  }

  enum Link {
    case none
    /// A live parent that has no parent of its own.
    case live([String: Any])
    /// No parent to take anything from: archived, not in the config, or itself a sub-thread (only one level is followed).
    case orphan(why: String)
    /// `parent_id` is not a thread id.
    case broken
  }

  static func isArchived(_ v: Any?) -> Bool {
    switch v {
    case nil, is NSNull: return false
    case let b as Bool: return b
    case let n as NSNumber: return n.intValue != 0
    case let s as String: return !s.isEmpty
    default: return true
    }
  }

  static func link(_ t: [String: Any], in threads: [[String: Any]]) -> Link {
    guard let raw = t["parent_id"], !(raw is NSNull) else { return .none }
    guard let pid = raw as? String, WorkerSpec.isThreadId(pid) else { return .broken }
    // its own parent: no telling what a parent would allow, so not even its own list stands
    if pid == t["id"] as? String { return .broken }
    // the first thread with that id; it is gone if it is archived (anything but false or absent counts, as in the protocol)
    guard let p = threads.first(where: { $0["id"] as? String == pid }), !isArchived(p["archived"]) else {
      return .orphan(why: "the parent thread is not there any more")
    }
    if let up = p["parent_id"], !(up is NSNull) { return .orphan(why: "the parent thread is itself a sub-thread") }
    return .live(p)
  }

  /// `t`'s options after inheritance.
  public static func effective(_ t: [String: Any], in threads: [[String: Any]]) -> Opts {
    var out = own(t)
    switch link(t, in: threads) {
    case .none:
      break
    case .broken:
      // cannot tell what the parent allows: nothing
      out.dropped = out.mcpAllow ?? []
      out.mcpAllow = []
    case .orphan:
      if out.mcpAllow == nil { out.mcpAllow = [] }
    case .live(let p):
      let up = own(p)
      if out.cwd == nil, out.cwdUnreadable == nil, let v = up.cwd {
        out.cwd = v
        out.inherited.append("cwd")
      }
      if out.model == nil, let v = up.model {
        out.model = v
        out.inherited.append("model")
      }
      if out.effort == nil, let v = up.effort {
        out.effort = v
        out.inherited.append("effort")
      }
      switch (out.mcpAllow, up.mcpAllow) {
      case (nil, let v?):
        out.mcpAllow = v
        out.inherited.append("mcp_allow")
      case (let mine?, let theirs?):
        out.mcpAllow = mine.filter { theirs.contains($0) }
        out.dropped = mine.filter { !theirs.contains($0) }
      default:
        break
      }
    }
    return out
  }

  /// What the launcher needs of a sub-thread beyond its effective options.
  public struct Launch: Equatable, Sendable {
    public var parentId: String
    /// The live parent's own folder; nil when the sub-thread cannot start (see `refusal`).
    public var parentCwd: String?
    /// The sub-thread sets a folder of its own, not the parent's: strictly inside the parent's (made when missing), or an existing one outside.
    public var ownCwd: Bool
    /// It runs in its parent's folder (the agent folder when the parent has none): it names none, or the parent's own (`subthreads_shared_folder`).
    /// Then nothing is made, fenced or parked for it, and `Workers.swift` hands on the parent's folder as its `cwd` with no `parentCwd`.
    public var shares: Bool = false
    public var inherited: [String]
    public var dropped: [String]
    /// The sub-thread's own `model` and `effort` settings that were not valid, by name, with the value: the session took its parent's instead.
    public var unreadable: [String: String]
    /// Why this session cannot start, when it cannot.
    public var refusal: String?
  }

  /// nil for a thread with no `parent_id` (a `parent_id` that cannot be read is a sub-thread with no live parent, never "not a sub-thread").
  /// A dedicated sub-thread has a folder of its own inside its parent's, or none, or the parent's own: with none or the same it `shares`
  /// the parent's folder.
  public static func launch(_ t: [String: Any], in threads: [[String: Any]]) -> Launch? {
    guard let raw = t["parent_id"], !(raw is NSNull) else { return nil }
    let mine = own(t)
    let eff = effective(t, in: threads)
    var parentCwd: String?
    var refusal: String?
    var shares = false
    if let bad = mine.cwdUnreadable {
      refusal = "the sub-thread's folder setting can't be read (\(bad)): it must be a path"
    } else {
      switch link(t, in: threads) {
      case .live(let p):
        let up = own(p)
        parentCwd = up.cwd
        if let bad = up.cwdUnreadable {
          // a parent whose folder setting cannot be read is refused itself: a child must not fall back to the agent folder (Main's)
          refusal = "the parent thread's folder setting can't be read (\(bad)): fix it, so the sub-thread has a folder to follow"
        } else if let cwd = mine.cwd {
          if let parentCwd { shares = sameFolder(cwd, parentCwd) } else { refusal = "the parent thread has no folder: give the parent a folder first" }
        } else {
          shares = true
        }
      case .orphan(let why):
        refusal = "\(why), so the sub-thread's folder has nothing to be inside"
      case .none, .broken:
        refusal = "the sub-thread's parent can't be read, so its folder has nothing to be inside"
      }
    }
    return Launch(
      parentId: raw as? String ?? "", parentCwd: parentCwd, ownCwd: mine.cwd != nil && !shares, shares: shares, inherited: eff.inherited,
      dropped: eff.dropped, unreadable: mine.unreadable, refusal: refusal)
  }

  /// The same folder, written the same way: equal once trailing slashes go, and neither has a `.` or `..` segment. A link to it, or a path
  /// that only resolves to it, is not: that goes through the strict folder check and is refused there.
  static func sameFolder(_ child: String, _ parent: String) -> Bool {
    func trimmed(_ p: String) -> String {
      var t = p
      while t.count > 1, t.hasSuffix("/") { t.removeLast() }
      return t
    }
    guard child.hasPrefix("/"), parent.hasPrefix("/"), !child.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return false }
    return trimmed(child) == trimmed(parent)
  }

  /// Are two thread sessions one family for the folder claim: a parent and a dedicated sub-thread of its that shares its folder, or two such
  /// sub-threads of one parent? The folder claimed is then the parent's effective one (a sharing sub-thread's `cwd` is that folder).
  /// A sub-thread with a subfolder of its own, two threads of different parents, and any unrelated pair are not.
  public static func sameFamily(_ a: ThreadSessionSettings, _ b: ThreadSessionSettings?) -> Bool {
    guard let b, a.threadId != b.threadId else { return false }
    let pa = a.sub.flatMap { $0.shares && $0.refusal == nil ? $0.parentId : nil }
    let pb = b.sub.flatMap { $0.shares && $0.refusal == nil ? $0.parentId : nil }
    if let pa, pa == b.threadId || pa == pb { return true }
    return pb == a.threadId
  }
}
