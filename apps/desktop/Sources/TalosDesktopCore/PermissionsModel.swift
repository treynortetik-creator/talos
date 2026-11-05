import Foundation

/// The onboarding "Permissions" checklist (DESKTOP-SPEC 4.9). Under Talos.app the agent's children ask macOS for access
/// as Talos instead of Terminal, so every one-time prompt should happen before cutover, never mid-task. Nothing is
/// required: every row is a warning, never a blocker (D10). The live checks are injected, so the model is testable.
public enum PermissionsModel {
  public enum Kind: String, Equatable, Sendable, CaseIterable {
    case notifications
    case desktopFolder, documentsFolder, downloadsFolder
    case fullDiskAccess, accessibility, screenRecording, automation
    case microphone, camera, contacts, photos, mediaLibrary, networkVolumes, fileProvider, appData
  }

  public enum State: Equatable, Sendable {
    case granted
    case missing
    /// macOS has no read-only check; it asks the first time something uses it.
    case askedOnFirstUse
    /// A check exists but couldn't run.
    case unknown
  }

  /// How the owner grants it.
  public enum Action: Equatable, Sendable {
    /// Talos can trigger the one-time prompt itself (a tiny read, an `osascript` "get name").
    case triggerPrompt
    /// Only the owner can add Talos in System Settings; the URL opens the right pane.
    case openSettings(String)
    case none
  }

  public struct Row: Equatable, Sendable, Identifiable {
    public var id: Kind { kind }
    public var kind: Kind
    public var title: String
    public var why: String
    public var state: State
    public var action: Action
    /// Always true: nothing on this page blocks (D10).
    public var isWarningOnly: Bool { true }
    public var needsAttention: Bool { state != .granted }

    /// The button the row shows. A row with no way to ask still gets a way to fix a denial: macOS never asks twice, so a denied
    /// Microphone or Camera can only be turned back on in System Settings.
    public var button: Action {
      if action == .none, state == .missing, let pane = PermissionsModel.pane(for: kind) { return .openSettings(settingsBase + pane) }
      return action
    }

    /// What this state means for the owner, in words. nil when granted. A denial is never worded as a quiet success.
    public var stateNote: String? { PermissionsModel.stateNote(kind: kind, state: state, action: action) }
  }

  /// The System Settings pane for rows that have no prompt of their own.
  static func pane(for k: Kind) -> String? {
    switch k {
    case .microphone: return "Privacy_Microphone"
    case .camera: return "Privacy_Camera"
    case .contacts: return "Privacy_Contacts"
    case .photos: return "Privacy_Photos"
    case .automation: return "Privacy_Automation"
    default: return nil
    }
  }

  /// The Notifications pane (its own extension, not a Privacy pane).
  public static let notificationsURL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension"

  /// What macOS says about notifications, as a row state. nil = couldn't ask (no app bundle, or the answer hasn't come yet).
  public static func state(forNotifications p: NotifyPermission?) -> State {
    switch p {
    case .granted?: return .granted
    case .denied?: return .missing
    case .notAsked?: return .askedOnFirstUse
    case nil: return .unknown
    }
  }

  public static func stateNote(kind: Kind, state: State, action: Action) -> String? {
    switch (kind, state) {
    case (_, .granted): return nil
    case (.notifications, .missing):
      return "Denied. macOS blocks every Talos banner, including crash and health banners, and Talos can't turn that back on. Open System Settings \u{2192} Notifications \u{2192} Talos and allow them."
    case (.notifications, .askedOnFirstUse): return "Not asked yet. macOS asks the first time a banner would show."
    case (.notifications, .unknown): return "Couldn't check. Talos can only ask macOS when it runs as the Talos app."
    case (.automation, _):
      return "Can't be checked from here: macOS keeps one answer per app. Press Ask now, then review them in System Settings \u{2192} Privacy & Security \u{2192} Automation."
    case (_, .missing): return "Denied. macOS won't ask again; turn it on in System Settings."
    case (_, .unknown): return "Couldn't check."
    case (_, .askedOnFirstUse):
      return action == .none ? "Not checked here. macOS asks the first time the agent needs it." : nil
    }
  }

