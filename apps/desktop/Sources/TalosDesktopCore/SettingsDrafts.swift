import Foundation

/// The three text boxes in Settings (agent folder, relay address, talos-app command) hold a draft until Return or until
/// the window closes. A draft is loaded from the config when the window opens, and again whenever the config changes
/// behind the window's back: Adopt and Import both rewrite `desktop.json` while Settings is open on the Session tab, and
/// before this a box kept showing the default `~/talos-agent` while the file held the real folder (first real Mac run,
/// 2026-11-01). A box the owner is part-way through typing in is never overwritten.
public struct SettingsDrafts: Equatable, Sendable {
  public var dir = ""
  public var relay = ""
  public var cli = ""
  private var loadedDir = ""
  private var loadedRelay = ""
  private var loadedCli = ""

  public init() {}

  public init(from cfg: DesktopConfig) {
    self.init()
    load(cfg)
  }

  /// A fresh load: every box shows the config.
  public mutating func load(_ cfg: DesktopConfig) {
    loadedDir = cfg.agentDir
    loadedRelay = MacSettingsText.relayDraft(cfg.relayUrl)
    loadedCli = TalosAppLocator.formatCommandLine(cfg.talosAppCommand)
    dir = loadedDir
    relay = loadedRelay
    cli = loadedCli
  }

  // A box he had typed in when the config moved under it: the typed text stays on screen, but is not saved on close unless he
  // changes it again (otherwise an old draft undoes an Adopt or Import).
  private var overtakenDir: String?
  private var overtakenRelay: String?
  private var overtakenCli: String?

  /// The config changed: a box the owner has not edited follows it, an edited box keeps what was typed.
  public mutating func follow(_ cfg: DesktopConfig) {
    let newDir = cfg.agentDir
    let newRelay = MacSettingsText.relayDraft(cfg.relayUrl)
    let newCli = TalosAppLocator.formatCommandLine(cfg.talosAppCommand)
    if dir == loadedDir { dir = newDir; overtakenDir = nil } else if newDir != loadedDir { overtakenDir = dir }
    if relay == loadedRelay { relay = newRelay; overtakenRelay = nil } else if newRelay != loadedRelay { overtakenRelay = relay }
    if cli == loadedCli { cli = newCli; overtakenCli = nil } else if newCli != loadedCli { overtakenCli = cli }
    loadedDir = newDir
    loadedRelay = newRelay
    loadedCli = newCli
  }

  /// What a Return or a closing window should write: only boxes that differ from the config and were not overtaken by an
  /// Adopt or Import since the owner typed in them.
  public func pending(against cfg: DesktopConfig) -> (dir: String?, relay: String?, cli: [String]?) {
    let cliArgs = TalosAppLocator.parseCommandLine(cli)
    return (
      dir != cfg.agentDir && dir != overtakenDir ? dir : nil,
      relay != MacSettingsText.relayDraft(cfg.relayUrl) && relay != overtakenRelay ? relay : nil,
      cliArgs != cfg.talosAppCommand && cli != overtakenCli ? cliArgs : nil
    )
  }

  /// A commit wrote the boxes to the config: what is saved counts as loaded, so a later Adopt is followed, not fought.
  public mutating func saved(_ cfg: DesktopConfig) {
    if dir != overtakenDir { loadedDir = cfg.agentDir; overtakenDir = nil }
    if relay != overtakenRelay { loadedRelay = MacSettingsText.relayDraft(cfg.relayUrl); overtakenRelay = nil }
    if cli != overtakenCli { loadedCli = TalosAppLocator.formatCommandLine(cfg.talosAppCommand); overtakenCli = nil }
  }
}
