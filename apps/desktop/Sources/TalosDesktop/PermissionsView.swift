import AVFoundation
import AppKit
import ApplicationServices
import Contacts
import CoreGraphics
import Photos
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

/// The onboarding "Permissions" page (DESKTOP-SPEC 4.9). Live checks where macOS has a read-only one; folder and
/// Automation prompts only when the owner presses [Ask now], so they all happen before cutover and never mid-task.
/// Every row is a warning; nothing blocks (D10).
enum PermissionChecks {
  static func check(_ k: PermissionsModel.Kind, asked: Set<PermissionsModel.Kind>) -> PermissionsModel.State {
    switch k {
    case .fullDiskAccess:
      let p = NSHomeDirectory() + "/Library/Messages/chat.db"
      guard FileManager.default.fileExists(atPath: p) else { return .unknown }
      let fd = open(p, O_RDONLY)
      if fd >= 0 { close(fd); return .granted }
      return .missing
    case .accessibility, .screenRecording:
      return .unknown  // the live test of the screen helper decides (ScreenSetupModel), never a tick for a grant alone
    case .microphone: return av(.audio)
    case .camera: return av(.video)
    case .contacts:
      switch CNContactStore.authorizationStatus(for: .contacts) {
      case .authorized: return .granted
      case .denied, .restricted: return .missing
      default: return .askedOnFirstUse
      }
    case .photos:
      switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
      case .authorized, .limited: return .granted
      case .denied, .restricted: return .missing
      default: return .askedOnFirstUse
      }
    case .desktopFolder, .documentsFolder, .downloadsFolder:
      guard asked.contains(k) else { return .askedOnFirstUse }
      return (try? FileManager.default.contentsOfDirectory(atPath: folder(k))) != nil ? .granted : .missing
    case .automation, .mediaLibrary, .networkVolumes, .fileProvider, .appData:
      return .askedOnFirstUse
    case .notifications:
      return .unknown  // asked of macOS asynchronously by the view (`Notifier.currentPermission`), never here
    }
  }

  static func av(_ m: AVMediaType) -> PermissionsModel.State {
    switch AVCaptureDevice.authorizationStatus(for: m) {
    case .authorized: return .granted
    case .denied, .restricted: return .missing
    default: return .askedOnFirstUse
    }
  }

  static func folder(_ k: PermissionsModel.Kind) -> String {
    switch k {
    case .desktopFolder: return NSHomeDirectory() + "/Desktop"
    case .documentsFolder: return NSHomeDirectory() + "/Documents"
    default: return NSHomeDirectory() + "/Downloads"
    }
  }

  static let automationBundleIds: [String: String] = [
    "Finder": "com.apple.finder", "System Events": "com.apple.systemevents", "Mail": "com.apple.mail",
    "Calendar": "com.apple.iCal", "Messages": "com.apple.MobileSMS", "Notes": "com.apple.Notes",
    "Reminders": "com.apple.reminders", "Terminal": "com.apple.Terminal", "Safari": "com.apple.Safari",
  ]

  /// One harmless "get name" per installed target, so each Automation prompt appears now. May open each app once.
  static func askAutomation() {
    DispatchQueue.global(qos: .userInitiated).async {
      for name in PermissionsModel.automationTargets {
        guard let bid = automationBundleIds[name],
          NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) != nil
        else { continue }
        _ = ProcessRunner.run(["/usr/bin/osascript", "-e", "tell application id \"\(bid)\" to get name"], timeout: 60)
      }
    }
  }
}

/// Mac settings, Privacy & access (mock "Settings: Privacy and access"): what your agent may use, in three groups: Allowed, You said
/// no (with a button to allow it) and Not asked yet (folded away; macOS asks the first time a task needs it). Live checks where macOS
/// has a read-only one; folder and Automation prompts only when the owner presses Ask now. Every row is a warning; nothing blocks (D10).
struct PermissionsView: View {
  @State private var asked: Set<PermissionsModel.Kind> = []
  @State private var tick = 0
  /// What macOS says about notifications; nil until it has answered (or when there is no app bundle to ask for).
  @State private var notify: NotifyPermission?
  @State private var showNotAsked = false
  /// The apps list and the screen test, folded under the one "See and use the screen" row until asked for.
  @State private var showApps = false
  /// Screen control (screen helper lane 4): the Allow buttons and the live test of the screen helper itself.
  @State private var screen = ScreenSetupModel(
    permissions: LiveScreenPermissions(), grants: LiveScreenGrants(), test: { await ScreenCore.live().liveTest() },
    serving: { ScreenHelperHost.notServingReason },
    memory: FileScreenGrantMemory(path: SupervisorController.supportDir + "/screen-grant-pressed"))

