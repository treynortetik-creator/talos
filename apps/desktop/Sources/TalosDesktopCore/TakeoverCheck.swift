import Foundation

/// Single instance, takeover-safe (DESKTOP-SPEC 4.2, review E1). The Telegram plugin and the talos-app bridge each SIGTERM
/// the previous holder when they start, so a second session doesn't fail: it silently deafens the first. Before any start
/// the supervisor refuses if another session holds either one, in any folder. A pure function over read-only snapshots.
public enum TakeoverCheck {
  /// `apps/bridge/src/lifecycle.ts` `BRIDGE_ENTRY`.
  public static let bridgeEntry = "apps/bridge/src/server.ts"
  public static let telegramEntry = "server.ts"
  /// A `bot.pid` holder that started this long after the file was written can't have written it (a recycled pid).
  public static let recycledSlackSeconds: Double = 2

  public struct BotPid: Equatable, Sendable {
    public var pid: Int32
    /// mtime of `bot.pid`, seconds since 1970.
    public var fileModifiedAt: Double
    public var holder: ProcessSnapshot?
    public init(pid: Int32, fileModifiedAt: Double, holder: ProcessSnapshot?) {
      self.pid = pid
      self.fileModifiedAt = fileModifiedAt
      self.holder = holder
    }
  }

  /// `$TALOS_APP_HOME/bridge.pid` (lifecycle.ts `PidRecord`).
  public struct BridgePidRecord: Codable, Equatable, Sendable {
    public var pid: Int32
    public var startedAt: String
    public var instance: String?
    enum CodingKeys: String, CodingKey {
      case pid, instance
      case startedAt = "started_at"
    }
    public init(pid: Int32, startedAt: String, instance: String?) {
      self.pid = pid
      self.startedAt = startedAt
      self.instance = instance
    }
  }

  public struct BridgePid: Equatable, Sendable {
    public var record: BridgePidRecord
    public var ps: PsInfo?
    public var holder: ProcessSnapshot?
    public init(record: BridgePidRecord, ps: PsInfo?, holder: ProcessSnapshot?) {
      self.record = record
      self.ps = ps
      self.holder = holder
    }
  }

  public struct Inputs: Equatable, Sendable {
    /// Process groups that are ours: the current child, the just-exited child, Option C's worker panes.
    public var ourPgids: Set<Int32>
    public var botPid: BotPid?
    public var bridgePid: BridgePid?
    /// nil when `claude agents --json` couldn't be read (checks 1 and 2 still run).
    public var agents: [AgentEntry]?
    /// Snapshots by pid: agents entries' argv, and the group leaders named in blockers (for the folder).
    public var processes: [Int32: ProcessSnapshot]

    public init(
      ourPgids: Set<Int32>, botPid: BotPid?, bridgePid: BridgePid?, agents: [AgentEntry]?,
      processes: [Int32: ProcessSnapshot]
    ) {
      self.ourPgids = ourPgids
      self.botPid = botPid
      self.bridgePid = bridgePid
      self.agents = agents
      self.processes = processes
    }
  }

  public enum Resource: String, Equatable, Sendable {
    case telegram = "Telegram"
    case bridge = "the Talos bridge"
    case channels = "channels"
  }

  public struct Blocker: Equatable, Sendable {
    public var resource: Resource
    /// The process holding it (the poller, the bridge, or the claude session itself).
    public var holderPid: Int32
    /// The holding session's process group = its claude pid when launched from a shell.
    public var sessionPid: Int32
    public var folder: String?

    public var message: String {
      let f = folder.map { ", folder \($0)" } ?? ""
      return "Another Claude session (pid \(sessionPid)\(f)) holds \(resource.rawValue). Quit it first, or press \u{201C}\(BlockedText.adoptButton)\u{201D} to take it over."
    }
  }

  public static func argvHoldsChannels(_ argv: [String]) -> Bool {
    argv.contains { a in
      a == "--channels" || a.hasPrefix("--channels=")
        || a.split(separator: ",").contains { $0.trimmingCharacters(in: .whitespaces) == "server:talos-app" }
    }
  }

  public static func check(_ i: Inputs) -> [Blocker] {
    var out: [Blocker] = []
    func folder(_ pgid: Int32) -> String? { i.processes[pgid]?.cwd }

    if let b = i.botPid, let h = b.holder, h.pid == b.pid, h.commandLine.contains(telegramEntry),
      h.startTime <= b.fileModifiedAt + recycledSlackSeconds, !i.ourPgids.contains(h.pgid)
    {
      out.append(Blocker(resource: .telegram, holderPid: h.pid, sessionPid: h.pgid, folder: folder(h.pgid)))
    }

    if let b = i.bridgePid, let ps = b.ps, ps.lstart == b.record.startedAt, ps.command.contains(bridgeEntry),
      let h = b.holder, h.pid == b.record.pid, !i.ourPgids.contains(h.pgid)
    {
      out.append(Blocker(resource: .bridge, holderPid: h.pid, sessionPid: h.pgid, folder: folder(h.pgid)))
    }

    // Check 3 runs only when `claude agents --json` was readable. A nil list (CLI change, timeout) skips it rather
    // than blocking every start; checks 1 and 2 still cover Telegram and the bridge, the two resources that get taken
    // over (D1-REVIEW finding 7: documented choice).
    for e in i.agents ?? [] where e.isInteractive {
      guard let pid = e.pid, !i.ourPgids.contains(pid), let snap = i.processes[pid], !i.ourPgids.contains(snap.pgid),
        argvHoldsChannels(snap.argv)
      else { continue }
      if out.contains(where: { $0.sessionPid == pid }) { continue }
      out.append(Blocker(resource: .channels, holderPid: pid, sessionPid: pid, folder: e.cwd ?? snap.cwd))
    }
    return out
  }
}
