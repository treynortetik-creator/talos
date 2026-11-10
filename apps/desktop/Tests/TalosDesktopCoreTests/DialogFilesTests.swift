import CryptoKit
import Foundation
import Testing
@testable import TalosDesktopCore

/// Needs-you prompts: the files between the Mac and the bridge. `workers.json` carries the offered dialog; the bridge's answer
/// (`dialog-answer.json`, v2, with the owner's signed proof) is read with the hardening of `agent-request.json`; the Mac's result and the
/// bridge's card file are small fixed shapes. The golden files are part A2's (packages/protocol/fixtures/needs-you).
enum A2Fixtures {
  /// The protocol's own fixtures (packages/protocol/fixtures/needs-you): the bridge's side of the contract, as part A2 wrote them.
  static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/protocol/fixtures/needs-you")
  static func data(_ name: String) throws -> Data { try Data(contentsOf: dir.appendingPathComponent(name + ".json")) }
  static func object(_ name: String) throws -> [String: Any] { try #require(JSONSerialization.jsonObject(with: data(name)) as? [String: Any]) }
  static func answer(_ name: String) throws -> DialogAnswerRequest? { DialogAnswerRequest.parse(try data(name)) }
  /// The fixture with some top-level fields replaced or (nil) removed.
  static func edited(_ name: String, _ change: (inout [String: Any]) -> Void) throws -> Data {
    var o = try object(name)
    change(&o)
    return try JSONSerialization.data(withJSONObject: o)
  }
  /// The ten-fifty-nine-ish moment after the tap in the fixtures: the Mac's clock.
  static let nowMs = ISOTime.parse("2026-11-07T10:00:30.000Z")! * 1000
}

@Suite("Dialog files")
struct DialogFilesTests {
  static func tmp() throws -> String {
    let d = (NSTemporaryDirectory() as NSString).appendingPathComponent("dlgfiles-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
  }

  // MARK: workers.json

  @Test func theOfferRoundTripsAndWritesExplicitNulls() throws {
    let offer = DialogOffer(
      id: "k3Xv9QpT2mLw8ZrNa5HdBe", kind: .mcpConsent, subject: nil, options: ["a", "b"], cursor: nil,
      seen_at: "2026-11-07T12:00:00.000Z", expires_at: "2026-11-07T12:15:00.000Z")
    var e = WorkersFile.Entry(threadId: "trip", cwd: "/tmp")
    e.dialog = offer
    let f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-07T12:00:00.000Z", workers_supported: true, main_pane_pid: 0), threads: ["trip": e])
    let json = String(decoding: try f.encoded(), as: UTF8.self)
    #expect(json.contains("\"kind\" : \"mcp_consent\""), "\(json)")
    #expect(json.contains("\"subject\" : null") && json.contains("\"cursor\" : null"), "explicit nulls: \(json)")
    let back = try #require(WorkersFile.decode(Data(json.utf8)))
    #expect(back.threads["trip"]?.dialog == offer)
  }

  @Test func noDialogMeansNoKeyAndAnUnreadableOneIsNoDialogNotAnUnreadableFile() throws {
    let e = WorkersFile.Entry(threadId: "trip", cwd: "/tmp")
    let f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-07T12:00:00.000Z", workers_supported: true, main_pane_pid: 0), threads: ["trip": e])
    let json = String(decoding: try f.encoded(), as: UTF8.self)
    #expect(!json.contains("dialog"), "the file of every earlier build")
    let bad = json.replacingOccurrences(of: "\"cwd\"", with: "\"dialog\" : {\"id\": 7}, \"cwd\"")
    #expect(bad.contains("\"dialog\""), "control")
    let back = try #require(WorkersFile.decode(Data(bad.utf8)), "an odd dialog must not make the whole file unreadable")
    #expect(back.threads["trip"]?.dialog == nil)
  }

  /// The bridge's own golden `workers.json` with dialogs in it reads, in every state and kind.
  @Test func theBridgesGoldenWorkersFileReads() throws {
    let f = try #require(WorkersFile.decode(try A2Fixtures.data("workers-with-dialog")))
    let trip = try #require(f.threads["trip"]?.dialog)
    #expect(trip.kind == .trust && trip.subject == "/home/alex/trip" && trip.options == ["No, exit", "Yes, I trust this folder"] && trip.cursor == 1)
    #expect(f.threads["garden"]?.dialog?.kind == .mcpConsent && f.threads["garden"]?.dialog?.options.count == 3)
    let login = try #require(f.threads["inbox2"]?.dialog)
    #expect(login.kind == .login && login.subject == nil && login.options.isEmpty && login.cursor == nil)
    #expect(ISOTime.parse(trip.expires_at)! - ISOTime.parse(trip.seen_at)! == 900)
  }

  /// A `dialog` read back from workers.json is checked like anything else read from disk: an agent can edit that file while the app is down.
  @Test func aDialogOnDiskThatDoesNotFitIsNoDialog() throws {
    let good = try #require(WorkersFile.decode(try A2Fixtures.data("workers-with-dialog")))
    let json = try #require(String(data: try A2Fixtures.data("workers-with-dialog"), encoding: .utf8))
    func decoded(_ change: (inout [String: Any]) -> Void) throws -> DialogOffer? {
      var root = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
      var threads = try #require(root["threads"] as? [String: Any])
      var trip = try #require(threads["trip"] as? [String: Any])
      var dlg = try #require(trip["dialog"] as? [String: Any])
      change(&dlg)
      trip["dialog"] = dlg
      threads["trip"] = trip
      root["threads"] = threads
      let f = try #require(WorkersFile.decode(try JSONSerialization.data(withJSONObject: root)), "the rest of the file must still read")
      #expect(f.threads["garden"]?.dialog != nil, "the other threads' dialogs are untouched")
      return f.threads["trip"]?.dialog
    }
    #expect(good.threads["trip"]?.dialog != nil)
    #expect(try decoded { _ in } != nil, "control")
    #expect(try decoded { $0["id"] = "short" } == nil)
    #expect(try decoded { $0["id"] = "has a space in it, 22 chars+" } == nil)
    #expect(try decoded { $0["options"] = ["a", "b", "c", "d", "e", "f", "g"] } == nil)
    #expect(try decoded { $0["options"] = [] } == nil, "a trust dialog has options")
    #expect(try decoded { $0["options"] = ["No, exit", String(repeating: "x", count: 121)] } == nil)
    #expect(try decoded { $0["options"] = ["No, exit", ""] } == nil)
    #expect(try decoded { $0["subject"] = String(repeating: "x", count: 501) } == nil)
    #expect(try decoded { $0["cursor"] = 2 } == nil, "a cursor past the options")
    #expect(try decoded { $0["cursor"] = -1 } == nil)
    #expect(try decoded { $0["seen_at"] = "yesterday" } == nil)
    #expect(try decoded { $0["expires_at"] = "tomorrow" } == nil)
    #expect(try decoded { $0["kind"] = "login" } == nil, "a login dialog has no options")
  }

  @Test func aNewIdIsSixteenRandomBytesAsBase64Url() {
    let ids = (0..<200).map { _ in DialogOffer.newId() }
    #expect(Set(ids).count == 200)
    for id in ids { #expect(id.count == 22 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }, "\(id)") }
  }

  // MARK: the answer

  @Test func theGoldenAnswersParse() throws {
    let c = try #require(try A2Fixtures.answer("dialog-answer"))
    #expect(c.dialogId == "k3Xv9QpT2mLw8ZrNa5HdBe" && c.action == .choose(1) && c.label == "Yes, I trust this folder")
    #expect(c.by == "Alex's iPhone" && c.controlId == "dc_01M6V2TGWJCH4P49F79Q2317CD")
    #expect(c.at == ISOTime.parse("2026-11-07T10:00:09.000Z")! * 1000)
    #expect(c.proof.deviceId == "d_rjxnk4xufxem5xago5zd" && c.proof.osig.count == 86 && c.proof.signed.contains("\"type\":\"card.resolve\""))
    let o = try #require(try A2Fixtures.answer("dialog-answer-open"))
    #expect(o.action == .open && o.label == "Open on the Mac")
  }

  @Test func everyTamperedGoldenStillParsesExceptTheOneWithNoProof() throws {
    for name in try FileManager.default.contentsOfDirectory(atPath: A2Fixtures.dir.path).filter({ $0.hasPrefix("dialog-answer-") }).sorted() {
      let n = String(name.dropLast(5))
      #expect((try A2Fixtures.answer(n) == nil) == (n == "dialog-answer-missing-proof"), "\(n)")
    }
  }

  @Test func anythingThatIsNotExactlyAnAnswerIsNot() throws {
    func parse(_ c: (inout [String: Any]) -> Void) throws -> DialogAnswerRequest? { DialogAnswerRequest.parse(try A2Fixtures.edited("dialog-answer", c)) }
    #expect(try parse { _ in } != nil, "control")
    #expect(try parse { $0["v"] = 1 } == nil, "the version is 2")
    #expect(try parse { $0["v"] = nil } == nil)
    #expect(try parse { $0["extra"] = "x" } == nil, "strict: no field of ours is missing, none is added")
    #expect(try parse { $0["action"] = "open" } == nil, "a choice and an open together")
    #expect(try parse { $0["choice"] = nil } == nil, "neither")
    for bad: Any in [true, -1, 1.5, "1", NSNull(), 6] { #expect(try parse { $0["choice"] = bad } == nil, "choice \(bad)") }
    for bad in ["", "a b", "x;y", "../x", String(repeating: "a", count: 65), "é"] {
      #expect(try parse { $0["control_id"] = bad } == nil, "control_id \(bad)")
      #expect(try parse { $0["dialog_id"] = bad } == nil, "dialog_id \(bad)")
    }
    #expect(try parse { $0["dialog_id"] = "short" } == nil, "a dialog id is at least 22 characters")
    #expect(try parse { $0["label"] = String(repeating: "x", count: 121) } == nil)
    #expect(try parse { $0["label"] = "" } == nil)
    #expect(try parse { $0["label"] = 7 } == nil)
    #expect(try parse { $0["by"] = String(repeating: "b", count: 61) } == nil)
    #expect(try parse { $0["at"] = "yesterday" } == nil)
    #expect(try parse { $0["at"] = 1_800_000_000_000 } == nil, "the time is an ISO string")
    #expect(try parse { $0["at"] = nil } == nil)
    #expect(try parse { $0["proof"] = nil } == nil)
    #expect(try parse { $0["proof"] = "x" } == nil)
    for field in ["signed", "osig", "device_id", "binding"] {
      #expect(try parse { var p = $0["proof"] as! [String: Any]; p[field] = nil; $0["proof"] = p } == nil, "no proof.\(field)")
    }
    #expect(try parse { var p = $0["proof"] as! [String: Any]; p["osig"] = "short"; $0["proof"] = p } == nil)
    #expect(try parse { var p = $0["proof"] as! [String: Any]; p["device_id"] = "d_UPPER"; $0["proof"] = p } == nil)
    #expect(try parse { var p = $0["proof"] as! [String: Any]; p["extra"] = 1; $0["proof"] = p } == nil)
    #expect(DialogAnswerRequest.parse(Data("[]".utf8)) == nil)
    #expect(DialogAnswerRequest.parse(Data("not json".utf8)) == nil)
  }

  @Test func anAnswerOlderThanFiveMinutesOrFromTheFutureIsStale() throws {
    let a = try #require(try A2Fixtures.answer("dialog-answer"))
    #expect(!a.isStale(nowMs: a.at + 299_000))
    #expect(a.isStale(nowMs: a.at + 301_000))
    #expect(!a.isStale(nowMs: a.at - 59_000))
    #expect(a.isStale(nowMs: a.at - 61_000))
  }

  @Test func theFileIsReadWithTheSameHardeningAsAnAgentRequest() throws {
    let d = try Self.tmp()
    defer { try? FileManager.default.removeItem(atPath: d) }
    let p = d + "/dialog-answer.json"
    #expect(DialogAnswerFile.read(path: p) == .absent)
    try A2Fixtures.data("dialog-answer").write(to: URL(fileURLWithPath: p))
    guard case .answer(let a) = DialogAnswerFile.read(path: p) else { Issue.record("not read"); return }
    #expect(a.controlId == "dc_01M6V2TGWJCH4P49F79Q2317CD")
    try Data("junk".utf8).write(to: URL(fileURLWithPath: p))
    #expect(DialogAnswerFile.read(path: p) == .invalid)
    // too big: never read whole
    try Data(repeating: 0x20, count: DialogAnswerRequest.maxBytes + 1).write(to: URL(fileURLWithPath: p))
    #expect(DialogAnswerFile.read(path: p) == .invalid)
    // a link (even to a good file) and a folder are not an answer
    let good = d + "/good.json"
    try A2Fixtures.data("dialog-answer").write(to: URL(fileURLWithPath: good))
    unlink(p)
    try FileManager.default.createSymbolicLink(atPath: p, withDestinationPath: good)
    #expect(DialogAnswerFile.read(path: p) == .invalid)
    unlink(p)
    try FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
    #expect(DialogAnswerFile.read(path: p) == .invalid)
  }

  @Test func aFolderThatIsALinkIsNotARealFolder() throws {
    let d = try Self.tmp()
    defer { try? FileManager.default.removeItem(atPath: d) }
    try FileManager.default.createDirectory(atPath: d + "/real", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: d + "/link", withDestinationPath: d + "/real")
    try Data().write(to: URL(fileURLWithPath: d + "/file"))
    #expect(SafePath.isRealFolder(d + "/real"))
    #expect(!SafePath.isRealFolder(d + "/link"))
    #expect(!SafePath.isRealFolder(d + "/file"))
    #expect(!SafePath.isRealFolder(d + "/missing"))
  }

  // MARK: the result and the card file

  @Test func aCardResultHasExactlyTheContractFields() throws {
    func obj(_ d: Data) throws -> [String: Any] { try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any]) }
    let at = ISOTime.parse("2026-11-07T10:00:10.000Z")!
    let pressed = try obj(DialogResult.encode(dialogId: "k3Xv9QpT2mLw8ZrNa5HdBe", controlId: "dc_01M6V2TGWJCH4P49F79Q2317CD", outcome: .pressed, choice: 1, label: "Yes, I trust this folder", at: at))
    let wantPressed = try A2Fixtures.object("dialog-result")
    #expect(pressed as NSDictionary == wantPressed as NSDictionary)
    let unverified = try obj(DialogResult.encode(dialogId: "k3Xv9QpT2mLw8ZrNa5HdBe", controlId: "dc_01M6V2TGWJCH4P49F79Q2317CD", outcome: .nothingPressed, reason: .unverified, at: at))
    let wantUnverified = try A2Fixtures.object("dialog-result-unverified")
    #expect(unverified as NSDictionary == wantUnverified as NSDictionary)
    let opened = try obj(DialogResult.encode(dialogId: "Hc4Pq9ZtLm2Xw7RvNa5KdB", controlId: "dc_1", outcome: .opened, label: "Open on the Mac", at: at))
    #expect(opened["outcome"] as? String == "opened" && opened["source"] as? String == "card" && opened["v"] as? Int == 1)
    #expect(DialogResult.Reason.screenChanged.rawValue == "screen_changed" && DialogResult.Reason.alreadyAnswered.rawValue == "already_answered")
  }

  @Test func theLastResultsControlIdCanBeReadBack() throws {
    let dir = try Self.tmp()
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/dialog-result.json"
    #expect(DialogResult.controlId(path: path) == nil)
    try DialogResult.encode(dialogId: "k3Xv9QpT2mLw8ZrNa5HdBe", controlId: "dc_9", outcome: .opened, label: "x", at: 1).write(to: URL(fileURLWithPath: path))
    #expect(DialogResult.controlId(path: path) == "dc_9")
  }

  @Test func aCardFileNamesTheDialogItIsForInAnyStatus() throws {
    let dir = try Self.tmp()
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/dialog-card.json"
    #expect(DialogCardAck.dialogId(path: path) == nil)
    for name in ["dialog-card", "dialog-card-answered"] {
      try A2Fixtures.data(name).write(to: URL(fileURLWithPath: path))
      #expect(DialogCardAck.dialogId(path: path) == "k3Xv9QpT2mLw8ZrNa5HdBe", "\(name)")
    }
    for status in ["closed", "expired"] {
      try A2Fixtures.edited("dialog-card") { $0["status"] = status }.write(to: URL(fileURLWithPath: path))
      #expect(DialogCardAck.dialogId(path: path) == "k3Xv9QpT2mLw8ZrNa5HdBe", "\(status)")
    }
    try A2Fixtures.edited("dialog-card") { $0["status"] = "weird" }.write(to: URL(fileURLWithPath: path))
    #expect(DialogCardAck.dialogId(path: path) == nil)
    try A2Fixtures.edited("dialog-card") { $0["v"] = 2 }.write(to: URL(fileURLWithPath: path))
    #expect(DialogCardAck.dialogId(path: path) == nil)
    try A2Fixtures.edited("dialog-card") { $0["card_id"] = nil }.write(to: URL(fileURLWithPath: path))
    #expect(DialogCardAck.dialogId(path: path) == nil)
    try Data("junk".utf8).write(to: URL(fileURLWithPath: path))
    #expect(DialogCardAck.dialogId(path: path) == nil)
    unlink(path)
    try FileManager.default.createSymbolicLink(atPath: path, withDestinationPath: dir + "/elsewhere")
    #expect(DialogCardAck.dialogId(path: path) == nil)
  }

  // MARK: Main's own dialog (supervisor.main_dialog)

  /// The bridge's golden file with Main's development-channels dialog in it reads, and writes back the same way.
  @Test func mainsDialogReadsFromTheGoldenFileAndRoundTrips() throws {
    let f = try #require(WorkersFile.decode(try A2Fixtures.data("workers-with-main-dialog")))
    let d = try #require(f.supervisor.main_dialog)
    #expect(d.kind == .devChannels && d.kind.rawValue == "dev_channels")
    #expect(d.subject == "server:talos-app, server:other-thing")
    #expect(d.options == ["I am using this for local development", "Exit"] && d.cursor == 0)
    #expect(d.launch_changed == ["program", "env"])
    let back = try #require(WorkersFile.decode(try f.encoded()))
    #expect(back.supervisor.main_dialog == d)
    #expect(f.threads.isEmpty)
  }

  @Test func aFileWithoutMainsDialogKeepsNoKeyForIt() throws {
    let f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-07T10:00:00.000Z", workers_supported: true, main_pane_pid: 2))
    #expect(f.supervisor.main_dialog == nil)
    #expect(!(String(decoding: try f.encoded(), as: UTF8.self)).contains("main_dialog"))
  }

  @Test func aMainDialogOnDiskThatDoesNotFitIsNoDialogAndTheRestStillReads() throws {
    var o = try A2Fixtures.object("workers-with-main-dialog")
    var sup = try #require(o["supervisor"] as? [String: Any])
    var d = try #require(sup["main_dialog"] as? [String: Any])
    d["id"] = "short"
    sup["main_dialog"] = d
    o["supervisor"] = sup
    let f = try #require(WorkersFile.decode(try JSONSerialization.data(withJSONObject: o)))
    #expect(f.supervisor.main_dialog == nil)
    #expect(f.supervisor.pid == 4242)
    // a launch_changed piece that is not one of the four names is no dialog either (never a free-text value)
    d["id"] = "Dv5Qm8ZtRx3Cw9PkNa2HdB"
    d["launch_changed"] = ["--token=abc"]
    sup["main_dialog"] = d
    o["supervisor"] = sup
    #expect(try #require(WorkersFile.decode(try JSONSerialization.data(withJSONObject: o))).supervisor.main_dialog == nil)
  }
}
