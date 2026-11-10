import Foundation

/// Auto-accept of the development-channels warning on Main, at every start (DESKTOP-SPEC 4.4; docs/CLAUDE-CODE.md C5).
///
/// The owner rule TG 24520, "cold starts are always human", was RETIRED by the owner on 2026-11-07. His words: "This keeps popping up
/// when you reset your session. If there's a way to get around this, let's figure that out so we don't have to mess with it in the
/// future. Or, if you can check that off for me somehow". The old conditions that tied the answer to a restart of a conversation a human
/// had confirmed (cold start, resumed id, human-confirmed, same CLI version, the channels in desktop.json) are gone: they protected
/// against a screen that is not the warning, and the exact-screen conditions below do that without them.
///
/// A pure function: `confirm` only when every condition holds, otherwise the first one that fails is the reason (and the start stays at
/// Needs you, as it always did):
///  - the "Press Enter for me" setting is on, and this is Main (a worker can never get the flag: `WorkerSpec.forbiddenArgs`);
///  - this start has sent no Enter yet (the warning printed twice is never answered twice);
///  - the screen is the whole warning: exactly one title and one `Channels:` line, and the cursor on "I am using this for local
///    development" (`DialogMatcher`; a log line that quotes the warning has no cursor row and is not a dialog);
///  - the channels shown are EXACTLY `["server:talos-app"]` (`talosChannel`, a constant in code: the one channel Talos itself adds,
///    byte for byte, nothing extra), AND the channels THIS launch's argv passed with `--dangerously-load-development-channels`
///    (`channels(inArgv:)`) are exactly that same constant. The launch command lives in desktop.json, which an agent may be able to
///    write, so neither an approved list from a file nor "whatever the argv passed" ever widens what is answered: another channel,
///    an extra one, a second flag, or a screen and argv that disagree all stay at Needs you;
///  - Main's launch is the one the owner last confirmed (`launchChanged`): the launch fingerprint of this start equals the one stored
///    when a start last got through the warning. A changed program, flag, env var or folder, or none stored yet, waits for the owner
///    (a Needs-you card he taps); an ordinary cold start or restart with the same launch does not. The stored fingerprint lives in
///    desktop.json but is sealed with a MAC under a Keychain key (`LaunchTrust`, `LaunchSeal.isConfirmed`): no key, no MAC or a wrong one
///    counts as changed, so an agent that writes the file cannot confirm a launch; the floor under that is the constant-channel check above;
///  - it is within `window` (60 s, the awake clock the supervisor uses, `Options.awake`) of this start's spawn;
///  - no attached tmux client has typed lately, and clients that cannot be read count as typing (the supervisor computes this);
///  - the rate limit allows another auto-confirm (the supervisor passes the crash loop's count for a crash restart and a separate,
///    larger one for a cold start, so an owner's resets never spend the crash loop's budget).
/// The supervisor adds a fresh screen read right before the Enter: the same warning must still be there.
public enum AutoConfirmGuard {
  /// Seconds after the start's spawn (awake clock) during which the warning may be answered.
  public static let window: Double = 60

  /// The one development channel Talos adds to Main's launch, and the only one whose warning is ever answered.
  public static let talosChannel = "server:talos-app"

  public struct Inputs: Equatable, Sendable {
    public var enabled: Bool
    /// Main's supervisor. A worker's pane is never answered.
    public var isMain: Bool
    /// The channels this start's argv passed with `--dangerously-load-development-channels` (must be exactly `talosChannel`).
    public var launchedChannels: [String]
    public var screen: DialogMatcher.Screen
    /// This start's launch differs from the last confirmed one, or none is stored. No default: every caller says it.
    public var launchChanged: Bool
    /// Awake-clock seconds since this start was spawned.
    public var secondsSinceSpawn: Double
    /// Enters this start has already sent (the dialog printed twice is never answered twice).
    public var confirmsThisStart: Int
    /// An attached tmux client typed within the quiet window, or the clients could not be read. Only a tmux host has clients: the
    /// app-owned pty has none, so typing in its embedded terminal is never seen (nor can it be refused here).
    public var clientsMayBeTyping: Bool
    public var loop: CrashLoop
    public var now: Double

    public init(
      enabled: Bool, isMain: Bool, launchedChannels: [String], screen: DialogMatcher.Screen, launchChanged: Bool,
      secondsSinceSpawn: Double, confirmsThisStart: Int, clientsMayBeTyping: Bool, loop: CrashLoop, now: Double
    ) {
      self.enabled = enabled
      self.isMain = isMain
      self.launchedChannels = launchedChannels
      self.screen = screen
      self.launchChanged = launchChanged
      self.secondsSinceSpawn = secondsSinceSpawn
      self.confirmsThisStart = confirmsThisStart
      self.clientsMayBeTyping = clientsMayBeTyping
      self.loop = loop
      self.now = now
    }
  }

  public enum Refusal: String, Equatable, Sendable {
    case disabled, notMain, noDialog, ambiguousDialog, channelsMismatch, wrongHighlight, alreadyConfirmedThisStart, rateLimited
    case outsideWindow, clientsMayBeTyping
    /// Main's launch (folder, program, flags, env) is not the one last confirmed, or none was.
    case launchChanged
    /// The screen read right before the Enter was not the screen the decision was made on.
    case screenChanged
  }

  public enum Decision: Equatable, Sendable {
    case confirm
    case refuse(Refusal)
  }

  /// The channels an argv passes with `--dangerously-load-development-channels`: every value after the flag up to the next option, and
  /// the `--flag=value` form, from every occurrence of the flag. One argv element is one channel (never split), so a value with a
  /// comma can never equal what the screen shows.
  public static func channels(inArgv args: [String]) -> [String] {
    let flag = "--dangerously-load-development-channels"
    var out: [String] = []
    var collecting = false
    for a in args {
      if a == flag {
        collecting = true
      } else if a.hasPrefix(flag + "=") {
        collecting = false
        out.append(String(a.dropFirst(flag.count + 1)))
      } else if a.hasPrefix("-") {
        collecting = false
      } else if collecting {
        out.append(a)
      }
    }
    return out
  }

  public static func decide(_ i: Inputs) -> Decision {
    guard i.enabled else { return .refuse(.disabled) }
    guard i.isMain else { return .refuse(.notMain) }
    guard i.confirmsThisStart == 0 else { return .refuse(.alreadyConfirmedThisStart) }
    guard case .devChannels(let d) = i.screen else { return .refuse(.noDialog) }
    guard d.titleCount == 1, d.channelLineCount == 1 else { return .refuse(.ambiguousDialog) }
    // Both lists must be exactly the one constant, byte for byte (a duplicate counts as extra).
    // Swift `==` on String is canonical equivalence (NFC "é" == NFD "e\u{301}"); compare UTF-8 bytes instead.
    func bytes(_ l: [String]) -> [[UInt8]] { l.map { Array($0.utf8) } }
    let only = bytes([talosChannel])
    guard let shown = d.channels, bytes(shown) == only, bytes(i.launchedChannels) == only else {
      return .refuse(.channelsMismatch)
    }
    guard let hl = d.highlighted, Array(hl.utf8) == Array(DialogMatcher.Strings.devConfirm.utf8) else { return .refuse(.wrongHighlight) }
    guard !i.launchChanged else { return .refuse(.launchChanged) }
    guard i.secondsSinceSpawn <= window else { return .refuse(.outsideWindow) }
    guard !i.clientsMayBeTyping else { return .refuse(.clientsMayBeTyping) }
    guard i.loop.mayAutoConfirm(now: i.now) else { return .refuse(.rateLimited) }
    return .confirm
  }
}
