import AppKit
import SwiftUI
import TalosDesktopCore

// Mac settings, Advanced (mock "Settings: Advanced"). This file and `AdvancedMenu.swift` are the only Mac screens where an engineer's
// words (relay, bridge, tmux, session, Terminal, launch command) may appear: `MacWordsGuardTests` reads every other screen's source
// and fails on one. Nothing here is needed to use Talos.

extension SettingsView {
  var advancedTab: some View {
    SettingsPage(title: MacWords.tabAdvanced, subtitle: "For tinkering. Nothing here is needed to use Talos.") {
      startSection
      toolsCard
      serverSection
      SettingsSection(title: "Connect by command") { SignInPanel(model: model, beforeSignIn: { commitDrafts() }, showButton: false) }
      SettingsSection(title: "Take over or import") { SessionView(model: model) }
      chips
      if !generalNote.isEmpty {
        SettingsCaption(generalNote, color: SP.orange, size: 12).accessibilityIdentifier("general-note")
      }
      SettingsCaption(MacAbout.versionLine(version: WebController.version, build: WebController.build), size: 12)
    }
  }

  // MARK: how your agent starts

  private var startSection: some View {
    SettingsSection(title: "How your agent starts") {
      if model.configured {
        HStack(spacing: 8) {
          TextField("claude --permission-mode auto \u{2026}", text: $launchDraft)
            .settingsField()
            .font(.system(.body, design: .monospaced))
            .onSubmit { commitLaunch() }
            .accessibilityLabel("Command that starts your agent")
          Button("Save") { commitLaunch() }.buttonStyle(SettingsPillStyle(height: 40)).disabled(launchDraft == launchLoaded)
          Button("Revert") { loadLaunch() }.buttonStyle(SettingsPillStyle(height: 40))
            .disabled(launchDraft == launchLoaded && launchError == nil)
        }
        SettingsCaption("The \u{201C}\(PermissionModeSetting.title)\u{201D} choice fills this in; edit it only if you know you need to.", size: 12)
        SettingsCaption(LaunchEdit.envLine(cfg), size: 12)
        if let e = launchError {
          SettingsCaption(e, color: SP.danger, size: 12).accessibilityIdentifier("launch-error")
        }
        if launchSaved {
          SettingsCaption(LaunchEdit.coldNote, size: 12).accessibilityIdentifier("launch-saved")
        }
      } else {
        SettingsCaption(SetupText.launchNeedsSetup, size: 12)
      }
    }
  }

  // MARK: the folder, the host and the switches

  private var folderCheck: AgentFolderCheck.Result { AgentFolderCheck.check(drafts.dir, home: NSHomeDirectory()) }

