import Foundation
import Testing
import TalosTestSupport

/// R1-5, part 2: does the real `claude` (a Bun executable) load a `.env` from the folder it starts in? Bun itself does, before any
/// script runs. Run without a session (`--help` only, no plugins, a fresh home), so the only way to see it is cost: a `.env` with a
/// variable past a large hole (a sparse file, nothing on disk) makes a runtime that reads it hold the whole file in memory. Bun, the
/// control, does exactly that; `claude --help` must not. Skipped where neither is installed. A session path that reads `.env` later
/// is not covered (that needs a session): the thread folders' `.env*` are fenced from edits either way (WorkerFence.projectFiles).
@Suite("claude and .env")
struct ClaudeDotEnvProbeTests {
  static func find(_ name: String) -> String? {
    let path = (ProcessInfo.processInfo.environment["PATH"] ?? "") + ":" + NSHomeDirectory() + "/.local/bin:/opt/homebrew/bin:/usr/local/bin"
    for d in path.split(separator: ":") where FileManager.default.isExecutableFile(atPath: "\(d)/\(name)") { return "\(d)/\(name)" }
    return nil
  }
  static let claude = find("claude")
  static let bun = find("bun")
  static let hole: off_t = 320 * 1024 * 1024

  /// Peak memory in bytes of `argv` run in `dir` with an empty home (`/usr/bin/time -l`).
  func peak(_ argv: [String], in dir: String, home: String) throws -> Int {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/time")
    p.arguments = ["-l"] + argv
    p.currentDirectoryURL = URL(fileURLWithPath: dir)
    p.environment = ["HOME": home, "PATH": "/usr/bin:/bin", "TMPDIR": home]
    let err = Pipe()
    p.standardError = err
    p.standardOutput = FileHandle.nullDevice
    try p.run()
    let data = err.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let text = String(decoding: data, as: UTF8.self)
    let line = try #require(text.split(separator: "\n").first { $0.contains("maximum resident set size") }, "\(text)")
    return Int(line.split(separator: " ").first.map(String.init) ?? "") ?? 0
  }

  @Test(.enabled(if: claude != nil && bun != nil))
  func claudeDoesNotLoadTheFoldersDotEnvAtStartWhileBunDoes() throws {
    let root = try TestTemp.real(TestTemp.base) + "/talos-dotenv-\(UUID().uuidString.prefix(8))"
    let dir = root + "/folder", home = root + "/home"
    for d in [dir, home] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
    defer { try? FileManager.default.removeItem(atPath: root) }
    let fd = open(dir + "/.env", O_WRONLY | O_CREAT | O_EXCL, 0o600)
    #expect(fd >= 0)
    _ = "A=1\n".withCString { write(fd, $0, 4) }
    lseek(fd, Self.hole, SEEK_SET)
    _ = "\nB=2\n".withCString { write(fd, $0, 5) }
    close(fd)
    let mb = 1024 * 1024
    // the control: a runtime that loads the file holds it
    let bunPeak = try peak([Self.bun!, "-e", "process.env.B"], in: dir, home: home)
    #expect(bunPeak > Int(Self.hole), "the probe cannot see a .env load: bun peaked at \(bunPeak / mb) MB")
    let claudePeak = try peak([Self.claude!, "--help"], in: dir, home: home)
    let baseline = try peak([Self.claude!, "--help"], in: home, home: home)
    #expect(claudePeak < baseline + 64 * mb, "claude --help peaked at \(claudePeak / mb) MB with the .env, \(baseline / mb) MB without")
  }
}
