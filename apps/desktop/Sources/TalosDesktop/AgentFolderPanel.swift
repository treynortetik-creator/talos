import AppKit
import SwiftUI

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
  }

  @ViewBuilder private var card: some View {
    switch flow.step {
    case .idle, .working: EmptyView()
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
    case .done(let m): note(m).foregroundStyle(.green)
    case .failed(let m): note(m).foregroundStyle(.red)
    }
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
