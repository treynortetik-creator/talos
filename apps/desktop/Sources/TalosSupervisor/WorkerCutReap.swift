import Darwin
import Foundation
import TalosDesktopCore

/// The live process table, and the reap of a cut turn's leftovers (the rules are `CutTurnGroups.plan`, pure, in TalosDesktopCore).
public enum CutTurnProcs {
  /// Every process: pid, parent, group, session, exact start. `env`: also whether and what TALOS_APP_WORKER_NONCE says (a read per
  /// process, so only for the reap); a process whose environment the kernel does not show is `.unreadable`. nil: the list cannot be read.
  public static func table(env: Bool) -> [ProcRow]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    var size = 0
    guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    size += size / 4
    var procs = [kinfo_proc](repeating: kinfo_proc(), count: size / MemoryLayout<kinfo_proc>.stride)
    guard sysctl(&mib, 4, &procs, &size, nil, 0) == 0 else { return nil }
    return procs.prefix(size / MemoryLayout<kinfo_proc>.stride).compactMap { p in
      let pid = p.kp_proc.p_pid
      guard pid > 0, p.kp_proc.p_stat != SZOMB else { return nil }
      var e = ProcRow.Env.unreadable
      if env, let snap = ProcessInspect.snapshot(pid), !snap.env.isEmpty { e = .readable(snap.env["TALOS_APP_WORKER_NONCE"]) }
      return ProcRow(
        pid: pid, ppid: p.kp_eproc.e_ppid, pgid: p.kp_eproc.e_pgid, sid: max(getsid(pid), 0), startUs: startUs(p), env: e)
    }
  }

  static func startUs(_ p: kinfo_proc) -> Int64 {
    let tv = p.kp_proc.p_un.__p_starttime
    return Int64(tv.tv_sec) * 1_000_000 + Int64(tv.tv_usec)
  }

  /// The exact start of one process; nil when it is gone (a zombie counts as gone).
  public static func start(_ pid: Int32) -> Int64? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_pid == pid, info.kp_proc.p_stat != SZOMB else { return nil }
    return startUs(info)
  }
}

public enum CutTurnReaper {
  public struct Result: Equatable, Sendable {
    /// Processes that were there to stop, and the ones gone at the end / still there.
    public var killed: [Int32] = []
    public var notKilled: [Int32] = []
    public var skipped: [String] = []
    public var listingFailed = false
  }

  /// How long all the TERMs are given, once, before the KILLs.
  public static let graceSeconds: Double = 2

  /// Ends what the dead launch left running: TERM to everything at once, one shared grace, then KILL for what is left. A group is
  /// signalled as a group only while its leader is still the process that was recorded (exact start); otherwise only the recorded
  /// members that are still those processes (start and session). Never a process matched on its parent or its start alone.
  public static func reap(
    nonce: String, startedAfter: Double, snapshot: GroupSnapshot?, table: () -> [ProcRow]? = { CutTurnProcs.table(env: true) },
    grace: Double = graceSeconds
  ) -> Result {
    guard let rows = table() else { return Result(listingFailed: true) }
    let plan = CutTurnGroups.plan(
      snapshot: snapshot, rows: rows, nonce: nonce, startedAfterUs: Int64(startedAfter * 1_000_000), selfPid: getpid(), selfPgid: getpgrp())
    var out = Result(skipped: plan.skipped)
    let groupIds = Set(plan.groups.map(\.pgid))
    var victims = Set(rows.filter { groupIds.contains($0.pgid) }.map(\.pid))
    for one in plan.pids { victims.insert(one.pid) }
    if victims.isEmpty { return out }
    // a signal to a group, only while its leader is what was recorded; the survivors the leader's absence leaves are the members
    func signalGroup(_ g: Plan.Group, _ sig: Int32) {
      if let want = g.leaderStartUs {
        if CutTurnProcs.start(g.pgid) == want { _ = killpg(g.pgid, sig); return }
        for m in g.recorded where m.pid > 1 && CutTurnProcs.start(m.pid) == m.start_us && getsid(m.pid) == g.sid ?? -1 { _ = kill(m.pid, sig) }
      } else {
        _ = killpg(g.pgid, sig)  // a group found by a process holding the nonce, with no leader of its own
      }
    }
    func signalOne(_ o: CutTurnGroups.Plan.One, _ sig: Int32) {
      if CutTurnProcs.start(o.pid) == o.startUs { _ = kill(o.pid, sig) }
    }
    for g in plan.groups { signalGroup(g, SIGTERM) }
    for o in plan.pids { signalOne(o, SIGTERM) }
    let until = DispatchTime.now() + grace
    func left() -> [Int32] { victims.filter { CutTurnProcs.start($0) != nil && stillTheSame($0, rows) }.sorted() }
    while !left().isEmpty, DispatchTime.now() < until { usleep(25_000) }
    if !left().isEmpty {
      for g in plan.groups { signalGroup(g, SIGKILL) }
      for o in plan.pids { signalOne(o, SIGKILL) }
      let end = DispatchTime.now() + 1
      while !left().isEmpty, DispatchTime.now() < end { usleep(25_000) }
    }
    let still = Set(left())
    out.killed = victims.subtracting(still).sorted()
    out.notKilled = still.sorted()
    return out
  }

  /// The pid is still the process listed (a number reused in the meantime is not).
  static func stillTheSame(_ pid: Int32, _ rows: [ProcRow]) -> Bool {
    guard let was = rows.first(where: { $0.pid == pid }) else { return false }
    return CutTurnProcs.start(pid) == was.startUs
  }
  typealias Plan = CutTurnGroups.Plan
}
