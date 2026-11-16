import Foundation
import Testing

/// The Terminals window looks every 1.5 s, on the main thread. Whether the agent's tmux session exists is the last answer a background
/// probe found (`cachedAgentSessionExists`), never a `tmux has-session` run there and then: a slow tmux server would stop the whole app.
/// The window's controller needs a running app to build, so this reads its source.
@Suite("The Terminals window's look")
struct TerminalWindowTickTests {
  @Test func itNeverRunsTmuxOnTheMainThread() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let src = try String(contentsOf: root.appendingPathComponent("Sources/TalosDesktop/TerminalWindow.swift"), encoding: .utf8)
    let start = try #require(src.range(of: "private func tick() {"))
    let end = try #require(src.range(of: "\n  }\n", range: start.upperBound..<src.endIndex))
    let body = src[start.upperBound..<end.lowerBound]
    #expect(!body.contains("model.agentSessionExists()"), "the look runs tmux has-session itself")
    #expect(body.contains("cachedAgentSessionExists()"), "the look uses the probe's last answer")
  }
}
