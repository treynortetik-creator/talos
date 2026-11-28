import Foundation

/// What a session's tools look like from outside, kept while the session lives so they can be found after it dies. macOS shows no
/// environment for Apple's own binaries (/bin/zsh, /bin/sleep, /usr/bin/perl: verified), and a Bash tool is `/bin/zsh -c …` in a process
/// group of its own, so the nonce on its environment cannot find it. What always can be read is the process table: while the session
/// is alive, the groups led by its descendants are written down (`GroupSnapshot`), with each leader's exact start time. After the death
/// they are found again by that start, which a recycled pid never has.
public struct ProcRow: Equatable, Sendable {
  public enum Env: Equatable, Sendable {
    /// The kernel shows nothing for this process (an Apple binary): it says nothing for or against the nonce.
    case unreadable
    /// Readable; the value of TALOS_APP_WORKER_NONCE, nil when it has none.
    case readable(String?)
  }
  public var pid: Int32
  public var ppid: Int32
  public var pgid: Int32
  public var sid: Int32
  /// `p_starttime` in microseconds since 1970: compared whole, never rounded.
  public var startUs: Int64
  public var env: Env
  public init(pid: Int32, ppid: Int32, pgid: Int32, sid: Int32, startUs: Int64, env: Env = .unreadable) {
    self.pid = pid
    self.ppid = ppid
    self.pgid = pgid
    self.sid = sid
    self.startUs = startUs
    self.env = env
  }
}

public struct GroupSnapshot: Codable, Equatable, Sendable {
  public struct Member: Codable, Equatable, Sendable {
    public var pid: Int32
    public var start_us: Int64
    public init(pid: Int32, start_us: Int64) {
      self.pid = pid
      self.start_us = start_us
    }
  }
  public struct Group: Codable, Equatable, Sendable {
    public var pgid: Int32
    public var sid: Int32
    public var leader_start_us: Int64
    public var members: [Member]
    public init(pgid: Int32, sid: Int32, leader_start_us: Int64, members: [Member]) {
      self.pgid = pgid
      self.sid = sid
      self.leader_start_us = leader_start_us
      self.members = members
    }
  }
  /// The launch this was taken for (its nonce): one of another launch is never used.
  public var nonce: String?
  public var pane_pid: Int32
  public var groups: [Group]
  public init(nonce: String?, pane_pid: Int32, groups: [Group]) {
    self.nonce = nonce
    self.pane_pid = pane_pid
    self.groups = groups
  }
}

public enum CutTurnGroups {
  public static func path(talosHome: String, threadId: String) -> String { "\(talosHome)/workers/\(threadId)/cut-groups.json" }

  /// A second of the clock's grain on the turn's start (the Linux side's REAP_START_SLACK_MS).
  public static let grainUs: Int64 = 1_000_000

  /// The groups led by a descendant of `panePid` (by ppid, any depth): `pgid == leader pid`, not the pane's own group and not ours.
  public static func snapshot(rows: [ProcRow], panePid: Int32, nonce: String?, selfPgid: Int32) -> GroupSnapshot {
    var below: Set<Int32> = [panePid]
    var grew = true
    while grew {
      grew = false
      for r in rows where below.contains(r.ppid) && !below.contains(r.pid) {
        below.insert(r.pid)
        grew = true
      }
    }
    below.remove(panePid)
    var groups: [GroupSnapshot.Group] = []
    for leader in rows.sorted(by: { $0.pid < $1.pid }) where below.contains(leader.pid) && leader.pgid == leader.pid {
      guard leader.pid > 1, leader.pid != panePid, leader.pgid != panePid, leader.pgid != selfPgid else { continue }
      let members = rows.filter { $0.pgid == leader.pgid }.sorted { $0.pid < $1.pid }.map { GroupSnapshot.Member(pid: $0.pid, start_us: $0.startUs) }
      groups.append(.init(pgid: leader.pgid, sid: leader.sid, leader_start_us: leader.startUs, members: members))
    }
    return GroupSnapshot(nonce: nonce, pane_pid: panePid, groups: groups)
  }

  /// Whether the pane's process is in the table, and (when its start is known) is the same process: a reused pid is not the pane.
  public static func paneAlive(rows: [ProcRow], panePid: Int32, startUs: Int64? = nil) -> Bool {
    rows.contains { $0.pid == panePid && (startUs == nil || $0.startUs == startUs) }
  }

  /// What to write after a look. A pane that is dying still reads as alive for a moment while its children already show ppid 1, so an
  /// empty scan is not trusted to mean "no tools" whatever the pane looks like. It keeps every group of the last record whose leader
  /// is still in this table with the same start, and drops the rest. With no such leader left the empty scan clears the record.
  public static func recordAfter(scan: GroupSnapshot, last: GroupSnapshot?, rows: [ProcRow]) -> GroupSnapshot {
    guard scan.groups.isEmpty, let last, !last.groups.isEmpty else { return scan }
    let kept = last.groups.filter { g in rows.contains { $0.pid == g.pgid && $0.startUs == g.leader_start_us } }
    if kept.isEmpty { return scan }
    var out = last
    out.groups = kept
    return out
  }

