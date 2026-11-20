import Foundation
import Testing

@testable import TalosDesktopCore

/// The guard for the new setup's words (the sibling of scripts/pane-strings.test.ts): nothing the owner reads on these screens may say
/// session, bridge, relay, tmux, Terminal or launch command. It checks the strings the screens use, the plain-words table, and every
/// string literal in the screens' own source, so a new sentence typed straight into a view is caught too.
@Suite("Onboarding words")
struct OnboardingCopyGuardTests {
  @Test func noScreenStringUsesAnEngineerWord() {
    for s in OnboardingCopy.all { #expect(OnboardingCopy.forbiddenWords(in: s).isEmpty, Comment(rawValue: "“" + s + "” says " + OnboardingCopy.forbiddenWords(in: s).joined(separator: ", "))) }
  }

  @Test func theGuardCatchesEachForbiddenWord() {
    for w in ["Open Terminal and run", "the bridge is up", "Relay address", "tmux attach", "launch command", "Start session", "your sessions"] {
      #expect(!OnboardingCopy.forbiddenWords(in: w).isEmpty, Comment(rawValue: w))
    }
    #expect(OnboardingCopy.forbiddenWords(in: "sessionless terminally").isEmpty)  // whole words only
  }

  @Test func theWordsComeFromTheMock() {
    #expect(OnboardingCopy.welcomeTitle == "Welcome to Talos")
    #expect(OnboardingCopy.readyTitle == "Getting Talos ready")
    #expect(OnboardingCopy.appleTitle == "One quick Apple install first")
    #expect(OnboardingCopy.signInButton == "Sign in with Claude")
    #expect(OnboardingCopy.phoneYes == "Yes, on my phone too")
    #expect(OnboardingCopy.phoneNo == "Just this Mac for now")
    #expect(OnboardingCopy.pairMatch == "The words match")
    #expect(OnboardingCopy.pairNoMatch == "They don't match")
    #expect(OnboardingCopy.offlineButton == "Try again now")
  }

  /// Apple's real macOS 26 dialog has Cancel and Install, nothing else.
  @Test func theAppleWindowCardShowsCancelAndInstall() {
    #expect(OnboardingCopy.appleWindowButtons == ["Cancel", "Install"])
  }

  @Test func theAppleClickLineNamesInstallAndAgree() {
    #expect(OnboardingCopy.appleClick + OnboardingCopy.appleClickRest == "Click Install, then Agree, in Apple's window. It takes about 5 minutes, then Talos carries on by itself.")
    #expect(OnboardingCopy.appleWindowAgree.contains("Agree"))
    #expect(OnboardingCopy.appleClosed.contains("Install and Agree"))
  }

  /// The setup window stays an ordinary window: Apple's installer opens in front of it, never under a floating one.
  @Test func theSetupScreensNeverFloatAboveOtherWindows() throws {
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop")
    for f in ["Onboarding.swift", "OnboardingScreens.swift", "OnboardingCoordinator.swift", "OnboardingLive.swift", "OnboardingSteps.swift", "OnboardingTheme.swift"] {
      let text = try String(contentsOf: sources.appendingPathComponent(f), encoding: .utf8)
      #expect(!text.contains(".floating") && !text.contains("isFloatingPanel") && !text.contains("level ="), Comment(rawValue: f))
    }
  }

  /// Every quoted literal in the screens' source files (the three views and the coordinator's own words).
  @Test func noLiteralInTheScreenSourcesUsesAnEngineerWord() throws {
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop")
    var checked = 0
    for f in ["OnboardingScreens.swift", "OnboardingTheme.swift", "OnboardingCoordinator.swift", "OnboardingLive.swift"] {
      let text = try String(contentsOf: sources.appendingPathComponent(f), encoding: .utf8)
      for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("//") || t.hasPrefix("///") { continue }
        let code = t.components(separatedBy: " // ").first ?? t
        for lit in literals(in: code) {
          checked += 1
          #expect(OnboardingCopy.forbiddenWords(in: lit).isEmpty, Comment(rawValue: f + ": “" + lit + "”"))
        }
      }
    }
    #expect(checked > 20)  // the scan really read the files
  }

  @Test func theOldChecklistsEngineerWordsAreNotInTheNewFlow() {
    // the strings the old checklist showed are not reused by the new screens
    let old = [OnboardingText.firstStartIdle, OnboardingText.terminalFallback, OnboardingText.brewFailed, OnboardingText.firstStartTerminal]
    let new = Set(OnboardingCopy.all)
    for o in old { #expect(!new.contains(o)) }
  }

  private func literals(in line: String) -> [String] {
    var out: [String] = []
    var cur = ""
    var inString = false
    var escaped = false
    for c in line {
      if inString {
        if escaped { cur.append(c); escaped = false } else if c == "\\" { escaped = true } else if c == "\"" { out.append(cur); cur = ""; inString = false } else { cur.append(c) }
      } else if c == "\"" { inString = true }
    }
    return out
  }
}
