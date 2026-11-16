import Foundation
import Testing

@testable import TalosDesktopCore
import TalosTestSupport

@Suite("Whether Claude Code has saved a conversation")
struct SessionTranscriptTests {
  static let id = "11111111-2222-4333-8444-555555555555"

  @Test func theFolderNameIsThePathWithEveryOtherCharacterAsADash() {
    #expect(SessionTranscript.projectFolderName("/home/alex/my agent_dir.v2") == "-home-alex-my-agent-dir-v2")
    #expect(SessionTranscript.projectFolderName("/home/alex/café") == "-home-alex-caf-")
    #expect(
      SessionTranscript.path(sessionId: Self.id, folder: "/home/alex/agent", claudeDir: "/home/alex/.claude")
        == "/home/alex/.claude/projects/-home-alex-agent/\(Self.id).jsonl")
  }

  @Test func savedOnlyWhenTheFileIsThereUnderTheFolderAsGivenOrAsResolved() throws {
    let fm = FileManager.default
    let made = (TestTemp.base as NSString).appendingPathComponent("talos-tr-\(UUID().uuidString.prefix(8))")
    try fm.createDirectory(atPath: made, withIntermediateDirectories: true)
    let root = PathUtil.canonical(made)  // resolved once it exists (the temp folder is itself behind a link on macOS)
    defer { try? fm.removeItem(atPath: root) }
    let (claude, agent, link) = (root + "/claude", root + "/agent", root + "/link")
    try fm.createDirectory(atPath: agent, withIntermediateDirectories: true)
    try fm.createSymbolicLink(atPath: link, withDestinationPath: agent)
    #expect(!SessionTranscript.isSaved(sessionId: Self.id, folder: agent, claudeDir: claude), "nothing saved yet")
    let file = SessionTranscript.path(sessionId: Self.id, folder: agent, claudeDir: claude)
    try fm.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    fm.createFile(atPath: file, contents: Data("{}\n".utf8))
    #expect(SessionTranscript.isSaved(sessionId: Self.id, folder: agent, claudeDir: claude))
    #expect(SessionTranscript.isSaved(sessionId: Self.id, folder: link, claudeDir: claude), "the CLI names it after the resolved folder")
    #expect(!SessionTranscript.isSaved(sessionId: "99999999-2222-4333-8444-555555555555", folder: agent, claudeDir: claude), "another id")
    #expect(SessionTranscript.isSaved(sessionId: Self.id, folder: root, claudeDir: claude), "found under any folder name: the id is the session")
    #expect(SessionTranscript.find(sessionId: Self.id, folder: agent, claudeDir: claude) == file, "the exact name first")
    #expect(!SessionTranscript.isSaved(sessionId: Self.id, folder: agent, claudeDir: root + "/other-claude"), "another config folder")
  }

  /// An id that is not a plain UUID is never turned into a path: it counts as saved, so the start resumes as before.
  @Test(arguments: ["../../etc/passwd", "", "not-a-uuid", "11111111-2222-4333-8444-555555555555/../x"])
  func anIdThatIsNotAUuidIsNeverLookedUp(id: String) {
    #expect(SessionTranscript.isSaved(sessionId: id, folder: "/home/alex/agent", claudeDir: "/home/alex/.claude"))
  }

  @Test func theEventNameIsTheLinuxSupervisorsToo() { #expect(SessionTranscript.notSavedEvent == "session_not_saved") }

  private func transcript(_ lines: [String]) throws -> (folder: String, claude: String, cleanup: () -> Void) {
    let fm = FileManager.default
    let root = (TestTemp.base as NSString).appendingPathComponent("talos-tr-\(UUID().uuidString.prefix(8))")
    let file = SessionTranscript.path(sessionId: Self.id, folder: root + "/agent", claudeDir: root + "/claude")
    try fm.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: URL(fileURLWithPath: file))
    return (root + "/agent", root + "/claude", { try? fm.removeItem(atPath: root) })
  }

  static let meta = #"{"type":"user","isMeta":true,"message":{"content":"Caveat: generated while running local commands"}}"#
  static let exitCommand = #"{"type":"user","message":{"content":"<command-name>/exit</command-name>\n<command-message>exit</command-message>"}}"#
  static let exitOutput = #"{"type":"user","message":{"content":[{"type":"text","text":"<local-command-stdout>Bye!</local-command-stdout>"}]}}"#

  /// Lines as Claude Code writes them for an /exit with nothing typed: no conversation. One real line of either side makes it one.
  @Test(arguments: [
    ([meta, exitCommand, exitOutput], true),
    ([meta, #"{"type":"summary","summary":"x"}"#, "{ half a li"], true),
    ([meta, exitCommand, #"{"type":"user","message":{"content":"hello"}}"#], false),
    ([meta, #"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#], false),
    ([#"{"type":"user","message":{"content":"<command-name>/exit</command-name> and then some words of his own"}}"#], false),
  ])
  func aFileWithOnlyMetaAndCommandLinesHoldsNoConversation(lines: [String], empty: Bool) throws {
    let t = try transcript(lines)
    defer { t.cleanup() }
    #expect(SessionTranscript.conversationEmpty(sessionId: Self.id, folder: t.folder, claudeDir: t.claude) == empty)
  }

  @Test func noFileOrAnIdThatIsNotAUuidIsNeverCalledEmpty() {
    #expect(!SessionTranscript.conversationEmpty(sessionId: Self.id, folder: "/home/alex/agent", claudeDir: "/home/alex/none"))
    #expect(!SessionTranscript.conversationEmpty(sessionId: "not-a-uuid", folder: "/home/alex/agent", claudeDir: "/home/alex/none"))
    #expect(SessionTranscript.find(sessionId: "../../x", folder: "/home/alex/agent", claudeDir: "/home/alex/none") == nil)
  }

  /// The refusal as 2.1.322 prints it, on a line of its own; a sentence that mentions it is conversation.
  @Test func theInUseRefusalIsReadOnALineOfItsOwn() {
    #expect(SessionTranscript.sessionInUse(["", " Error: Session ID \(Self.id) is already in use.", ""]))
    #expect(SessionTranscript.sessionInUse(["│ Error: Session ID \(Self.id) is already in use │"]))
    #expect(!SessionTranscript.sessionInUse([" ● It printed: Error: Session ID \(Self.id) is already in use."]))
    #expect(!SessionTranscript.sessionInUse(["Error: Session ID is already in use"]))
    #expect(!SessionTranscript.sessionInUse([]))
  }

  @Test func aFailedSaveOfTheMigrationIsReturnedNotSwallowed() throws {
    let fm = FileManager.default
    let dir = (TestTemp.base as NSString).appendingPathComponent("talos-mig-\(UUID().uuidString.prefix(8))")
    try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer {
      chmod(dir, 0o700)
      try? fm.removeItem(atPath: dir)
    }
    var c = DesktopConfig.defaults
    c.launchTrust = 0
    try ConfigFile.save(c, to: dir + "/desktop.json")
    let before = fm.contents(atPath: dir + "/desktop.json")
    let read = LaunchTrustMigration.read(dir + "/desktop.json")
    #expect(read.migrated && read.config?.launchTrust == LaunchTrustMigration.version)
    #expect(fm.contents(atPath: dir + "/desktop.json") == before, "`read` writes nothing")
    chmod(dir, 0o500)
    let failed = LaunchTrustMigration.load(dir + "/desktop.json")
    #expect(failed.migrated && (getuid() == 0 || failed.saveError != nil), "the error comes back")
    chmod(dir, 0o700)
    let ok = LaunchTrustMigration.load(dir + "/desktop.json")
    #expect(ok.migrated && ok.saveError == nil && !LaunchTrustMigration.read(dir + "/desktop.json").migrated)
  }
}

@Suite("Whether a session has had a turn")
struct SessionHadTurnTests {
  static let id = "11111111-2222-4333-8444-555555555555"

  @Test func aThreadSessionsTurnBelongsToItsId() throws {
    var e = WorkersFile.Entry(threadId: "trip", cwd: "/home/alex/agent")
    #expect(!e.hadTurn, "no session")
    e.session_id = Self.id
    #expect(!e.hadTurn, "nothing typed")
    e.last_turn_at = "2026-11-01T00:00:00.000Z"
    #expect(e.hadTurn, "an older file: the time alone says so")
    e.turn_session = "99999999-2222-4333-8444-555555555555"
    #expect(!e.hadTurn, "the turn was another conversation's")
    e.turn_session = Self.id
    #expect(e.hadTurn)
    e.retireSessionId()
    e.session_id = "22222222-2222-4333-8444-555555555555"
    #expect(!e.hadTurn && e.previous_ids == [Self.id], "a new id starts with no turn, whatever the old one had")
    // the key is written only once set, read back as written, and a value of the wrong kind reads as none (never an unreadable file)
    let data = try JSONEncoder().encode(e)
    #expect(try JSONDecoder().decode(WorkersFile.Entry.self, from: data).turn_session == Self.id)
    let plain = try JSONEncoder().encode(WorkersFile.Entry(threadId: "trip", cwd: "/home/alex/agent"))
    #expect(!String(decoding: plain, as: UTF8.self).contains("turn_session"))
    var obj = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    obj["turn_session"] = 7
    let odd = try JSONDecoder().decode(WorkersFile.Entry.self, from: try JSONSerialization.data(withJSONObject: obj))
    #expect(odd.turn_session == nil && odd.session_id == e.session_id)
  }

  @Test func mainsSeenMarkIsKeptWithTheSessionAndGoesWithIt() throws {
    var s = DesktopConfig.Session(id: Self.id)
    #expect(!String(decoding: try JSONEncoder().encode(s), as: UTF8.self).contains("conversation_seen"), "absent until set")
    s.conversationSeen = Self.id
    let back = try JSONDecoder().decode(DesktopConfig.Session.self, from: try JSONEncoder().encode(s))
    #expect(back.conversationSeen == Self.id)
    let old = try JSONDecoder().decode(DesktopConfig.Session.self, from: Data(#"{"id":"\#(Self.id)","conversation_seen":5}"#.utf8))
    #expect(old.id == Self.id && old.conversationSeen == nil, "a value of the wrong kind is no mark, never an unreadable file")
    s.retireCurrentId()
    #expect(s.conversationSeen == nil && s.previousIds == [Self.id])
  }
}