  /// Every permission, with the two screen ones folded into one "See and use the screen" row (`PermissionsModel.screenState`).
  var rows: [PermissionsModel.Row] {
    _ = tick
    let all = PermissionsModel.rows { k in
      switch k {
      case .notifications: return PermissionsModel.state(forNotifications: notify)
      case .accessibility, .screenRecording: return screen.state(k)
      default: return PermissionChecks.check(k, asked: asked)
      }
    }
    let combined = PermissionsModel.screenState(accessibility: screen.state(.accessibility), screenRecording: screen.state(.screenRecording))
    return all.compactMap { r in
      if r.kind == .accessibility { return nil }
      guard r.kind == .screenRecording else { return r }
      var s = r
      s.title = MacWords.screenRowTitle
      s.why = "Your agent sees the screen and clicks and types for you, only in apps you allow"
      s.state = combined
      return s
    }
  }

  private var appsCount: Int {
    _ = tick
    return ScreenHelperHost.shared.store.map { ScreenAllowedAppsModel(store: $0).rows.count } ?? 0
  }

  private func retest() {
    Task { @MainActor in
      tick += 1
      await screen.runTest()
      tick += 1
    }
  }

  private func screenStatus(_ k: PermissionsModel.Kind) -> String? {
    _ = tick
    return screen.rows.first { $0.kind == k }?.status
  }

  private func reloadNotify() { Notifier.shared.currentPermission { notify = $0 } }

  private func rows(in g: PermissionsModel.Group) -> [PermissionsModel.Row] { rows.filter { PermissionsModel.group($0.state) == g } }

