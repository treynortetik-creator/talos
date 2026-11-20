import Foundation

/// Main's launch always carries `--dangerously-load-development-channels server:talos-app`. Without it Claude Code loads the bridge as
/// a plain tool and Main gets no pushed messages (a launch command imported without the flag did exactly that after an update on
/// 2026-11-19). It is on every launch, and the app writes it into the saved command too (Import, Adopt, the launch box, the permission
/// picker, and a start that finds it missing), so the Session box, the Copy Terminal command and the rollback command show what Main
/// runs. A command that names the flag with channels of the owner's own keeps every one of them: ours is added beside them, once.
/// `AutoConfirmGuard` still answers the warning only when the Talos channel is the only one.
public enum MainChannelFlag {
  public static let flag = "--dangerously-load-development-channels"

  public static func ensured(_ args: [String]) -> [String] {
    let end = args.firstIndex(of: "--") ?? args.count
    let flags = Array(args[..<end])
    let channel = AutoConfirmGuard.talosChannel
    if AutoConfirmGuard.channels(inArgv: flags).contains(channel) { return args }
    // the flag with the owner's channels after it (the space form): ours joins it, first, so theirs all stay
    if let at = flags.firstIndex(of: flag) {
      var out = args
      out.insert(channel, at: at + 1)
      return out
    }
    let add = [flag, channel]
    // after the owner's flags; but when the last one still waits for its value, the pair would become that value: then first
    if MainArgs.swallowsAppended(flags) { return add + args }
    var out = args
    out.insert(contentsOf: add, at: end)
    return out
  }

  /// The arguments without the Talos channel pair (`--flag server:talos-app` or `--flag=server:talos-app`): two commands that differ only in
  /// where it stands, or whether it is there, are the same command to the owner.
  public static func withoutTalosChannel(_ args: [String]) -> [String] {
    var out: [String] = []
    var i = 0
    while i < args.count {
      if args[i] == flag, i + 1 < args.count, args[i + 1] == AutoConfirmGuard.talosChannel {
        i += 2
      } else if args[i] == "\(flag)=\(AutoConfirmGuard.talosChannel)" {
        i += 1
      } else {
        out.append(args[i])
        i += 1
      }
    }
    return out
  }

  /// Whether the launch passes the flag (the arguments as launched, so after `ensured`).
  public static func passes(_ args: [String]) -> Bool {
    let end = args.firstIndex(of: "--") ?? args.count
    return args[..<end].contains { $0 == flag || $0.hasPrefix(flag + "=") }
  }
}
