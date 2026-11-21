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
    /// Screen control (screen helper lane 4): a Grant button that asks macOS itself, beside the pane's URL. The row's tick
    /// comes from the live test of the screen helper (`ScreenSetupModel`), not from the grant alone.
    case grant(String)
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
    case (.accessibility, _): return ScreenSetupText.missing(.accessibility)
    case (.screenRecording, _): return ScreenSetupText.missing(.screenRecording)
    case (.notifications, .missing):
      return "You said no, so macOS blocks every Talos banner, including warnings. Turn them back on in System Settings \u{2192} Notifications \u{2192} Talos."
    case (.notifications, .askedOnFirstUse): return "Not asked yet. macOS asks the first time a banner would show."
    case (.notifications, .unknown): return "Couldn't check. Talos can only ask macOS when it runs as the Talos app."
    case (.automation, _):
      return "Talos can't check this one. Press Ask now, then review it in System Settings \u{2192} Privacy & Security \u{2192} Automation."
    case (_, .missing): return "You said no. macOS won't ask again; allow it in System Settings."
    case (_, .unknown): return "Couldn't check."
    case (_, .askedOnFirstUse):
      return action == .none ? "Not checked here. macOS asks the first time your agent needs it." : nil
    }
  }

  /// Every note a row can show, for the words guard.
  public static var allStateNotes: [String] {
    var out: [String] = []
    for k in Kind.allCases {
      for s in [State.granted, .missing, .askedOnFirstUse, .unknown] {
        for a in [Action.none, .triggerPrompt] { if let n = stateNote(kind: k, state: s, action: a) { out.append(n) } }
      }
    }
    return out
  }

  /// Where a row sits on the Privacy & access tab: what is allowed, what the owner said no to, and what has not come up yet.
  public enum Group: Equatable, Sendable { case allowed, saidNo, notAskedYet }

  /// "See and use the screen" is one row for two macOS permissions (the mouse and keyboard, and the screen itself): allowed only when
  /// both are, "you said no" when either was refused, otherwise not asked yet.
  public static func screenState(accessibility: State, screenRecording: State) -> State {
    let both = [accessibility, screenRecording]
    if both.allSatisfy({ $0 == .granted }) { return .granted }
    if both.contains(.missing) { return .missing }
    return both.contains(.unknown) ? .unknown : .askedOnFirstUse
  }

  public static func group(_ s: State) -> Group {
    switch s {
    case .granted: return .allowed
    case .missing: return .saidNo
    case .askedOnFirstUse, .unknown: return .notAskedYet
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
    (.desktopFolder, "Desktop folder", "Open and save files on your Desktop", .triggerPrompt),
    (.documentsFolder, "Documents folder", "Open and save your files", .triggerPrompt),
    (.downloadsFolder, "Downloads folder", "Read files you download", .triggerPrompt),
    (
      .fullDiskAccess, "Messages and protected files", "Lets your agent read your Messages and other protected files",
      .openSettings(settingsBase + "Privacy_AllFiles")
    ),
    (
      .accessibility, "Use the mouse and keyboard", "Your agent clicks and types for you, only in apps you allow",
      .grant(settingsBase + "Privacy_Accessibility")
    ),
    (
      .screenRecording, "See the screen", "Your agent sees the screen, only in apps you allow",
      .grant(settingsBase + "Privacy_ScreenCapture")
    ),
    (.automation, "Work in other apps", "Lets your agent work in Mail, Calendar, Finder and other apps", .triggerPrompt),
    (.microphone, "Microphone", "Anything your agent records", .none),
    (.camera, "Camera", "Anything your agent captures", .none),
    (.contacts, "Contacts", "Looking people up", .none),
    (.photos, "Photos", "Reading your photo library", .none),
    (.mediaLibrary, "Music library", "Reading your music library", .none),
    (.networkVolumes, "Network folders", "Files on network shares", .none),
    (.fileProvider, "Cloud folders", "iCloud Drive and other cloud folders", .none),
    (.appData, "Other apps' data", "Other apps' data folders", .none),
  ]

  /// Which banners obey which rules. The relay holds chat pushes back with the notification switch; health alarms ignore it.
  /// The Mac app's health and crash banners match that, so they pass the switch and respect only quiet hours.
  public static let notificationsWhy = "Replies and when your agent needs you"

  /// Every 4.9 row, with its state from `check`.
  public static func rows(check: (Kind) -> State) -> [Row] {
    table.map { kind, title, why, action in Row(kind: kind, title: title, why: why, state: check(kind), action: action) }
  }

  /// One line for the menu or onboarding header. Never "blocked": at most a count of warnings.
  /// After some grants macOS offers "Quit & Reopen". Talos starts a helper that opens it again if macOS doesn't (first real
  /// Mac run, 2026-11-01: Talos closed and stayed closed).
  public static let reopenNote =
    "If macOS offers Quit & Reopen after you allow something, say yes. Talos reopens itself a few seconds later; if it ever doesn't, open Talos from Applications."

  public static func summary(_ rows: [Row]) -> String {
    let n = rows.filter { $0.state == .missing || $0.state == .unknown }.count
    switch n {
    case 0: return "Nothing is missing that Talos can check"
    case 1: return "1 thing you can still allow"
    default: return "\(n) things you can still allow"
    }
  }
}