  var body: some View {
    SettingsPage(title: MacWords.tabAccess, subtitle: "Your agent asks for each of these the first time a task needs it, never all at once.") {
      let allowed = rows(in: .allowed)
      let no = rows(in: .saidNo)
      let notYet = rows(in: .notAskedYet)
      if !allowed.isEmpty {
        SettingsSection(title: "Allowed") {
          SettingsCard {
            ForEach(Array(allowed.enumerated()), id: \.element.id) { i, r in
              if i > 0 { SettingsDivider() }
              row(r)
            }
          }
        }
      }
      if !no.isEmpty {
        SettingsSection(title: "You said no") {
          SettingsCard {
            ForEach(Array(no.enumerated()), id: \.element.id) { i, r in
              if i > 0 { SettingsDivider() }
              row(r)
            }
          }
        }
      }
      if !notYet.isEmpty { notAskedYet(notYet) }
      if allowed.isEmpty && no.isEmpty && notYet.isEmpty {
        SettingsCaption(PermissionsModel.summary(rows))
      }
      if showApps { screenSection }
      HStack(spacing: 12) {
        SettingsCaption(PermissionsModel.reopenNote, size: 12)
        Spacer(minLength: 0)
        Button("Check again") {
          tick += 1
          reloadNotify()
          retest()
        }
        .buttonStyle(SettingsPillStyle())
      }
    }
    .onAppear {
      reloadNotify()
      retest()
    }
    // He may have changed Talos in System Settings and come back: look again.
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      tick += 1
      reloadNotify()
      retest()
    }
    .onDisappear { RelaunchGuard.shared.disarm() }  // the grant is over: a later Force Quit must not bring Talos back
  }

  private func notAskedYet(_ list: [PermissionsModel.Row]) -> some View {
    VStack(spacing: 0) {
      Button {
        showNotAsked.toggle()
      } label: {
        HStack(spacing: 14) {
          Text("Not asked yet").font(OB.body(15)).foregroundStyle(SP.ink).frame(maxWidth: .infinity, alignment: .leading)
          Text("\(list.count) \u{00B7} asked only when needed").font(OB.body(13)).foregroundStyle(SP.muted)
          Image(systemName: showNotAsked ? "chevron.up" : "chevron.down").foregroundStyle(SP.muted)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Not asked yet, \(list.count)")
      .accessibilityValue(Text(showNotAsked ? "Expanded" : "Collapsed"))
      .accessibilityIdentifier("not-asked-yet")
      if showNotAsked {
        ForEach(list) { r in
          SettingsDivider()
          row(r)
        }
      }
    }
    .background(RoundedRectangle(cornerRadius: 14).fill(SP.card))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(SP.line, lineWidth: 1))
  }

  /// One permission: its state mark, its name and what it is for, a note when it needs one, and the button that fixes it.
  private func row(_ r: PermissionsModel.Row) -> some View {
    HStack(alignment: .center, spacing: 14) {
      Image(systemName: icon(r.state)).foregroundStyle(color(r.state)).frame(width: 20)
      VStack(alignment: .leading, spacing: 2) {
        Text(r.title).font(OB.body(15)).foregroundStyle(SP.ink)
        Text(r.why).font(OB.body(13)).foregroundStyle(SP.muted).fixedSize(horizontal: false, vertical: true)
        if r.kind == .screenRecording {
          ForEach([PermissionsModel.Kind.accessibility, .screenRecording], id: \.self) { k in
            if let s = screenStatus(k), r.state != .granted {
              Text(s).font(OB.body(12)).foregroundStyle(SP.orange).fixedSize(horizontal: false, vertical: true)
            }
          }
        } else if let n = r.stateNote {
          Text(n).font(OB.body(12)).foregroundStyle(r.state == .missing ? SP.orange : SP.muted).fixedSize(horizontal: false, vertical: true)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)  // the words read as one; the buttons beside them stay their own controls
      buttons(r)
    }
    .padding(.horizontal, 18).padding(.vertical, 12)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private func buttons(_ r: PermissionsModel.Row) -> some View {
    let wanted = r.state == .missing
    if r.kind == .screenRecording {
      VStack(alignment: .trailing, spacing: 4) {
        if r.state != .granted {
          Button("Allow\u{2026}") {
            RelaunchGuard.shared.arm()  // macOS offers Quit & Reopen after a Screen Recording allow
            if screen.state(.accessibility) != .granted { screen.grant(.accessibility) }
            if screen.state(.screenRecording) != .granted { screen.grant(.screenRecording) }
            retest()
          }
          .buttonStyle(SettingsPillStyle(kind: wanted ? .primary : .outline))
          .accessibilityIdentifier("allow-screen")
        }
        Button(MacWords.appsItMayUse(appsCount)) { showApps.toggle() }
          .buttonStyle(SettingsLinkStyle())
          .accessibilityIdentifier("apps-it-may-use")
      }
    } else {
      switch r.button {
    case .grant(let url):
      VStack(alignment: .trailing, spacing: 4) {
        Button("Allow\u{2026}") {
          RelaunchGuard.shared.arm()  // macOS offers Quit & Reopen after a Screen Recording allow
          screen.grant(r.kind == .screenRecording ? .screenRecording : .accessibility)
          retest()
        }
        .buttonStyle(SettingsPillStyle(kind: wanted ? .primary : .outline))
        Button("Open System Settings") {
          RelaunchGuard.shared.arm()
          if let u = URL(string: url) { NSWorkspace.shared.open(u) }
        }
        .buttonStyle(SettingsLinkStyle(size: 12))
      }
    case .openSettings(let url):
      Button(wanted ? "Allow\u{2026}" : "Open System Settings") {
        RelaunchGuard.shared.arm()  // macOS may offer Quit & Reopen after an allow
        if let u = URL(string: url) { NSWorkspace.shared.open(u) }
      }
      .buttonStyle(SettingsPillStyle(kind: wanted ? .primary : .outline))
    case .triggerPrompt:
      Button("Ask now") {
        RelaunchGuard.shared.arm()
        if r.kind == .automation { PermissionChecks.askAutomation() } else { asked.insert(r.kind) }
        tick += 1
      }
      .buttonStyle(SettingsPillStyle())
    case .none:
      EmptyView()
    }
    }
  }

  /// "See and use the screen": the apps it may use, the test of the screen helper, and the way to take an app away.
  private var screenSection: some View {
    SettingsSection(title: "Apps and the screen test") {
      SettingsCard {
        VStack(alignment: .leading, spacing: 8) {
          SettingsCaption(ScreenSetupText.header)
          if screen.showStaleEntry {
            SettingsCaption(ScreenSetupText.staleEntry, color: SP.orange, size: 12).accessibilityIdentifier("screen-stale-entry")
          } else if screen.showReopen {
            SettingsCaption(ScreenSetupText.reopen, color: SP.orange, size: 12).accessibilityIdentifier("screen-reopen")
          }
          HStack {
            Button("Test screen control") { retest() }.buttonStyle(SettingsPillStyle()).disabled(screen.testing)
            Spacer()
          }
          SettingsDivider()
          ScreenAllowedAppsSection()
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
      }
    }
  }

  func icon(_ s: PermissionsModel.State) -> String {
    switch s {
    case .granted: return "checkmark.circle.fill"
    case .missing: return "xmark.circle.fill"
    case .askedOnFirstUse: return "questionmark.circle"
    case .unknown: return "circle.dashed"
    }
  }

  func color(_ s: PermissionsModel.State) -> Color {
    switch s {
    case .granted: return SP.done
    case .missing: return SP.danger
    default: return SP.muted
    }
  }
}
