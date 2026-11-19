import Foundation

/// The Mac's copy of the numbers and names in the shared supervisor contract (`packages/protocol/src/supervisor.ts`, `MAIN_RESTART`
/// and `MainStopReason`) that the Mac's supervisor follows together with the Linux one. Swift cannot import the TypeScript, so
/// `ConfigFileReadTests.theCleanExitCapIsTheContractsNumber` reads that file and fails when the two differ.
public enum MainRestartContract {
  /// `MAIN_RESTART.clean_exits_per_hour`: more exits with code 0 than this in an hour stop Main.
  public static let cleanExitsPerHour = 10
  /// `MAIN_RESTART.resume_error_within_s`: the CLI's resume error counts only on an exit this soon after the spawn.
  public static let resumeErrorWithinS: Double = 30
  /// `MAIN_RESTART.cannot_launch_tries`: a restart after a crash that cannot launch at all gives up at this many tries.
  public static let cannotLaunchTries = 5
  /// `MAIN_RESTART.relay_down_s`: a bridge seen live that reports no relay connection this long is told to the owner.
  public static let relayDownS: Double = 180
  /// `MAIN_RESTART.unseen_s`: status.json's `unseen_oldest_at` this old, with the pane quiet, is a Main that stopped reading.
  public static let unseenS: Double = 300
  /// `MAIN_RESTART.unseen_quiet_s`: how long the pane must have printed nothing for that.
  public static let unseenQuietS: Double = 120
  /// `MAIN_RESTART.model_stall_s`: a told message with no tool call whose working line, screen body (elapsed counter masked) and transcript
  /// file all stood still this long is a model request that may be stuck.
  public static let stallS: Double = 180
  /// `MAIN_RESTART.model_stall_blank_s`: the same wait when NO working line is on the pane at all but the transcript says the model's turn is
  /// pending (the newest user or tool_result record, nothing from the model after it): a frozen request that drew no spinner. Shorter, since
  /// there is no line whose redraw could make a slow turn look alive.
  public static let stallBlankS: Double = 90
  /// `MAIN_RESTART.model_stall_thinking_s`: the same, while the working line's label says "thinking" (a long think is real work).
  public static let stallThinkingS: Double = 300
  /// `MainStopReason` for that stop; the audit log's event name.
  public static let cleanExitLoop = "clean_exit_loop"
}
