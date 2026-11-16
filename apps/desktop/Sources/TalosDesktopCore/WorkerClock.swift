import Foundation

/// A thread session's idle time is measured on the awake clock (seconds that never jump and stop while the Mac sleeps), so a wall
/// clock that is set, corrected or runs on through a sleep changes nothing by itself. Two things are still wall times: what
/// `workers.json` keeps, and the key times tmux reports for its clients. These put them on the awake clock. The Linux supervisor's
/// twin is worker-idle.ts (`wallJump`, `monoOf`).
public enum WorkerClock {
  /// A wall clock that moved this much more (or less) than the awake clock between two looks has been set or has jumped.
  public static let jumpThreshold: Double = 2

  /// The wall clock against the awake one: `offset` is wall less awake, which only moves when the wall clock is set or jumps, or
  /// runs on through a sleep the awake clock does not count. Compared look to look, so a slow correction never adds up to a jump.
  /// `moved` is how far the wall clock went beyond the awake one since `previousOffset`, or 0.
  public static func jump(previousOffset: Double?, wall: Double, awake: Double) -> (offset: Double, moved: Double) {
    let offset = wall - awake
    let moved = previousOffset.map { offset - $0 } ?? 0
    return (offset, abs(moved) > jumpThreshold ? moved : 0)
  }

  /// A wall time (a tmux client's key, a time from `workers.json`) on the awake clock as the clocks read now. Never in the future: a
  /// time from after "now", as one is once the wall clock has been set back, counts as now.
  public static func awakeTime(ofWall time: Double, wall: Double, awake: Double) -> Double { awake - max(0, wall - time) }
}
