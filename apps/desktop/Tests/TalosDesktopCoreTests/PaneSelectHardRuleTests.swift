import Foundation
import Testing

@testable import TalosDesktopCore

/// THE HARD RULE for the tool permission and the agent's question (pane-prompts plan, Approved): only a real person's tap answers them. The sources are
/// read here, as `KeyGuardTests` reads them for the safety popups: who can reach the code that sends their keys.
@Suite("Pane prompts: only a person's tap answers")
struct PaneSelectHardRuleTests {
  static let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources")

  /// Every non-comment line of every Swift file under the targets, as (file, line).
  static func lines(_ targets: [String] = ["TalosSupervisor", "TalosDesktop", "TalosDesktopCore"]) throws -> [(file: String, line: String)] {
    var out: [(String, String)] = []
    for t in targets {
      let dir = sources.appendingPathComponent(t)
      for f in try FileManager.default.contentsOfDirectory(atPath: dir.path) where f.hasSuffix(".swift") {
        let text = try String(contentsOf: dir.appendingPathComponent(f), encoding: .utf8)
        for l in text.split(separator: "\n") where !l.trimmingCharacters(in: .whitespaces).hasPrefix("//") { out.append((f, String(l))) }
      }
    }
    return out
  }

  static func calls(_ name: String) throws -> [String] {
    try lines().filter { $0.line.contains(name) && !$0.line.contains("func \(name)") }.map { "\($0.file): \($0.line.trimmingCharacters(in: .whitespaces))" }
  }

  @Test func theClickPathIsReachedOnlyFromThePopupButtonsAnswer() throws {
    let callers = try Self.calls("paneClick(")
    #expect(callers.count == 1 && callers[0].hasPrefix("SupervisorDevPopup.swift:"), "\(callers)")
    let popup = try String(contentsOf: Self.sources.appendingPathComponent("TalosSupervisor/SupervisorDevPopup.swift"), encoding: .utf8)
    let at = try #require(popup.range(of: "let r = paneClick("))
    #expect(popup[..<at.lowerBound].contains("guard case .choose(let choice, let label) = action"), "after the action is a choose")
    // the popup's button is the only caller of popupAnswerMain, behind `isRealClick`
    let main = try Self.calls("popupAnswerMain(")
    #expect(main.allSatisfy { $0.hasPrefix("SupervisorDevPopup.swift:") || $0.hasPrefix("NeedsYouPopup") || $0.hasPrefix("PopupController") || $0.contains("popupAnswer(") }, "\(main)")
  }

  @Test func theTapPathNeedsTheOwnersSignatureAndIsNotReadFromAnywhereElse() throws {
    let file = try String(contentsOf: Self.sources.appendingPathComponent("TalosSupervisor/SupervisorPanePrompt.swift"), encoding: .utf8)
    // the one place that reads an answer file, and what it does with it: a proof check before any key
    #expect(file.components(separatedBy: "DialogAnswerFile.read(").count - 1 == 1)
    #expect(file.contains("DialogProofCheck.verify(") && file.contains("case .no(let why, _): return (.nothing(why), false)"))
    let verify = try #require(file.range(of: "DialogProofCheck.verify("))
    let press = try #require(file.range(of: "switch pressPane(offer, choice, text: DialogProofCheck.signedText(a)"))
    #expect(verify.lowerBound < press.lowerBound, "the proof is checked before the key")
    let takers = try Self.calls("takePaneAnswer(")
    #expect(takers.count == 1 && takers[0].hasPrefix("SupervisorLive.swift:"), "\(takers)")
    // the worker side: `press` is called from the verified answer and the popup click only
    let presses = try Self.calls(" press(id, offer").filter { $0.hasPrefix("WorkerDialog") }
    #expect(presses.count == 2 && presses.allSatisfy { $0.hasPrefix("WorkerDialogAnswer.swift:") || $0.hasPrefix("WorkerDialogPopup.swift:") }, "\(presses)")
    let answer = try String(contentsOf: Self.sources.appendingPathComponent("TalosSupervisor/WorkerDialogAnswer.swift"), encoding: .utf8)
    let ok = try #require(answer.range(of: "case .ok(let choice, let label, _):"))
    let call = try #require(answer.range(of: "return press(id, offer, choice, label, text: DialogProofCheck.signedText(a))"))
    #expect(ok.lowerBound < call.lowerBound)
  }

