import Foundation

/// Main's launch always carries `--dangerously-load-development-channels server:talos-app`. Without it Claude Code loads the bridge as
/// a plain tool and Main gets no pushed messages (a launch command imported without the flag did exactly that after an update on
/// 2026-11-19). It is added to the arguments of each launch, never to the owner's saved command, so a restart, an update restart and a
/// start from the menu all carry it. A command that already names the flag, with any channel, is left as it is: the owner's choice, and
/// `AutoConfirmGuard` still answers the warning only for the Talos channel.
public enum MainChannelFlag {
  public static let flag = "--dangerously-load-development-channels"

  public static func ensured(_ args: [String]) -> [String] {
    let end = args.firstIndex(of: "--") ?? args.count
    let flags = Array(args[..<end])
    if flags.contains(where: { $0 == flag || $0.hasPrefix(flag + "=") }) { return args }
    let add = [flag, AutoConfirmGuard.talosChannel]
    // after the owner's flags; but when the last one still waits for its value, the pair would become that value: then first
    if MainArgs.swallowsAppended(flags) { return add + args }
    var out = args
    out.insert(contentsOf: add, at: end)
    return out
  }

  /// Whether the launch passes the flag (the arguments as launched, so after `ensured`).
  public static func passes(_ args: [String]) -> Bool {
    let end = args.firstIndex(of: "--") ?? args.count
    return args[..<end].contains { $0 == flag || $0.hasPrefix(flag + "=") }
  }
}
