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

struct PermissionsView: View {
  @State private var asked: Set<PermissionsModel.Kind> = []
  @State private var tick = 0
  /// What macOS says about notifications; nil until it has answered (or when there is no app bundle to ask for).
  @State private var notify: NotifyPermission?
  /// Screen control (screen helper lane 4): the Grant buttons and the live test of the screen helper itself.
  @State private var screen = ScreenSetupModel(
    permissions: LiveScreenPermissions(), grants: LiveScreenGrants(), test: { await ScreenCore.live().liveTest() },
    serving: { ScreenHelperHost.notServingReason },
    memory: FileScreenGrantMemory(path: SupervisorController.supportDir + "/screen-grant-pressed"))

  var rows: [PermissionsModel.Row] {
    _ = tick
    return PermissionsModel.rows { k in
      switch k {
      case .notifications: return PermissionsModel.state(forNotifications: notify)
      case .accessibility, .screenRecording: return screen.state(k)
      default: return PermissionChecks.check(k, asked: asked)
      }
    }
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

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Permissions").font(.title2)
      Text(
        "Your agent runs inside Talos, so macOS asks Talos (not Terminal) for these. Grant them once now, before moving the session over. Nothing here is required."
      )
      .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Text(PermissionsModel.summary(rows)).font(.callout)
      Text(PermissionsModel.reopenNote).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: 4) {
        Text(ScreenSetupText.header).font(.callout).fixedSize(horizontal: false, vertical: true)
        if screen.showStaleEntry {
          Text(ScreenSetupText.staleEntry).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("screen-stale-entry")
        } else if screen.showReopen {
          Text(ScreenSetupText.reopen).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("screen-reopen")
        }
        HStack {
          Button("Test screen control") { retest() }.disabled(screen.testing)
          Spacer()
        }
      }
      List(rows) { row in
        HStack(alignment: .top) {
          Image(systemName: icon(row.state)).foregroundStyle(color(row.state))
          VStack(alignment: .leading, spacing: 2) {
            Text(row.title)
            Text(row.why).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if row.kind == .accessibility || row.kind == .screenRecording, let s = screenStatus(row.kind) {
              Text(s).font(.caption).foregroundStyle(row.state == .granted ? Color.green : Color.orange)
                .fixedSize(horizontal: false, vertical: true)
            } else if let n = row.stateNote {
              Text(n).font(.caption).foregroundStyle(row.state == .missing ? Color.orange : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          Spacer()
          switch row.button {
          case .grant(let url):
            VStack(alignment: .trailing, spacing: 4) {
              Button("Grant") {
                RelaunchGuard.shared.arm()  // macOS offers Quit & Reopen after a Screen Recording grant
                screen.grant(row.kind == .screenRecording ? .screenRecording : .accessibility)
                retest()
              }
              Button("Open System Settings") {
                RelaunchGuard.shared.arm()
                if let u = URL(string: url) { NSWorkspace.shared.open(u) }
              }
            }
          case .openSettings(let url):
            Button("Open System Settings") {
              RelaunchGuard.shared.arm()  // macOS may offer Quit & Reopen after a grant
              if let u = URL(string: url) { NSWorkspace.shared.open(u) }
            }
          case .triggerPrompt:
            Button("Ask now") {
              RelaunchGuard.shared.arm()
              if row.kind == .automation { PermissionChecks.askAutomation() } else { asked.insert(row.kind) }
              tick += 1
            }
          case .none:
            EmptyView()
          }
        }
        .accessibilityElement(children: .combine)
      }
      ScreenAllowedAppsSection()
      HStack {
        Spacer()
        Button("Check again") {
          tick += 1
          reloadNotify()
          retest()
        }
      }
    }
    .padding()
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
    .frame(minWidth: 560, minHeight: 640)
  }

  func icon(_ s: PermissionsModel.State) -> String {
    switch s {
    case .granted: return "checkmark.circle.fill"
    case .missing: return "exclamationmark.triangle.fill"
    case .askedOnFirstUse: return "questionmark.circle"
    case .unknown: return "circle.dashed"
    }
  }

  func color(_ s: PermissionsModel.State) -> Color {
    switch s {
    case .granted: return .green
    case .missing: return .orange
    default: return .secondary
    }
  }
}
