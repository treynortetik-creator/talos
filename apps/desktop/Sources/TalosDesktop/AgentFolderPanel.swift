import AppKit
import SwiftUI
import TalosSupervisor

/// The Agent folder row's controls: the folder box and the three ways, then whatever card the flow is showing. All the
/// decisions are the flow's; this only draws them.
struct AgentFolderPanel: View {
  @ObservedObject var flow: AgentFolderFlow

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        TextField("~/talos-agent", text: $flow.path).textFieldStyle(.roundedBorder).accessibilityIdentifier("agent-folder-path")
        Button("Browse…") { browse() }
      }
      HStack {
        Button("Create") { Task { await flow.create() } }
          .help("Make a new Talos agent in this folder. It must be new or empty.")
        Button("Adopt") { Task { await flow.adopt() } }
          .help("Connect a Claude Code folder you already use. Only its .mcp.json (and any MCP-app hooks) change.")
        Button("Choose") { Task { await flow.choose() } }
          .help("Use a Talos agent folder you already have.")
        if flow.busy { ProgressView().controlSize(.small) }
      }
      .disabled(flow.busy)
      card
    }
    .task {
      flow.presentUpdaterRequest()
      await flow.autoSetup()
    }
    .onReceive(CloneConfirmCenter.shared.$pending) { _ in flow.presentUpdaterRequest() }
  }

  @ViewBuilder private var card: some View {
    switch flow.step {
    case .idle, .working: EmptyView()
    case .provisioning(let lines):
      progressList(lines)
    case .provisionFailed(let lines, let message):
      progressList(lines)
      note(message).foregroundStyle(.red)
      Button(lines.contains { $0.step == .developerTools && { if case .failed = $0.state { return true } else { return false } }($0) } ? "Try again" : "Retry") {
        Task { await flow.retryProvision() }
      }
    case .confirmAdopt(_, let plan, _):
      note(plan)
      HStack {
        Button("Connect") { Task { await flow.confirm() } }
        Button("Cancel") { flow.cancel() }
      }
    case .confirmRepoint(_, let why):
      note("\(why)\nReplace it so it runs this Talos?")
      HStack {
        Button("Replace") { Task { await flow.confirm() } }
        Button("Leave it") { flow.cancel() }
      }
    case .offerUpgrade(_, let version, let command, let note):
      self.note(note).foregroundStyle(.green)
      self.note("This is a kit \(version) folder. To see what an update would change (it changes nothing), Talos can run:\n\(command)")
      HStack {
        Button("Show what it would change") { Task { await flow.showUpgrade() } }
        Button("Not now") { flow.declineUpgrade() }
      }
    case .upgradePreview(let text, let command, let note):
      self.note(note).foregroundStyle(.green)
      self.note(text)
      self.note("To apply the update, run this in Terminal without --dry-run:\n\(command.replacingOccurrences(of: " --dry-run", with: ""))")
    case .confirmClone(let clone, _):
      note(
        "Talos will run this clone's install.sh and start your agent with its Talos mod:\n\(clone)\n"
          + "It was recorded by apps/desktop/scripts/install.sh, and this Talos hasn't used it before. Use it only if it is the clone you installed Talos from."
      )
      .accessibilityIdentifier("agent-folder-clone-card")
      HStack {
        Button("Use this clone") { Task { await flow.useClone() } }
        Button("Cancel") { flow.cancel() }
      }
    case .done(let m): note(m).foregroundStyle(.green)
    case .failed(let m): note(m).foregroundStyle(.red)
    }
  }

  private func progressList(_ lines: [AgentFolderFlow.ProvisionLine]) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(lines, id: \.step) { l in
        switch l.state {
        case .none: note("   \(l.step.title)")
        case .running: note("…  \(l.step.title)")
        case .waiting(let text): note("…  \(text)").foregroundStyle(.orange)
        case .done: note("✓  \(l.step.title)")
        case .failed: note("✗  \(l.step.title)").foregroundStyle(.red)
        }
      }
    }.accessibilityIdentifier("agent-folder-provision")
  }

  private func note(_ s: String) -> some View {
    Text(s).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
  }

  private func browse() {
    let p = NSOpenPanel()
    p.canChooseFiles = false
    p.canChooseDirectories = true
    p.canCreateDirectories = true
    if p.runModal() == .OK, let u = p.url { flow.path = u.path }
  }
}
