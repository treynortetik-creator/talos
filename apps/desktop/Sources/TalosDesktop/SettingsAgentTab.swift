import AppKit
import SwiftUI
import TalosDesktopCore

/// Mac settings, Your agent (mock "Settings: Your agent"): how it is doing, how much it asks before it acts, and the four things
/// most people want to set. Everything about how it is launched, where it lives and how Talos looks after it is in Advanced.
extension SettingsView {
  var agentTab: some View {
    SettingsPage(
      title: MacWords.tabAgent, icon: OnboardingFonts.robot(),
      status: model.configured ? ((headlineForTest ?? status.summary.headline).text, (headlineForTest ?? status.summary.headline).ok) : nil,
      trailing: AnyView(
        Button("Restart") { model.restart() }
          .buttonStyle(SettingsPillStyle(height: 40))
          .disabled(!model.configured || (model.sessionIsUp && !model.supervisor.holdsSessionLock))
          .accessibilityLabel(MacWords.restartAgent)
          .accessibilityIdentifier("agent-restart"))
    ) {
      modeSection
      SettingsCard {
        SettingsSwitchRow(title: MacSettingsText.startOnOpenTitle, isOn: bind(\.startSessionOnLaunch))
        SettingsDivider()
        SettingsSwitchRow(title: MacSettingsText.keepWorkingTitle, isOn: keepWorkingBinding)
          .disabled(keepWorkingLock != nil)
        SettingsDivider()
        SettingsSwitchRow(title: MacSettingsText.restartIfStopsTitle, isOn: bind(\.autoRestart))
        SettingsDivider()
        problemsRow
      }
      if let why = keepWorkingLock {
        SettingsCaption(why, color: SP.orange, size: 12).accessibilityIdentifier("keep-working-locked")
      }
      if let pending = HostChoice.startBlock(saved: cfg.host, runningTmux: model.hostKind == .tmux, tmuxUsable: model.tmuxUsable) {
        SettingsCaption(pending, color: SP.orange, size: 12).accessibilityIdentifier("host-change-pending")
      }
      applyCaption
    }
  }

  // MARK: how much it asks

  private var modeSection: some View {
    let reading = PermissionModeSetting.read(cfg.args)
    return SettingsSection(title: PermissionModeSetting.title) {
      if model.configured {
        HStack(alignment: .top, spacing: 10) {
          ForEach(PermissionMode.allCases, id: \.self) { m in modeCard(m, picked: reading == .mode(m)) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(PermissionModeSetting.title)
        if reading == .mode(.bypass) {
          SettingsCaption(PermissionModeSetting.bypassLine, color: SP.orange, size: 12)
            .accessibilityIdentifier("permission-bypass-line")
        }
        if reading == .custom {
          SettingsCaption(PermissionModeSetting.customLine, size: 12)
        }
        if let line = unappliedLine {
          SettingsCaption(line, size: 12).accessibilityIdentifier("permission-unapplied-line")
        }
        if !modeNote.isEmpty {
          SettingsCaption(modeNote, size: 12).accessibilityIdentifier("permission-mode-note")
        }
      } else {
        SettingsCaption(SetupText.launchNeedsSetup, size: 12)
      }
    }
    .alert(
      PermissionModeSetting.askFirstTitle, isPresented: Binding(get: { pendingMode != nil }, set: { if !$0 { pendingMode = nil } }),
      presenting: pendingMode
    ) { m in
      Button(MacSettingsText.restartNow) { applyMode(m, restart: true) }
      Button("Save, restart later") { applyMode(m, restart: false) }
      Button("Cancel", role: .cancel) {}
    } message: { _ in
      Text(PermissionModeSetting.askFirstBody)
    }
  }

  /// The saved mode the running agent does not have yet: named with the running mode when it is known, else without it (a launch the
  /// app attached to after a relaunch). Nil when the agent is not up or has what is saved.
  private var unappliedLine: String? {
    guard model.sessionIsUp, case .mode(let saved) = PermissionModeSetting.read(cfg.args) else { return nil }
    if let n = PermissionModeSetting.notYetActive(saved: cfg.args, running: model.status.runningArgs) {
      return PermissionModeSetting.unappliedLine(saved: n.saved, running: n.running)
    }
    return model.status.runningArgs == nil && model.status.launchPending ? PermissionModeSetting.unappliedUnknownLine(saved: saved) : nil
  }

  private func modeCard(_ m: PermissionMode, picked: Bool) -> some View {
    Button {
      chooseMode(m)
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          Image(systemName: picked ? "largecircle.fill.circle" : "circle").foregroundStyle(SP.accent)
          Text(m.settingsName).font(OB.body(15, .semibold)).foregroundStyle(SP.ink)
        }
        Text(m.settingsBlurb).font(OB.body(13)).foregroundStyle(SP.muted)
          .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(14)
      .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: 14).fill(SP.card))
      .overlay(RoundedRectangle(cornerRadius: 14).stroke(picked ? SP.accent : SP.line, lineWidth: 2))
      .contentShape(RoundedRectangle(cornerRadius: 14))
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(m.settingsName). \(m.settingsBlurb)")
    .accessibilityValue(Text(picked ? "Selected" : ""))
    .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier("mode-\(m.rawValue)")
  }

