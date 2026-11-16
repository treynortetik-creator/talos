import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

@Suite("Launch file")
struct LaunchFileTests {
  private func tempDir() throws -> String {
    let d = (TestTemp.base as NSString).appendingPathComponent("talos-lf-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
  }

  @Test func theScriptRemovesItselfExportsWithBuiltinsAndExecsTheQuotedArgv() throws {
    let text = try LaunchFile.script(argv: ["/a b/claude", "it's", "$HOME"], env: ["B": "two\nlines", "A": "it's", "TERM": "dumb"])
    #expect(
      text == """
        rm -f -- "$0"
        export A='it'\\''s'
        export B='two
        lines'
        export TERM='dumb'
        exec '/a b/claude' 'it'\\''s' '$HOME'

        """)
  }

  @Test func termIsTheTmuxDefaultWhenTheEnvHasNone() throws {
    #expect(try LaunchFile.script(argv: ["/bin/true"], env: [:]).contains("export TERM='xterm-256color'\n"))
  }

  @Test(arguments: ["BAD-NAME", "1A", "A B", "A=B", "", "NAME;", "É", "A\nB"])
  func aNameTheShellCannotExportIsRefused(name: String) {
    #expect(!LaunchFile.isValidName(name))
    #expect(throws: LaunchFile.Failure.badName(name)) { try LaunchFile.script(argv: ["/bin/true"], env: [name: "x"]) }
  }