  public static let settingsBase = "x-apple.systempreferences:com.apple.preference.security?"

  /// Automation targets to ask for, one osascript "get name" each. Generic apps an agent commonly drives; the owner
  /// can add his own Terminal-era targets as they prompt.
  public static let automationTargets = [
    "Finder", "System Events", "Mail", "Calendar", "Messages", "Notes", "Reminders", "Terminal", "Safari",
  ]

  static let table: [(Kind, String, String, Action)] = [
    (
      .notifications, "Notifications", notificationsWhy,
      .openSettings(notificationsURL)
    ),
    (.desktopFolder, "Desktop folder", "The agent folder may live under ~/Desktop.", .triggerPrompt),
    (.documentsFolder, "Documents folder", "The agent reads and writes under ~/Documents.", .triggerPrompt),
    (.downloadsFolder, "Downloads folder", "The agent reads files you download.", .triggerPrompt),
    (
      .fullDiskAccess, "Full Disk Access", "The iMessage channel reads chat.db; anything outside the user folders.",
      .openSettings(settingsBase + "Privacy_AllFiles")
    ),
    (
      .accessibility, "Accessibility", "Computer use clicks and types.",
      .openSettings(settingsBase + "Privacy_Accessibility")
    ),
    (
      .screenRecording, "Screen & System Audio Recording", "Computer use takes screenshots.",
      .openSettings(settingsBase + "Privacy_ScreenCapture")
    ),
    (.automation, "Automation", "Scripts that drive Mail, Calendar, Finder, Terminal and other apps.", .triggerPrompt),
    (.microphone, "Microphone", "Anything the agent records.", .none),
    (.camera, "Camera", "Anything the agent captures.", .none),
    (.contacts, "Contacts", "Looking people up.", .none),
    (.photos, "Photos", "Reading your photo library.", .none),
    (.mediaLibrary, "Media Library", "Reading your music library.", .none),
    (.networkVolumes, "Network Volumes", "Files on network shares.", .none),
    (.fileProvider, "File Provider", "Cloud folders (iCloud Drive and others).", .none),
    (.appData, "App Data", "Other apps' data folders.", .none),
  ]

  /// Which banners obey which rules. The relay holds chat pushes back with the notification switch; health alarms ignore it.
  /// The Mac app's health and crash banners match that, so they pass the switch and respect only quiet hours.
  public static let notificationsWhy =
    "Banners for replies, a stuck agent, a crash loop and a dead relay. Reply banners follow the notification switch, quiet hours and each thread's setting in the Talos page (Settings \u{2192} Notifications). Health and crash banners from the Mac app pass that switch, the same as the relay's health alarms, and respect only quiet hours."

  /// Every 4.9 row, with its state from `check`.
  public static func rows(check: (Kind) -> State) -> [Row] {
    table.map { kind, title, why, action in Row(kind: kind, title: title, why: why, state: check(kind), action: action) }
  }

  /// One line for the menu or onboarding header. Never "blocked": at most a count of warnings.
  /// After some grants macOS offers "Quit & Reopen". Talos starts a helper that opens it again if macOS doesn't (first real
  /// Mac run, 2026-11-01: Talos closed and stayed closed).
  public static let reopenNote =
    "If macOS offers Quit & Reopen after a grant, say yes. Talos reopens itself a few seconds later; if it ever doesn't, open Talos from Applications."

  public static func summary(_ rows: [Row]) -> String {
    let n = rows.filter { $0.state == .missing || $0.state == .unknown }.count
    return n == 0 ? "Permissions: nothing missing that Talos can check" : "Permissions: \(n) to review (warnings only)"
  }
}