  /// A choice among the cards: the mode already in force does nothing; a running agent is restarted for you, and asked about first
  /// only while it is on a turn. The saved mode the running agent does not have yet is not "in force": choosing it again restarts the
  /// agent the same way ("Restart to apply").
  func chooseMode(_ mode: PermissionMode) {
    guard loaded else { return }
    if PermissionModeSetting.evaluate(mode, against: model.configNow) == .unchanged {
      // the saved mode the running agent does not have (known to differ, or not known to match after a relaunch): restart to apply
      let differs =
        PermissionModeSetting.notYetActive(saved: model.configNow.args, running: model.status.runningArgs)?.saved == mode
        || (model.status.runningArgs == nil && model.status.launchPending)
      guard model.sessionIsUp, differs else { return }
      switch model.permissionModeFollowUp {
      case .askFirst: confirmRestart = true
      case .restartNow:
        model.restartToApply()
        modeNote = PermissionModeSetting.restartingNote
      case .saveOnly: break
      }
      return
    }
    // a half-typed start-up command would save over the new flag: it is saved or reverted first
    guard launchDraft == launchLoaded else {
      modeNote = PermissionModeSetting.unsavedNote
      return
    }
    switch model.permissionModeFollowUp {
    case .askFirst: pendingMode = mode
    case .restartNow: applyMode(mode, restart: true)
    case .saveOnly: applyMode(mode, restart: false)
    }
  }

  func applyMode(_ mode: PermissionMode, restart: Bool) {
    pendingMode = nil
    model.setPermissionMode(mode, restart: restart)
    cfg = model.configNow
    modeNote =
      restart
      ? PermissionModeSetting.restartingNote
      : (model.sessionIsUp ? MacSettingsText.changesApply : PermissionModeSetting.savedNotRunning)
  }

  // MARK: the four rows

  private var keepWorkingLock: String? {
    KeepWorking.lockNote(sessionUp: model.sessionIsUp, workersRunning: model.workersRunning, helperAvailable: model.tmuxUsable)
  }

  private var keepWorkingBinding: Binding<Bool> {
    Binding(
      get: { KeepWorking.isOn(choice: cfg.host, tmuxUsable: model.tmuxUsable) },
      set: { on in save { $0.host = KeepWorking.choice(turningOn: on) } })
  }

  private var problemsRow: some View {
    VStack(alignment: .leading, spacing: 6) {
      SettingsRow(title: MacSettingsText.problemsInTitle) {
        Picker(
          MacSettingsText.problemsInTitle,
          selection: Binding<String>(
            get: { cfg.notifyThread ?? "" },
            set: { v in
              let pick = ThreadChoices.stored(v)
              save { $0.notifyThread = pick }
            })
        ) {
          ForEach(ThreadChoices.options(threads, current: cfg.notifyThread)) { o in Text(o.label).tag(o.value ?? "") }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .frame(width: 170)
        .accessibilityLabel(MacSettingsText.problemsInTitle)
      }
      if !threads.readable {
        SettingsCaption(ThreadChoices.note(threads), color: SP.orange, size: 12).padding(.horizontal, 18).padding(.bottom, 10)
      }
    }
  }

  // MARK: the one caption

  /// Changes apply the next time your agent starts. A saved change the running agent does not have yet says so with one button
  /// that restarts it (asked first while it is on a turn); never left unapplied without a word.
  private var applyCaption: some View {
    HStack(spacing: 6) {
      SettingsCaption(MacSettingsText.changesApply)
      if model.configured {
        Button(MacSettingsText.restartNow) {
          if model.sessionIsUp, model.status.launchPending {
            switch model.permissionModeFollowUp {
            case .askFirst: confirmRestart = true
            default: model.restartToApply()
            }
          } else {
            model.restart()
          }
        }
        .disabled(model.sessionIsUp && !model.supervisor.holdsSessionLock)
        .buttonStyle(SettingsLinkStyle())
        .accessibilityIdentifier("restart-to-apply")
      }
    }
    .alert(PermissionModeSetting.askFirstTitle, isPresented: $confirmRestart) {
      Button(MacSettingsText.restartNow) { model.restartToApply() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(PermissionModeSetting.askFirstBody)
    }
  }
}