  /// macOS `/bin/sh` holds these read-only, and `export` of one stops the script: run for real, the agent still starts.
  @Test func aVariableTheShellHoldsReadOnlyIsLeftOutAndTheAgentStillRuns() throws {
    let root = try tempDir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    let out = root + "/ran"
    let owned = ["UID", "EUID", "PPID", "SHELLOPTS", "BASH_VERSINFO", "GROUPS", "FUNCNAME", "BASH_LINENO", "BASH_SOURCE", "BASH_ARGC", "BASH_ARGV"]
    let env = Dictionary(uniqueKeysWithValues: owned.map { ($0, "x") }).merging(["KEEP": "y"]) { a, _ in a }
    let text = try LaunchFile.script(argv: ["/bin/sh", "-c", "echo \"$KEEP\" > '\(out)'"], env: env)
    for k in owned { #expect(!text.contains("export \(k)=")) }
    let path = root + "/launch/ro.sh"
    try LaunchFile.create(at: path, script: text)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = Array(LaunchFile.tmuxArgv(path).dropFirst())
    try p.run()
    p.waitUntilExit()
    #expect(p.terminationStatus == 0)
    #expect((try? String(contentsOfFile: out, encoding: .utf8)) == "y\n")
  }

  @Test(arguments: ["A", "_", "_x9", "PATH", "lower_case"])
  func aPlainNameIsAccepted(name: String) { #expect(LaunchFile.isValidName(name)) }

  @Test func aProgramNamedLikeAnOptionOrANulIsRefused() {
    #expect(throws: LaunchFile.Failure.self) { try LaunchFile.script(argv: ["-x"], env: [:]) }
    #expect(throws: LaunchFile.Failure.self) { try LaunchFile.script(argv: [""], env: [:]) }
    #expect(throws: LaunchFile.Failure.self) { try LaunchFile.script(argv: ["/bin/true", "a\0b"], env: [:]) }
    #expect(throws: LaunchFile.Failure.self) { try LaunchFile.script(argv: ["/bin/true"], env: ["A": "a\0b"]) }
  }

  @Test func aStaleFileOfThisSessionGoesAndNoOtherDoes() throws {
    let root = try tempDir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    let mine = LaunchFile.newPath(in: root, session: "t-a")
    let stale = LaunchFile.newPath(in: root, session: "t-a")
    let other = LaunchFile.newPath(in: root, session: "t-a-b")
    let odd = root + "/launch-t-a-notmine.sh"
    for p in [mine, stale, other, odd] { FileManager.default.createFile(atPath: p, contents: Data()) }
    #expect((mine as NSString).lastPathComponent.range(of: "^launch-t-a-[0-9a-f]{16}\\.sh$", options: .regularExpression) != nil)
    LaunchFile.removeStale(in: root, session: "t-a", except: mine)
    let left = Set((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? [])
    #expect(left == Set([mine, other, odd].map { ($0 as NSString).lastPathComponent }))
  }

  @Test func theTmuxServerGetsOnlyThePlainBasics() {
    let env = ["PATH": "/bin", "HOME": "/home/alex", "LC_ALL": "C", "TERM": "xterm", "SECRET_TOKEN": "x", "TERM_PROGRAM": "y"]
    #expect(LaunchFile.serverBasics(env) == ["PATH": "/bin", "HOME": "/home/alex", "LC_ALL": "C", "TERM": "xterm"])
  }

  @Test func tmuxIsHandedOnlyTheShellAndTheFile() {
    #expect(LaunchFile.tmuxArgv("/home/alex/t/launch/x.sh") == ["/usr/bin/env", "-i", "/bin/sh", "/home/alex/t/launch/x.sh"])
  }

  @Test func theFileIsNewAndPrivateInAPrivateFolder() throws {
    let root = try tempDir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    let dir = root + "/launch"
    let path = dir + "/one.sh"
    try LaunchFile.create(at: path, script: "echo one\n")
    var st = stat()
    #expect(stat(path, &st) == 0 && st.st_mode & 0o777 == 0o600)
    #expect(stat(dir, &st) == 0 && st.st_mode & 0o777 == 0o700)
    // never over an existing file (O_EXCL), and the one there is left as it was
    #expect(throws: LaunchFile.Failure.self) { try LaunchFile.create(at: path, script: "echo two\n") }
    #expect((try? String(contentsOfFile: path, encoding: .utf8)) == "echo one\n")
    // a folder someone made wider is narrowed back
    chmod(dir, 0o755)
    try LaunchFile.create(at: dir + "/two.sh", script: "x\n")
    #expect(stat(dir, &st) == 0 && st.st_mode & 0o777 == 0o700)
  }

  @Test func aFolderThatIsASymlinkIsRefused() throws {
    let root = try tempDir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    try FileManager.default.createDirectory(atPath: root + "/elsewhere", withIntermediateDirectories: true)
    symlink(root + "/elsewhere", root + "/launch")
    #expect(throws: LaunchFile.Failure.self) { try LaunchFile.create(at: root + "/launch/x.sh", script: "x\n") }
    #expect((try? FileManager.default.contentsOfDirectory(atPath: root + "/elsewhere")) == [])
  }

  /// Run for real with `env -i /bin/sh`: the program gets exactly its argv and the exported env, and the file is gone.
  @Test func runByTheShellTheAgentGetsItsArgvAndEnvExactly() throws {
    let root = try tempDir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    let out = root + "/out"
    let prog = root + "/p $x 'q' `b`"
    try "#!/bin/sh\n{ printf '%s\\n' \"$0\" \"$@\"; /usr/bin/env; } > '\(out)'\n"
      .write(toFile: prog, atomically: true, encoding: .utf8)
    chmod(prog, 0o755)
    let path = root + "/launch/run.sh"
    let env = ["PATH": "/usr/bin:/bin", "V": "a'b $c `d`\ne"]
    try LaunchFile.create(at: path, script: LaunchFile.script(argv: [prog, "x y", "$HOME"], env: env))
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = Array(LaunchFile.tmuxArgv(path).dropFirst())
    try p.run()
    p.waitUntilExit()
    let got = (try? String(contentsOfFile: out, encoding: .utf8)) ?? ""
    #expect(got.hasPrefix("\(prog)\nx y\n$HOME\n"), "\(got)")
    #expect(got.contains("V=a'b $c `d`\ne\n"))
    #expect(got.contains("TERM=xterm-256color\n"))
    #expect(!got.contains("HOME="), "env -i: nothing but what the file exports")
    #expect(!FileManager.default.fileExists(atPath: path))
  }
}
