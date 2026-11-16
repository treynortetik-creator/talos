import AppKit
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

/// The Sign in to Claude step. The run itself lives in `ClaudeSignInCoordinator.shared`, so closing and reopening the setup window
/// finds the same sign-in and never starts a second one; this only shows its state. Quitting ends the login's process group.
@MainActor
final class ClaudeSignInModel: ObservableObject {
  @Published private(set) var state: ClaudeSignInCoordinator.State
  private static var quitObserver: NSObjectProtocol?

  init() {
    let c = ClaudeSignInCoordinator.shared
    state = c.state
    c.onChange = { [weak self] in Task { @MainActor in self?.state = ClaudeSignInCoordinator.shared.state } }
    if Self.quitObserver == nil {
      Self.quitObserver = NotificationCenter.default.addObserver(
        forName: NSApplication.willTerminateNotification, object: nil, queue: nil
      ) { _ in ClaudeSignInCoordinator.shared.stopNow() }
    }
  }

  func start(claude: String?, env: [String: String]) { ClaudeSignInCoordinator.shared.start(claude: claude, env: env) }
  func cancel() { ClaudeSignInCoordinator.shared.cancel() }
  @discardableResult func submit(code: String) -> Bool { ClaudeSignInCoordinator.shared.submit(code: code) }

  var running: Bool { if case .waiting = state { return true } else { return false } }
  var outcome: ClaudeSignInPlan.Outcome? { if case .finished(let o) = state { return o } else { return nil } }
}

struct SignInClaudePanel: View {
  @ObservedObject var ob: OnboardingModel
  @StateObject private var sign = ClaudeSignInModel()
  @State private var code = ""
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(OnboardingText.signInTitle).font(.headline)
      Text(OnboardingText.signInExplain).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      if case .waiting(let screen) = sign.state {
        HStack {
          ProgressView().controlSize(.small)
          Text(OnboardingText.signInWaiting)
          Button(OnboardingText.signInCancel) { sign.cancel() }
        }
        Text(OnboardingText.signInBrowser).font(.caption).foregroundStyle(.secondary)
        if let link = screen.url {
          HStack {
            Button(OnboardingText.signInOpenPage) { if let u = URL(string: link) { NSWorkspace.shared.open(u) } }
            Button(copied ? OnboardingText.signInCopied : OnboardingText.signInCopyLink) {
              SignInAction.copy(link)
              copied = true
            }
          }
        }
        if screen.wantsCode {
          Text(OnboardingText.signInCodeLabel).font(.caption)
          HStack {
            SecureField("", text: $code).frame(maxWidth: 260).onSubmit(send)
            Button(OnboardingText.signInCodeSend, action: send).disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)
          }
        }
      } else {
        if let o = sign.outcome, !o.isSuccess {
          Text(o.message).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
        }
        if ClaudeSignInPlan.showsButton(authSignedIn: ob.auth, outcome: sign.outcome, running: sign.running)
          || (sign.outcome.map { !$0.isSuccess } ?? false)
        {
          Button(sign.outcome == nil ? OnboardingText.signInButton : OnboardingText.signInRetry) { begin() }
            .disabled(ob.found?.claude == nil)
          if ob.found != nil, ob.found?.claude == nil {
            Text(OnboardingText.signInNoClaude).font(.caption).foregroundStyle(.secondary)
          }
        } else {
          Label(OnboardingText.signInAlready, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        }
      }
    }
    .onChange(of: sign.state) { if case .finished = sign.state { code = ""; copied = false; ob.recheck() } }
  }

  private func send() {
    let c = code
    code = ""
    sign.submit(code: c)
  }

  private func begin() {
    copied = false
    sign.start(claude: ob.found?.claude?.path, env: ob.loginEnv)
  }
}

/// Main's first start: the warning is answered in the Talos popup, and "done" waits for the bridge to be live.
struct FirstStartPanel: View {
  @ObservedObject var model: SupervisorController

  var body: some View {
    let state = FirstStartCheck.state(model.status)
    VStack(alignment: .leading, spacing: 6) {
      Text(OnboardingText.firstStartTitle).font(.headline)
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        switch state {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed, .stopped, .blocked, .terminalDialog: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
        case .notStarted: Image(systemName: "questionmark.circle").foregroundStyle(.secondary)
        case .warning, .waitingForBridge: ProgressView().controlSize(.small)
        }
        Text(model.configured ? state.message : OnboardingText.firstStartIdle).fixedSize(horizontal: false, vertical: true)
      }
      Text(OnboardingText.permissionNote).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// The plain-English rules screen: one box of the owner's own text, saved as the agent folder's `.claude/rules/owner-rules.md`.
struct OwnerRulesPanel: View {
  @ObservedObject var model: SupervisorController
  @State private var text = ""
  /// What the box held when it was last loaded or saved: a config change reloads only an untouched box.
  @State private var baseline = ""
  @State private var note = ""

  private var dir: String { model.supervisor.currentConfig().expandedAgentDir(home: NSHomeDirectory()) }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(OnboardingText.rulesTitle).font(.headline)
      Text(OnboardingText.rulesExplain).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      ZStack(alignment: .topLeading) {
        TextEditor(text: $text).frame(minHeight: 70).font(.body)
        if text.isEmpty {
          Text(OnboardingText.rulesPlaceholder).foregroundStyle(.tertiary).padding(.horizontal, 5).padding(.vertical, 8).allowsHitTesting(false)
        }
      }
      HStack {
        Button(OnboardingText.rulesSave) {
          let r = OwnerRules.save(text, agentDir: dir)
          switch r {
          case .saved:
            baseline = text
            note = OnboardingText.rulesSaved
          case .removed:
            baseline = text
            note = OnboardingText.rulesRemoved
          case .nothingToSave: note = OnboardingText.rulesNothing
          case .refused(let why): note = why
          }
        }
        .disabled(!model.configured)
        Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
    .onAppear { reload() }
    .onChange(of: model.configRevision) { if text == baseline { reload() } }
  }

  private func reload() {
    let t = OwnerRules.load(agentDir: dir)
    text = t
    baseline = t
  }
}
