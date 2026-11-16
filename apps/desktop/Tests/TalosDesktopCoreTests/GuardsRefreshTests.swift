import Foundation
import Testing
import TalosDesktopCore

/// The one line `talos-app guards refresh` prints (apps/bridge/src/guards/refresh.ts), read strictly: only its fixed words go on.
@Suite("Guards refresh answer")
struct GuardsRefreshTests {
  func parse(_ s: String, status: Int32 = 0, timedOut: Bool = false) -> GuardsRefresh.Outcome {
    GuardsRefresh.parse(status: status, timedOut: timedOut, stdout: Data(s.utf8))
  }

  @Test func theBridgesLinesAreRead() {
    #expect(parse("guards refresh: unchanged\n") == .unchanged)
    #expect(parse("guards refresh: changed bun\n") == .changed([.bun]))
    #expect(parse("guards refresh: changed rules bun checkout\n") == .changed([.rules, .bun, .checkout]))
    #expect(parse("guards refresh: changed settings\n") == .changed([.settings]))
    for w in GuardsRefresh.refusals { #expect(parse("guards refresh: refused \(w)\n", status: w == "arguments" ? 2 : 1) == .refused(w)) }
  }

  @Test func anythingElseIsAFailureAndCarriesNoneOfItsText() {
    let cases: [(String, Int32, Bool)] = [
      ("", 0, false), ("guards refresh: unchanged", 0, true), ("guards refresh: changed\n", 0, false),
      ("guards refresh: changed bun bun\n", 0, false), ("guards refresh: changed bun /home/alex/secret\n", 0, false),
      ("guards refresh: unchanged\nguards refresh: changed bun\n", 0, false), ("note\nguards refresh: unchanged\n", 0, false),
      ("guards refresh: refused damaged\n", 0, false), ("guards refresh: refused made-up\n", 1, false),
      ("guards refresh: unchanged\n", 1, false), ("Usage: talos-app ...\n", 2, false), ("guards refresh: unchanged extra\n", 0, false),
    ]
    for (text, status, timedOut) in cases {
      let o = parse(text, status: status, timedOut: timedOut)
      guard case .failed(let why) = o else { Issue.record("\(text.debugDescription) read as \(o)"); continue }
      #expect(["unreadable answer", "timed out", "exit \(status)"].contains(why), "\(text.debugDescription): \(why)")
    }
  }

  @Test func whatTheLogAndThePhoneGet() {
    #expect(GuardsRefresh.report(.unchanged) == nil, "nothing changed: no row")
    #expect(GuardsRefresh.report(.changed([.rules, .bun])) == .init(event: "guards_refreshed", fields: ["changed": "rules,bun"], tellOwner: false))
    #expect(GuardsRefresh.report(.refused("not-installed"))?.tellOwner == false)
    #expect(GuardsRefresh.report(.refused("busy"))?.tellOwner == false)
    #expect(GuardsRefresh.report(.refused("damaged")) == .init(event: "guards_refresh_failed", fields: ["why": "damaged"], tellOwner: true))
    #expect(GuardsRefresh.report(.failed("timed out"))?.tellOwner == true)
    let line = GuardsRefresh.phoneLine(why: "damaged")
    #expect(line.contains("(damaged)") && line.contains("talos-app install-guards"))
  }

  @Test func theTimeoutOutlastsTheWork() {
    // a refresh is a bun start and a few small files (measured well under a second on the M5); a cold start on a loaded Mac is seconds
    #expect(GuardsRefresh.timeout >= 10)
  }

  @Test func thePinsAreReadFromEveryShapeInstallWrote() {
    let sha = String(repeating: "b", count: 64)
    let legacy = #""/opt/homebrew/Cellar/bun/1.3.11/bin/bun" "/home/alex/talos-app/apps/bridge/src/cli.ts" guard-hook --config "/home/alex/.config/talos/guards/guards.json" --sha "# + sha
    let current = #"[ -f "/opt/homebrew/Cellar/bun/1.4.4/bin/bun" ] && [ -x "/opt/homebrew/Cellar/bun/1.4.4/bin/bun" ] && [ -f "/home/alex/talos-app/apps/bridge/src/cli.ts" ] && exec "/opt/homebrew/Cellar/bun/1.4.4/bin/bun" "/home/alex/talos-app/apps/bridge/src/cli.ts" guard-hook --config "/home/alex/.config/talos/guards/guards-x.json" --sha "#
      + sha + #" || printf '%s\n' '{"hookSpecificOutput":{}}'"#
    #expect(GuardsRefresh.pins(command: legacy)?.bun == "/opt/homebrew/Cellar/bun/1.3.11/bin/bun")
    #expect(GuardsRefresh.pins(command: legacy)?.cli == "/home/alex/talos-app/apps/bridge/src/cli.ts")
    #expect(GuardsRefresh.pins(command: current)?.bun == "/opt/homebrew/Cellar/bun/1.4.4/bin/bun")
    #expect(GuardsRefresh.pins(command: current)?.cli == "/home/alex/talos-app/apps/bridge/src/cli.ts")
    // a path with a quote in it, as JSON writes it
    #expect(GuardsRefresh.pins(command: #""/home/alex/a\"b/bun" "/home/alex/c/apps/bridge/src/cli.ts" guard-hook --config "x" --sha 1"#)?.bun == "/home/alex/a\"b/bun")
    for other in ["echo hi", #""/usr/bin/python3" "/home/alex/hook.py""#, #""bun" "/x/apps/bridge/src/cli.ts" guard-hook --config "c""#] {
      #expect(GuardsRefresh.pins(command: other) == nil, "\(other)")
    }
    let o: [String: Any] = ["hooks": ["PreToolUse": [["matcher": "Bash", "hooks": [["type": "command", "command": "echo"], ["type": "command", "command": legacy]]]]]]
    let settings = try? JSONSerialization.data(withJSONObject: o)
    #expect(GuardsRefresh.pins(settings: settings)?.bun == "/opt/homebrew/Cellar/bun/1.3.11/bin/bun")
    #expect(GuardsRefresh.pins(settings: Data("{}".utf8)) == nil)
  }

  @Test func sessionFoldersAndTempFoldersAreRefusedByWhatIsUnderThem() {
    let roots = ["/home/alex/agent", "/private/tmp"]
    #expect(GuardsRefresh.isUnder("/home/alex/agent/talos-app/apps/bridge/src/cli.ts", roots))
    #expect(GuardsRefresh.isUnder("/home/alex/agent", roots))
    #expect(!GuardsRefresh.isUnder("/home/alex/agent-other/cli.ts", roots), "a prefix of the name is not inside")
    #expect(GuardsRefresh.isUnder("/private/tmp/bun", roots))
    #expect(Set(GuardsRefresh.tmpRoots).isSuperset(of: ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]))
    #expect(GuardsRefresh.bunCandidates(home: "/home/alex") == ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", "/home/alex/.bun/bin/bun"])
    #expect(GuardsRefresh.childEnv(home: "/home/alex", talosHome: "/home/alex/t").keys.sorted() == ["HOME", "PATH", "TALOS_APP_HOME"])
    #expect(GuardsRefresh.parse(status: 1, timedOut: false, stdout: Data("guards refresh: refused checkout-moved\n".utf8)) == .refused("checkout-moved"))
  }
}
