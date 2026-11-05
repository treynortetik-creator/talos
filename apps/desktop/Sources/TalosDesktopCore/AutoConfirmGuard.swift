import Foundation

/// Restart-only auto-confirm of the dev-channel dialog (DESKTOP-SPEC 4.4; owner rule TG 24520; docs/CLAUDE-CODE.md C5).
/// A pure function: `confirm` only when every condition holds. Cold starts are always human.
public enum AutoConfirmGuard {
  public enum StartKind: Equatable, Sendable {
    /// First launch, reboot, manual Start, a changed launch command, a changed CLI version, a lost tmux server.
    case cold
    /// The supervisor restarting a crashed agent inside the same supervision run.
    case supervisorRestart
  }

  public struct Inputs: Equatable, Sendable {
    public var enabled: Bool
    public var startKind: StartKind
    /// The id this start passed with `--resume`, nil for `--session-id`.
    public var launchedResumeId: String?
    public var session: DesktopConfig.Session
    /// `claude --version` now (nil if it couldn't be read).
    public var cliVersion: String?
    public var screen: DialogMatcher.Screen
    /// Enters this start has already sent (the dialog printed twice is never answered twice).
    public var confirmsThisStart: Int
    public var loop: CrashLoop
    public var now: Double

    public init(
      enabled: Bool, startKind: StartKind, launchedResumeId: String?, session: DesktopConfig.Session,
      cliVersion: String?, screen: DialogMatcher.Screen, confirmsThisStart: Int, loop: CrashLoop, now: Double
    ) {
      self.enabled = enabled
      self.startKind = startKind
      self.launchedResumeId = launchedResumeId
      self.session = session
      self.cliVersion = cliVersion
      self.screen = screen
      self.confirmsThisStart = confirmsThisStart
      self.loop = loop
      self.now = now
    }
  }

  public enum Refusal: String, Equatable, Sendable {
    case disabled, coldStart, notResumed, idMismatch, notHumanConfirmed, versionUnknown, versionChanged
    case noDialog, ambiguousDialog, channelsMismatch, wrongHighlight, alreadyConfirmedThisStart, rateLimited
  }

  public enum Decision: Equatable, Sendable {
    case confirm
    case refuse(Refusal)
  }

  public static func decide(_ i: Inputs) -> Decision {
    guard i.enabled else { return .refuse(.disabled) }
    guard i.startKind == .supervisorRestart else { return .refuse(.coldStart) }
    guard let resumed = i.launchedResumeId else { return .refuse(.notResumed) }
    guard let id = i.session.id, id.lowercased() == resumed.lowercased() else { return .refuse(.idMismatch) }
    guard i.session.confirmedAt != nil else { return .refuse(.notHumanConfirmed) }
    guard let now = i.cliVersion, let then = i.session.confirmedCliVersion else { return .refuse(.versionUnknown) }
    guard now == then else { return .refuse(.versionChanged) }
    guard i.confirmsThisStart == 0 else { return .refuse(.alreadyConfirmedThisStart) }
    guard case .devChannels(let d) = i.screen else { return .refuse(.noDialog) }
    guard d.titleCount == 1, d.channelLineCount == 1 else { return .refuse(.ambiguousDialog) }
    // Byte-for-byte, order-insensitive, nothing extra (a duplicate counts as extra).
    // Swift `==` on String is canonical equivalence (NFC "é" == NFD "e\u{301}"); compare UTF-8 bytes instead.
    func bytes(_ l: [String]) -> [[UInt8]] { l.map { Array($0.utf8) }.sorted { $0.lexicographicallyPrecedes($1) } }
    guard let shown = d.channels, !i.session.approvedDevChannels.isEmpty,
      bytes(shown) == bytes(i.session.approvedDevChannels)
    else { return .refuse(.channelsMismatch) }
    guard let hl = d.highlighted, Array(hl.utf8) == Array(DialogMatcher.Strings.devConfirm.utf8) else { return .refuse(.wrongHighlight) }
    guard i.loop.mayAutoConfirm(now: i.now) else { return .refuse(.rateLimited) }
    return .confirm
  }
}