  private var toolsCard: some View {
    SettingsCard {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 12) {
          Text("Agent's folder").font(OB.body(14)).foregroundStyle(SP.ink)
          TextField("~/talos-agent", text: $drafts.dir).settingsField().onSubmit { commitDrafts() }
            .font(.system(size: 12, design: .monospaced))
            .accessibilityLabel("Agent folder")
          Button("Change\u{2026}") { chooseFolder() }.buttonStyle(SettingsLinkStyle())
        }
        SettingsCaption(folderCheck.text, color: folderCheck.isProblem ? SP.orange : SP.muted, size: 12)
      }
      .padding(.horizontal, 18).padding(.vertical, 11)
      SettingsDivider()
      hostRow
      SettingsDivider()
      SettingsSwitchRow(title: MacSettingsText.autoConfirmTitle, isOn: bind(\.autoConfirmRestart), size: 14)
        .help(MacSettingsText.autoConfirmHelp)
      SettingsDivider()
      SettingsSwitchRow(title: "Show my agent's screen when it needs me", isOn: bind(\.openTerminalOnDialog), size: 14)
      SettingsDivider()
      SettingsSwitchRow(title: "Unstick my agent when it stops answering", isOn: bind(\.unstickMain), size: 14)
        .help(MacSettingsText.unstickHelp)
      SettingsDivider()
      SettingsSwitchRow(title: "Open the Talos window when Talos starts", isOn: bind(\.openWindowAtLaunch), size: 14)
      SettingsDivider()
      SettingsSwitchRow(title: "Also show reply banners with the Companion", isOn: $replyBanners, size: 14)
        .help("When Talos is in the background and the Companion can show a reply itself, its bubble replaces the banner. On gives both.")
      SettingsDivider()
      SettingsRow(title: MacWords.takeOver, size: 14) {
        Button("Look for one") { model.findSessionToAdopt() }.buttonStyle(SettingsLinkStyle())
          .disabled(model.adoptLooking)
          .accessibilityIdentifier("take-over")
      }
    }
  }

  private var hostRow: some View {
    let canChange = HostChoice.canChange(sessionUp: model.sessionIsUp, workersRunning: model.workersRunning)
    return VStack(alignment: .leading, spacing: 6) {
      SettingsRow(title: "Terminal host", size: 14) {
        Picker(
          "Terminal host",
          selection: Binding(get: { cfg.host }, set: { v in save { $0.host = v } })
        ) {
          ForEach(HostChoice.all, id: \.self) { Text(HostChoice.label($0)).tag($0) }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .frame(width: 330)
        .disabled(!canChange)
        .accessibilityLabel("Terminal host")
      }
      VStack(alignment: .leading, spacing: 4) {
        if !canChange { SettingsCaption(HostChoice.lockedNote, color: SP.orange, size: 12) }
        SettingsCaption(HostChoice.runningLine(tmux: model.hostKind == .tmux), size: 12)
        if let c = HostChoice.caveat(choice: cfg.host, tmuxUsable: model.tmuxUsable) { SettingsCaption(c, color: SP.orange, size: 12) }
        SettingsCaption(HostChoice.appliesNote, size: 12)
      }
      .padding(.horizontal, 18).padding(.bottom, 10)
    }
  }

  // MARK: the Talos server and the talos-app command

  private var serverSection: some View {
    SettingsSection(title: "Talos server") {
      let why = MacSettingsText.connectionNotice(model.liveNotice, hasRelay: web.hasRelay)
      if !why.isEmpty {
        SettingsCaption(why, color: SP.orange).accessibilityIdentifier("connection-notice")
      }
      SettingsCard {
        HStack(spacing: 12) {
          Text("Talos server address").font(OB.body(14)).foregroundStyle(SP.ink)
          TextField(MacSettingsText.relayHint, text: $drafts.relay).settingsField().onSubmit { commitDrafts() }
            .accessibilityLabel("Talos server address")
        }
        .padding(.horizontal, 18).padding(.vertical, 11)
        SettingsDivider()
        HStack(spacing: 12) {
          Text("talos-app command").font(OB.body(14)).foregroundStyle(SP.ink)
          TextField("auto (PATH, then the agent folder's .mcp.json)", text: $drafts.cli).settingsField()
            .onSubmit { commitDrafts() }
            .accessibilityLabel("talos-app command")
        }
        .padding(.horizontal, 18).padding(.vertical, 11)
      }
      SettingsCaption(
        MacSettingsText.relayUsing(web.relay?.url.absoluteString)
          + " Leave the command empty unless Connect can't find it, then enter e.g. bun run /path/to/talos-app/apps/bridge/src/cli.ts",
        size: 12)
    }
  }

  // MARK: the buttons

  private var chips: some View {
    FlowButtons {
      Button(MacWords.showAgentScreen.replacingOccurrences(of: "\u{2026}", with: "")) {
        TerminalWindowController.shared.attach(model: model)
        TerminalWindowController.shared.show()
      }
      Button(MacWords.showProblemReport) { TalosApp.openLog(model: model) }
      Button(MacWords.showSettingsFile) {
        reveal(SupervisorController.configPath, what: "desktop.json", madeBy: MacAbout.configMissing)
      }
      Button("Show the Mac app's log") { reveal(SupervisorController.auditPath, what: "Mac app log", madeBy: MacAbout.logMissing) }
      Button(MacWords.copyTerminalCommand) { model.copyTerminalCommand() }.disabled(!model.configured)
      if model.hostKind == .tmux { Button(MacWords.copyAttachCommand) { model.copyAttachCommand() } }
    }
  }

  func reveal(_ path: String, what: String, madeBy: String) {
    switch MacAbout.reveal(path: path, exists: FileManager.default.fileExists(atPath: path), what: what, madeBy: madeBy) {
    case .show(let p):
      generalNote = ""
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
    case .missing(let m):
      generalNote = m
    }
  }
}

