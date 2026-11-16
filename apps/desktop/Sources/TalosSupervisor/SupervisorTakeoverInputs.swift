import Foundation
import TalosDesktopCore

// Moved out of Supervisor.swift to keep it under the size budget.
extension Supervisor {
  // MARK: takeover inputs (read-only)

  func gatherTakeover(env: [String: String], claude: String) -> TakeoverCheck.Inputs {
    var processes: [Int32: ProcessSnapshot] = [:]
    var bot: TakeoverCheck.BotPid?
    if let d = probe.readFile(botPidPath),
      let pid = Int32(String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0
    {
      let holder = probe.snapshot(pid)
      bot = TakeoverCheck.BotPid(pid: pid, fileModifiedAt: probe.modifiedAt(botPidPath) ?? 0, holder: holder)
      if let g = holder?.pgid, processes[g] == nil { processes[g] = probe.snapshot(g) }
    }
    var bridge: TakeoverCheck.BridgePid?
    if let d = probe.readFile(bridgePidPath),
      let rec = try? JSONDecoder().decode(TakeoverCheck.BridgePidRecord.self, from: d)
    {
      let holder = probe.snapshot(rec.pid)
      bridge = TakeoverCheck.BridgePid(record: rec, ps: probe.psInfo(rec.pid), holder: holder)
      if let g = holder?.pgid, processes[g] == nil { processes[g] = probe.snapshot(g) }
    }
    let agents = probe.agents(claude: claude, env: env)
    for e in agents ?? [] where e.isInteractive {
      if let pid = e.pid, processes[pid] == nil { processes[pid] = probe.snapshot(pid) }
    }
    return TakeoverCheck.Inputs(
      ourPgids: ownedGroupsLocked.union(options.siblingGroups?() ?? []), botPid: bot, bridgePid: bridge, agents: agents, processes: processes)
  }
}
