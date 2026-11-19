import Foundation

/// Where an automatic setup puts things, and the code defaults of a fresh install. Pure; the processes are `CloneProvisioner`
/// (the Talos code) and `AgentFolderFlow.ensureCheckout` / `ensureAgentFolder` (what a new onboarding screen calls).
public enum AutoSetup {
  /// The app's own folder, named by its bundle id: the checkout record and the clone live here. Not under Documents, Desktop or
  /// Downloads (macOS asks about those after every update), not synced, and not a folder agent sessions work in.
  public static func appFolder(home: String) -> String { home + "/Library/Application Support/app.talos.desktop" }
  /// The clone of the public repository this app made.
  public static func cloneFolder(home: String) -> String { appFolder(home: home) + "/talos" }
  /// The record (`checkout`) is read from here first, then from the old folder that earlier installs wrote to.
  public static func recordFolders(home: String) -> [String] { [appFolder(home: home), home + "/Library/Application Support/Talos"] }
  /// The agent folder made with no question: outside the protected folders, as the installer's own default.
  /// What the screen says while macOS installs Apple's developer tools (a progress state, `CloneProvisioner.State.waiting`).
  public static let developerToolsPrompt = "One quick Apple install first: click Install when macOS asks (about 5 minutes)"
  public static let defaultAgentDir = "~/talos-agent"

  /// The values a fresh install starts with: the companion and the Dock icon on. Written only when the key is absent and this is a
  /// fresh install (no desktop.json yet), so an owner's choice, and an existing install that never chose, are left as they are.
  public static let freshInstallDefaults: [String: Bool] = ["companion.enabled": true, "showDockIcon": true]

  public static func seedFreshInstall(_ defaults: UserDefaults, isFresh: Bool) {
    guard isFresh else { return }
    for (k, v) in freshInstallDefaults where defaults.object(forKey: k) == nil { defaults.set(v, forKey: k) }
  }
}