/// Pill buttons that wrap onto the next line when the window is narrow.
struct FlowButtons<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    WrapLayout(spacing: 8) { content }
      .buttonStyle(SettingsPillStyle())
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Lays its children out left to right and starts a new line when one no longer fits.
struct WrapLayout: Layout {
  var spacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    return place(subviews, in: width).size
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let laid = place(subviews, in: bounds.width)
    for (i, f) in laid.frames.enumerated() {
      subviews[i].place(at: CGPoint(x: bounds.minX + f.minX, y: bounds.minY + f.minY), proposal: ProposedViewSize(f.size))
    }
  }

  private func place(_ subviews: Subviews, in width: CGFloat) -> (frames: [CGRect], size: CGSize) {
    var frames: [CGRect] = []
    var x: CGFloat = 0
    var y: CGFloat = 0
    var rowHeight: CGFloat = 0
    var maxX: CGFloat = 0
    for s in subviews {
      let size = s.sizeThatFits(.unspecified)
      if x > 0, x + size.width > width {
        x = 0
        y += rowHeight + spacing
        rowHeight = 0
      }
      frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
      maxX = max(maxX, x - spacing)
    }
    return (frames, CGSize(width: maxX, height: y + rowHeight))
  }
}

/// What Take over, Import and a blocked start show, in Advanced: the agent's status line, who holds the channels, the way to take
/// over a running agent, and Import for your own start-up command.
struct SessionView: View {
  @ObservedObject var model: SupervisorController
  @State private var command = ""
  @State private var importError: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(model.statusLine).font(.headline)
      let blockers: [TakeoverCheck.Blocker] = { if case .blocked(let b) = model.status.phase { return b } else { return [] } }()
      // The Blocked screen says who holds the channels once; the notice that repeats it is dropped.
      let notice = BlockedText.notice(model.liveNotice, whileBlocked: !blockers.isEmpty)
      if !notice.isEmpty { Text(notice).foregroundStyle(.orange) }
      if !model.threadNotice.isEmpty {
        Text(model.threadNotice).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
      }
      ForEach(Array(BlockedText.lines(blockers).enumerated()), id: \.offset) { _, line in
        Text(line).fixedSize(horizontal: false, vertical: true)
      }
      if BlockedText.offersStartAnyway(blockers) {
        Text(BlockedText.startAnywayWarning).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Button(BlockedText.startAnywayButton) { model.startAnyway() }
      }
      if model.failedStop {
        HStack {
          if !model.retryCannotWork { Button("Try again") { model.start() } }
          Button("Start a new conversation") { model.startNewConversation() }
        }
      }
      if let plan = model.adopt {
        GroupBox("Adopt pid \(plan.pid)") {
          VStack(alignment: .leading, spacing: 4) {
            Text("Folder: \(plan.agentDir)")
            Text("Args: \(plan.args.joined(separator: " "))").lineLimit(3)
            Text("Session: \(plan.sessionId ?? "none found")")
            Text(model.adoptNote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button("Continue") { model.continueAdopt() }
          }
        }
      } else if !model.adoptNote.isEmpty {
        Text(model.adoptNote).foregroundStyle(.secondary)
      }
      Divider()
      Text("Import your launch command").font(.subheadline)
      Text("cd <folder> && [VAR=value …] claude <args…>. Talos runs it without a shell.")
        .font(.caption).foregroundStyle(.secondary)
      TextField("cd ~/agent && claude --dangerously-skip-permissions …", text: $command)
      HStack {
        Button("Import") { importError = model.importCommand(command, thenStart: true) }
        if let e = importError { Text(e).foregroundStyle(.red) }
      }
      if importError == nil, !model.importNote.isEmpty {
        Text(model.importNote).font(.callout).foregroundStyle(.green).fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("import-saved")
      }
      Divider()
      Text(
        model.hostKind == .tmux
          ? "The agent runs in tmux and keeps running when Talos quits."
          : "tmux 3.2+ not found: the agent stops when Talos quits."
      )
      .font(.caption).foregroundStyle(.secondary)
    }
  }
}

