import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// Every thread session records its plan-usage reading through its status line (WorkerUsage), so the bridge can show the newest
/// reading of any session instead of main's frozen one. The program text is the protocol package's (swift-parity.test.ts).
@Suite("Worker usage recorder")
struct WorkerUsageTests {
  @Test func everyLaunchSetsTheRecorderAsItsStatusLineRunByTheHooksPython() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let spec = try WorkerSpec.build(fenceInputs(t))
    let line = try #require(jsonObject(spec.settingsJSON)?["statusLine"] as? [String: Any])
    #expect(line["type"] as? String == "command")
    #expect(line["padding"] as? Int == 0)
    let usage = t.talosHome + "/workers/trip/usage.json"
    #expect(WorkerUsage.path(talosHome: t.talosHome, threadId: "trip") == usage)
    #expect(line["command"] as? String == WorkerUsage.command(python: testHook.python, usageFile: usage))
    // and the guards merged in do not lose it, nor does it loosen anything the last check holds
    try t.installGuards(#"{"permissions":{"deny":["Bash(rm:*)"]},"statusLine":{"type":"command","command":"/tmp/x.sh"}}"#)
    let guarded = try WorkerSpec.build(fenceInputs(t))
    let kept = try #require(jsonObject(guarded.settingsJSON)?["statusLine"] as? [String: Any])
    #expect(kept["command"] as? String == WorkerUsage.command(python: testHook.python, usageFile: usage))
    try guarded.validate()
  }

  @Test func theProgramHasNoBackslashOrSingleQuoteAndTheCommandQuotesItsPaths() {
    #expect(!WorkerUsage.recorderSource.contains("\\"))
    #expect(!WorkerUsage.recorderSource.contains("'"))
    let c = WorkerUsage.command(python: "/opt/py's/python3", usageFile: "/home/alex/.talos/workers/trip/usage.json")
    #expect(c.hasPrefix("exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 '/opt/py'\\''s/python3' -I -c '"))
    #expect(c.hasSuffix(" '/home/alex/.talos/workers/trip/usage.json'"))
  }