  @Test func everyPaneKeySendStatesTheOffersOwnBindingAndGoesThroughTheGate() throws {
    for f in ["SupervisorPanePrompt.swift", "WorkerPaneAnswer.swift"] {
      let code = try String(contentsOf: Self.sources.appendingPathComponent("TalosSupervisor/" + f), encoding: .utf8)
      let ls = code.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.hasPrefix("//") }
      let sends = ls.filter { $0.contains(".sendSelectNumber(") || $0.contains(".sendAnswerText(") || $0.contains(".sendDialogKey(") }
      #expect(sends.allSatisfy { $0.contains("sendKey(") }, "\(f): \(sends)")
    }
    // the driver never sends itself: it asks its owner's gate, with `.pane`
    let driver = try String(contentsOf: Self.sources.appendingPathComponent("TalosSupervisor/PaneAnswer.swift"), encoding: .utf8)
    #expect(!driver.contains("sendSelectNumber") && !driver.contains("sendAnswerText") && !driver.contains("sendDialogKey"))
    #expect(driver.contains(".pane(KeyGuard.PaneBinding("))
    // and nothing offers a tool permission's standing grant: no card option is built from a screen row but `Allow once` and `Deny`
    let select = try String(contentsOf: Self.sources.appendingPathComponent("TalosDesktopCore/PaneSelect.swift"), encoding: .utf8)
    #expect(select.contains("case .toolPermission: return [allowLabel, denyLabel]"))
  }

  @Test func noAgentOrWorkerPathAnswersThem() throws {
    // an agent's own request file (`agent-request.json`), the bridge's tools and the scripting entry points never name the pane answer code
    let names = ["pressPane(", "paneClick(", "takePaneAnswer(", "PaneAnswerDriver"]
    for f in try Self.lines(["TalosDesktop", "TalosDesktopCore"]) {
      for n in names { #expect(!f.line.contains(n), "\(f.file): \(f.line)") }
    }
    let agent = try String(contentsOf: Self.sources.appendingPathComponent("TalosDesktopCore/AgentRequest.swift"), encoding: .utf8)
    #expect(!agent.contains("toolPermission") && !agent.contains("agentQuestion") && !agent.contains("dialog-answer"))
  }

  /// The popup button's own guard, which every button of these popups goes through (`NeedsYouPopupView`): a real left click from the mouse or trackpad
  /// is the only one. An Accessibility press has no event, a posted `CGEvent` carries its poster's pid, and a stale or off-button event is not a click.
  @Test func aSyntheticOrAccessibilityPressIsNotAClick() {
    func real(_ kind: PopupClickCheck.Kind = .leftMouseUp, age: Double = 0.1, window: Bool = true, button: Bool = true, pid: Int64 = 0, state: Int64 = 1, flight: Bool = false) -> Bool {
      PopupClickCheck.isRealClick(kind: kind, age: age, sameWindow: window, onButton: button, sourcePid: pid, sourceStateId: state, eventsOfOursInFlight: flight)
    }
    #expect(real(), "control: the owner's click")
    #expect(!real(.other), "an Accessibility press: no mouse event")
    #expect(!real(pid: 4242), "a program's posted click carries its pid")
    #expect(!real(pid: -1, state: -1), "no CGEvent at all")
    #expect(!real(state: 0) && !real(age: 5) && !real(window: false) && !real(button: false))
    #expect(!real(flight: true), "an event this app posted for an agent is still on its way")
  }
}
