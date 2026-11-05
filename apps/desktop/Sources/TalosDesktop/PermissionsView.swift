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
    case .accessibility: return AXIsProcessTrusted() ? .granted : .missing
    case .screenRecording: return CGPreflightScreenCaptureAccess() ? .granted : .missing
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

  var rows: [PermissionsModel.Row] {
    _ = tick
    return PermissionsModel.rows { k in
      k == .notifications ? PermissionsModel.state(forNotifications: notify) : PermissionChecks.check(k, asked: asked)
    }
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
      List(rows) { row in
        HStack(alignment: .top) {
          Image(systemName: icon(row.state)).foregroundStyle(color(row.state))
          VStack(alignment: .leading, spacing: 2) {
            Text(row.title)
            Text(row.why).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let n = row.stateNote {
              Text(n).font(.caption).foregroundStyle(row.state == .missing ? Color.orange : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          Spacer()
          switch row.button {
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
      HStack {
        Spacer()
        Button("Check again") {
          tick += 1
          reloadNotify()
        }
      }
    }
    .padding()
    .onAppear { reloadNotify() }
    // He may have changed Talos in System Settings and come back: look again.
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      tick += 1
      reloadNotify()
    }
    .onDisappear { RelaunchGuard.shared.disarm() }  // the grant is over: a later Force Quit must not bring Talos back
    .frame(minWidth: 560, minHeight: 520)
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