  /// The command as built here, run by a shell with the documented status-line JSON on stdin, as Claude Code runs it.
  @Test func runForRealItWritesTheReadingAndPrintsTheLine() throws {
    let python = ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"].first {
      FileManager.default.isExecutableFile(atPath: $0)
    }
    let py = try #require(python, "no python3 on this Mac")
    let dir = TestTemp.base + "worker-usage-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let file = dir + "/usage.json"
    let input = #"{"session_id":"6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41","model":{"display_name":"Opus"},"rate_limits":{"seven_day":{"used_percentage":35.2,"resets_at":1763164800}}}"#
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", WorkerUsage.command(python: py, usageFile: file)]
    let stdin = Pipe(), stdout = Pipe()
    p.standardInput = stdin
    p.standardOutput = stdout
    try p.run()
    stdin.fileHandleForWriting.write(Data(input.utf8))
    try stdin.fileHandleForWriting.close()
    p.waitUntilExit()
    #expect(p.terminationStatus == 0)
    let out = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    #expect(out.trimmingCharacters(in: .whitespacesAndNewlines) == "Talos: Opus | 7d: 35%")
    let written = try #require(jsonObject(String(decoding: try Data(contentsOf: URL(fileURLWithPath: file)), as: UTF8.self)))
    #expect(written["session_id"] as? String == "6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41")
    let seven = (written["rate_limits"] as? [String: Any])?["seven_day"] as? [String: Any]
    #expect(seven?["used_percentage"] as? Double == 35.2)
    let at = try #require(written["at"] as? Double)
    #expect(abs(at - Date().timeIntervalSince1970) < 30)
  }

  /// What the real recorder prints for each of `inputs` (the program as built here, `WorkerUsage.recorderSource`), all in ONE python3
  /// process: a small driver runs the program's text once per input with that input on stdin and the usage file as its argument, as
  /// `python3 -I -c <program> <file>` does. One process, not one per case (`runForRealItWritesTheReadingAndPrintsTheLine` runs the
  /// command itself through a shell).
  static func recorderLines(_ inputs: [String], python: String, dir: String) throws -> [String] {
    let program = dir + "/recorder.py"
    try WorkerUsage.recorderSource.write(toFile: program, atomically: true, encoding: .utf8)
    let driver = """
      import io, json, sys
      src, usage = sys.argv[1], sys.argv[2]
      code = compile(open(src).read(), src, "exec")
      outs = []
      for inp in json.load(sys.stdin):
          sys.stdin = io.StringIO(inp)
          sys.stdout = io.StringIO()
          sys.argv = ["-c", usage]
          exec(code, {"__name__": "__main__"})
          outs.append(sys.stdout.getvalue())
      sys.stdout = sys.__stdout__
      print(json.dumps(outs))
      """
    let p = Process()
    p.executableURL = URL(fileURLWithPath: python)
    p.arguments = ["-I", "-c", driver, program, dir + "/usage.json"]
    p.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
    let stdin = Pipe(), stdout = Pipe()
    p.standardInput = stdin
    p.standardOutput = stdout
    try p.run()
    stdin.fileHandleForWriting.write(try JSONSerialization.data(withJSONObject: inputs))
    try stdin.fileHandleForWriting.close()
    let out = stdout.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard p.terminationStatus == 0, let lines = try JSONSerialization.jsonObject(with: out) as? [String], lines.count == inputs.count else {
      throw CocoaError(.fileReadCorruptFile)
    }
    return lines
  }

  /// The recorder and the key guard can never disagree: for awkward model names and readings, the REAL recorder's output is exactly one
  /// row, in the new form (`BoxFrame.talosStatusLine`, never the old row the guard takes for one release), and Claude's empty input box
  /// with that row under it takes the pointer.
  @Test func everyLineTheRecorderPrintsIsOneRowTheKeyGuardAllows() throws {
    let python = ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"].first {
      FileManager.default.isExecutableFile(atPath: $0)
    }
    let py = try #require(python, "no python3 on this Mac")
    let dir = TestTemp.base + "worker-usage-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    func json(_ name: String?, _ pct: String?) -> String {
      var parts: [String] = []
      if let name { parts.append(#""model":{"display_name":"# + "\"\(name)\"" + "}") }
      if let pct { parts.append(#""rate_limits":{"seven_day":{"used_percentage":"# + pct + "}}") }
      return "{" + parts.joined(separator: ",") + "}"
    }
    let names = [
      "Opus 5.5+", "claude-sonnet-4-5[1m]", "a_b", "x@y", "a,b", "a:b", "a/b", "Ópus", "two  spaces", "Opus 5.5 (1M context)",
      "Sonnet 4.5", "a b c d e f", String(repeating: "a", count: 39) + " b", "",
    ]
    var cases: [(String, String)] = names.map { ($0, json($0, "35.2")) } + names.map { ($0 + " at 100", json($0, "100")) }
    cases += [("101%", json("Opus", "101")), ("150%", json("Opus", "150")), ("-1%", json("Opus", "-1")), ("no seven_day", json("Opus", nil))]
    cases += [("no rate_limits", #"{"model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":3}}}"#)]
    let box = [String(repeating: "─", count: 60), "❯ ", String(repeating: "─", count: 60)]
    let outs = try Self.recorderLines(cases.map(\.1), python: py, dir: dir)
    for ((what, _), out) in zip(cases, outs) {
      let rows = out.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
      #expect(rows.count == 2 && rows[1].isEmpty, "\(what): one row and its newline: \(out.debugDescription)")
      #expect(rows[0].count <= 26, "\(what): \(rows[0])")
      #expect(BoxFrame.matches(BoxFrame.talosStatusLine, rows[0]), "\(what): \(rows[0])")
      #expect(BoxFrame.isTalosStatusLine(rows[0]), "\(what): \(rows[0])")
      #expect(KeyGuard.allows(["⏺ Done."] + box + [rows[0]], intent: .box(.empty)), "\(what): \(rows[0])")
    }
    // and the cut (8, then no trailing space or dot: the row fits a 30-column pane), the clamps and the fallbacks, by value
    let byValue: [(String, String)] = [
      (json("Opus", "150"), "Talos: Opus | 7d: 100%\n"), (json("Opus", "-1"), "Talos: Opus | 7d: 0%\n"), (json("", "35"), "Talos\n"),
      (json("x@y", "35"), "Talos: x y | 7d: 35%\n"), (json("Sonnet 4.5", "100"), "Talos: Sonnet 4 | 7d: 100%\n"),
      (json("Opus 5.5 (1M context)", "35"), "Talos: Opus 5.5 | 7d: 35%\n"), (json("a b c d e f", "35"), "Talos: a b c d | 7d: 35%\n"),
      (json(String(repeating: "a", count: 39) + " b", "35"), "Talos: aaaaaaaa | 7d: 35%\n"),
    ]
    #expect(try Self.recorderLines(byValue.map(\.0), python: py, dir: dir) == byValue.map(\.1))
  }
}