  /// What to signal. `groups`: the whole group (`killpg`), with the leader's start to check again before each signal (nil: no leader to
  /// check). `pids`: single processes. `skipped`: said in the audit.
  public struct Plan: Equatable, Sendable {
    public struct Group: Equatable, Sendable {
      public var pgid: Int32
      public var leaderStartUs: Int64?
      public var recorded: [GroupSnapshot.Member]
      public var sid: Int32?
    }
    public struct One: Equatable, Sendable {
      public var pid: Int32
      public var startUs: Int64
    }
    public var groups: [Group] = []
    public var pids: [One] = []
    public var skipped: [String] = []
    public init() {}
  }

  /// Nothing readable in the group says another launch (or no launch) owns it. A member whose environment cannot be read says nothing
  /// either way (the Linux side's rule, which has the same case: a binary that hides its environment).
  static func groupIsTheLaunchs(_ g: Int32, _ rows: [ProcRow], nonce: String) -> Bool {
    for r in rows where r.pgid == g {
      if case .readable(let n) = r.env, n != nonce { return false }
    }
    return true
  }

  public static func plan(
    snapshot: GroupSnapshot?, rows: [ProcRow], nonce: String, startedAfterUs: Int64, selfPid: Int32, selfPgid: Int32
  ) -> Plan {
    var out = Plan()
    let bound = startedAfterUs - grainUs
    func ours(_ g: Int32) -> Bool { g > 1 && g != selfPgid }
    // 1. the recorded groups
    if let snap = snapshot, snap.nonce == nonce {
      for rec in snap.groups where ours(rec.pgid) && rec.pgid != snap.pane_pid {
        let leader = rows.first { $0.pid == rec.pgid && $0.pgid == rec.pgid }
        if let leader, leader.startUs == rec.leader_start_us {
          guard leader.startUs >= bound else { continue }  // an earlier turn's, left on purpose
          if groupIsTheLaunchs(rec.pgid, rows, nonce: nonce) {
            out.groups.append(.init(pgid: rec.pgid, leaderStartUs: leader.startUs, recorded: rec.members, sid: rec.sid))
          } else {
            out.skipped.append("group \(rec.pgid) has a member with another nonce")
          }
          continue
        }
        // the leader is gone (or the pid is someone else's now): only the recorded members that are still those processes
        guard groupIsTheLaunchs(rec.pgid, rows, nonce: nonce) else {
          out.skipped.append("group \(rec.pgid) has a member with another nonce")
          continue
        }
        for m in rec.members where m.pid > 1 && m.pid != selfPid {
          guard let now = rows.first(where: { $0.pid == m.pid }), now.startUs == m.start_us, now.startUs >= bound, now.sid == rec.sid else { continue }
          if case .readable(let n) = now.env, n != nonce { continue }
          out.pids.append(.init(pid: m.pid, startUs: m.start_us))
        }
      }
    }
    // 2. what holds the nonce, and the whole group of each
    let planned = Set(out.groups.map(\.pgid))
    let alreadyOne = Set(out.pids.map(\.pid))
    for r in rows.sorted(by: { $0.pid < $1.pid }) {
      guard r.pid > 1, r.pid != selfPid, case .readable(let n) = r.env, n == nonce, r.startUs >= bound else { continue }
      if ours(r.pgid), !planned.contains(r.pgid), !out.groups.contains(where: { $0.pgid == r.pgid }) {
        let leader = rows.first { $0.pid == r.pgid && $0.pgid == r.pgid }
        // a group whose leader began before the turn is an earlier turn's (a server left on purpose): a late child of it is only itself
        if groupIsTheLaunchs(r.pgid, rows, nonce: nonce), leader == nil || leader!.startUs >= bound {
          out.groups.append(.init(pgid: r.pgid, leaderStartUs: leader?.startUs, recorded: [], sid: nil))
          continue
        }
      }
      if !planned.contains(r.pgid), !out.groups.contains(where: { $0.pgid == r.pgid }), !alreadyOne.contains(r.pid), !out.pids.contains(where: { $0.pid == r.pid }) {
        out.pids.append(.init(pid: r.pid, startUs: r.startUs))
      }
    }
    return out
  }

  // MARK: the file

  public static func load(_ path: String) -> GroupSnapshot? {
    FileManager.default.contents(atPath: path).flatMap { try? JSONDecoder().decode(GroupSnapshot.self, from: $0) }
  }

  public static func save(_ s: GroupSnapshot, to path: String) throws {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    try AtomicFile.write(try enc.encode(s), to: path, mode: 0o600)
  }
}
