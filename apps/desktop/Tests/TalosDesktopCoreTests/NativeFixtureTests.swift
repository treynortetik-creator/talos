import Foundation
import JavaScriptCore
import Testing
@testable import TalosDesktopCore

/// Swift decodes every fixture the TypeScript schemas produce (packages/protocol/fixtures/native/messages.json) and
/// refuses what they refuse (scripts/native-fixtures.ts MUST_REJECT).
private func fixtures() throws -> [String: Any] {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<5 { url.deleteLastPathComponent() }
  url.append(path: "packages/protocol/fixtures/native/messages.json")
  let data = try Data(contentsOf: url)
  return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Suite("Native fixtures")
struct NativeFixtureTests {
  @Test func shellApiIsOne() throws {
    #expect(JSONValue.int(try fixtures()["shell_api"]) == 1)
  }

  @Test func everyWebToNativeSampleDecodes() throws {
    let w = try #require(try fixtures()["web_to_native"] as? [String: Any])
    #expect(
      Set(w.keys) == [
        "ready", "notify", "badge", "open_external", "haptic", "threads", "pair_status", "companion_state", "companion_reply",
        "terminal_view",
      ])
    for (type, entry) in w {
      let sample = try #require((entry as? [String: Any])?["sample"])
      #expect(WebToNative.decode(sample) != nil, "web_to_native/\(type) sample did not decode")
    }
  }

  @Test func nativeToWebMessagesMatchTheSamplesShape() throws {
    let n = try #require(try fixtures()["native_to_web"] as? [String: Any])
    #expect(Set(n.keys) == ["navigate", "compose", "voice_note", "enroll_code", "companion_reply_request", "notify_permission"])
    let cases: [(String, NativeToWeb)] = [
      ("compose", .compose(threadId: "general", text: "Hello from the shell.")),
      ("navigate", .navigate(path: "/t/general")),
      ("enroll_code", .enrollCode("0123456789ABCDEFGHJKMNPQRS")),
      ("companion_reply_request", .companionReplyRequest(req: "r12", threadId: "general")),
      ("notify_permission", .notifyPermission(.granted)),
    ]
    for (type, msg) in cases {
      let sample = try #require(((n[type] as? [String: Any])?["sample"]) as? [String: Any])
      let ours = msg.object
      #expect(Set(ours.keys) == Set(sample.keys), "\(type) fields differ from the fixture")
      for (k, v) in sample { #expect("\(ours[k] ?? "")" == "\(v)", "\(type).\(k)") }
      #expect(NativeToWeb.validated(msg) == msg)
    }
  }

  @Test func theTypeScriptMustRejectListIsRejected() {
    let bad: [[String: Any]] = [
      ["type": "open_external", "url": "javascript:alert(1)"],
      ["type": "open_external", "url": "file:///etc/passwd"],
      ["type": "notify", "title": "T", "body": "b", "navigate": "https://evil.example.net"],
      ["type": "notify", "title": "T", "body": "b", "navigate": "/\\evil.example"],
      ["type": "notify", "title": "T", "body": "b", "navigate": "/\t/evil.example"],
      ["type": "badge", "count": 1, "extra": true],
      ["type": "eval", "js": "1"],
    ]
    for m in bad { #expect(WebToNative.decode(m) == nil, "\(m) must be refused") }
  }

  /// The two `companion_state` entries of scripts/native-fixtures.ts MUST_REJECT. They are not on the list above because a bad
  /// `companion_state` is not "unknown": it decodes to `.companionInvalid`, which clears the feed (never nil, never the old feed).
  @Test func theCompanionMustRejectCasesAreInvalidNotNil() throws {
    let w = try #require(try fixtures()["web_to_native"] as? [String: Any])
    let sample = try #require(((w["companion_state"] as? [String: Any])?["sample"]) as? [String: Any])
    #expect(WebToNative.decode(sample) != nil)
    var withText = sample
    withText["text"] = "a thread name or a reply"
    #expect(WebToNative.decode(withText) == .companionInvalid)
    var negative = sample
    negative["needs"] = -1
    #expect(WebToNative.decode(negative) == .companionInvalid)
  }

  @Test func theCompanionFixtureSampleDecodesToTheDocumentedFeed() throws {
    let w = try #require(try fixtures()["web_to_native"] as? [String: Any])
    let sample = try #require(((w["companion_state"] as? [String: Any])?["sample"]) as? [String: Any])
    #expect(
      WebToNative.decode(sample)
        == .companionState(
          CompanionFeed(
            link: .online, macOnline: true, busy: false, needs: 1, working: 2, queued: 0, onCall: 0, unread: 3, failed: 0,
            rows: [.init(threadId: "general", state: .needsYou), .init(threadId: "daily", state: .working)],
            lastReply: .init(threadId: "general", seq: 48123))))
    let reply = try #require(((w["companion_reply"] as? [String: Any])?["sample"]) as? [String: Any])
    #expect(
      WebToNative.decode(reply)
        == .companionReply(CompanionReply(req: "r12", threadId: "general", text: "Plain text here.", truncated: true)))
  }

  @Test func theTerminalViewFixtureSampleDecodes() throws {
    let w = try #require(try fixtures()["web_to_native"] as? [String: Any])
    let sample = try #require(((w["terminal_view"] as? [String: Any])?["sample"]) as? [String: Any])
    #expect(WebToNative.decode(sample) == .terminalView(TerminalViewRect(x: 240, y: 0, width: 880, height: 780)))
  }

  @Test func strictTypesAndRanges() {
    #expect(WebToNative.decode(["type": "badge", "count": 2.5]) == nil)
    #expect(WebToNative.decode(["type": "badge", "count": true]) == nil)
    #expect(WebToNative.decode(["type": "badge", "count": -1]) == nil)
    #expect(WebToNative.decode(["type": "badge", "count": 100_000]) == nil)
    #expect(WebToNative.decode(["type": "badge", "count": 0]) == .badge(0))
    #expect(WebToNative.decode(["type": "ready", "shell_api": 2, "features": [], "signed_in": false]) == nil)
    #expect(WebToNative.decode(["type": "ready", "shell_api": 1, "features": [], "signed_in": 1]) == nil)
    #expect(WebToNative.decode(["type": "ready", "shell_api": 1, "features": [""], "signed_in": true]) == nil)
    #expect(WebToNative.decode(["type": "haptic", "kind": "buzz"]) == nil)
    #expect(WebToNative.decode(["type": "pair_status", "state": "done"]) == nil)
    #expect(WebToNative.decode("not an object") == nil)
    #expect(WebToNative.decode(["no": "type"]) == nil)
  }

  @Test func anOverLongNotifyIsRefused() {
    let long = String(repeating: "a", count: 2001)
    #expect(WebToNative.decode(["type": "notify", "title": "T", "body": long, "navigate": "/t/general"]) == nil)
    #expect(WebToNative.decode(["type": "notify", "title": String(repeating: "t", count: 201), "body": "b", "navigate": "/"]) == nil)
    #expect(WebToNative.decode(["type": "notify", "title": "T", "body": "b", "navigate": "/", "tag": ""]) == nil)
    #expect(WebToNative.decode(["type": "notify", "title": "T", "body": String(repeating: "b", count: 2000), "navigate": "/"]) != nil)
  }

  @Test func threadsAreValidated() {
    let ok: [String: Any] = ["type": "threads", "items": [["id": "general", "name": "General"]]]
    #expect(WebToNative.decode(ok) == .threads([.init(id: "general", name: "General")]))
    #expect(WebToNative.decode(["type": "threads", "items": [["id": "All", "name": "x"]]]) == nil)
    #expect(WebToNative.decode(["type": "threads", "items": [["id": "all", "name": "x"]]]) == nil)
    #expect(WebToNative.decode(["type": "threads", "items": [["id": "a", "name": ""]]]) == nil)
    #expect(WebToNative.decode(["type": "threads", "items": [["id": "a", "name": "x", "extra": 1]]]) == nil)
  }

  @Test func appPathRules() {
    for good in ["/", "/t/general", "/card/c_01ABC", "/settings/health", "/search?q=a%20b#x"] {
      #expect(AppPath.isValid(good), "\(good)")
    }
    for bad in ["", "t/x", "//evil.example", "https://evil.example", "/media/x", "/MEDIA/x", "/%6dedia/x", "/%256dedia/x", "/api/x",
      "/ws", "/bridge/x", "/hook/x", "/a/../media/x", "/a/%2e%2e/media", "/\\evil.com", "/ x", "/\u{1}", "/a\u{7f}b",
      "/" + String(repeating: "a", count: 600)]
    {
      #expect(!AppPath.isValid(bad), "\(bad)")
    }
  }

  @Test func externalUrls() {
    #expect(ExternalURL.parse("https://example.com/a") != nil)
    #expect(ExternalURL.parse("http://example.com") != nil)
    #expect(ExternalURL.parse("mailto:a@example.com") != nil)
    for bad in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "talos://x", "https://", "ftp://x.com", ""] {
      #expect(ExternalURL.parse(bad) == nil, "\(bad)")
    }
  }

  @Test func theJavascriptLineIsASingleStringLiteral() throws {
    let nasty = "hi\"); alert(1); (\"\n\u{2028}</script>"
    let js = try #require(NativeToWeb.compose(threadId: "general", text: nasty).javascript())
    #expect(js.hasPrefix("window.talosNative && window.talosNative.receive(\""))
    #expect(js.hasSuffix("\")"))
    #expect(!js.contains("\n"))
    // The argument round-trips to exactly the validated JSON message.
    let arg = String(js.dropFirst("window.talosNative && window.talosNative.receive(".count).dropLast())
    let decoded = try #require(try JSONSerialization.jsonObject(with: Data(arg.utf8), options: [.fragmentsAllowed]) as? String)
    let obj = try #require(try JSONSerialization.jsonObject(with: Data(decoded.utf8)) as? [String: Any])
    #expect(obj["text"] as? String == nasty)
  }

  /// Runs the acknowledged script body against a page that has the given doors. Each door records its name and the raw message.
  private func runAcknowledged(_ m: NativeToWeb, doors: [String]) throws -> (result: JSValue, calls: [String]) {
    let ctx = try #require(JSContext())
    let body = try #require(m.acknowledgedJavascript())
    ctx.evaluateScript("var calls = []; var window = {}; window.talosNative = {};")
    for d in doors { ctx.evaluateScript("window.talosNative.\(d) = function (raw) { calls.push('\(d)'); calls.push(raw); return 'from \(d)' };") }
    if doors.isEmpty { ctx.evaluateScript("window.talosNative = undefined;") }
    let result = try #require(ctx.evaluateScript("(function () { \(body) })()"))
    let calls = try #require(ctx.evaluateScript("calls")?.toArray() as? [String])
    return (result, calls)
  }

  @Test func theAcknowledgedScriptUsesTheNewDoorWhenThePageHasItAndTheOldDoorOtherwise() throws {
    let m = NativeToWeb.compose(threadId: "work", text: "hi \"there\"\n")
    let both = try runAcknowledged(m, doors: ["receive", "receiveAck"])
    #expect(both.calls.first == "receiveAck" && both.calls.count == 2, "a newer page is asked through receiveAck only")
    #expect(both.result.toString() == "from receiveAck")
    let old = try runAcknowledged(m, doors: ["receive"])
    #expect(old.calls.first == "receive" && old.calls.count == 2, "an older page has only receive")
    #expect(old.result.toString() == "from receive")
    let none = try runAcknowledged(m, doors: [])
    #expect(none.result.isUndefined, "no receiver at all answers nothing")
    // The message reaches either door as exactly the validated JSON.
    let raw = try #require(both.calls.last)
    let obj = try #require(try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    #expect(obj["text"] as? String == "hi \"there\"\n" && obj["thread_id"] as? String == "work")
    #expect(NativeToWeb.compose(threadId: "All", text: "x").acknowledgedJavascript() == nil)
  }

  @Test func invalidOutgoingMessagesProduceNothing() {
    #expect(NativeToWeb.compose(threadId: "All", text: "x").javascript() == nil)
    #expect(NativeToWeb.compose(threadId: "general", text: "").javascript() == nil)
    #expect(NativeToWeb.navigate(path: "/media/x").javascript() == nil)
    #expect(NativeToWeb.enrollCode("short").javascript() == nil)
  }

  @Test func enrollCodeNormalization() {
    #expect(EnrollCode.normalize("0123456789abcdefghjkmnpqrs") == "0123456789ABCDEFGHJKMNPQRS")
    #expect(EnrollCode.normalize("OIl123456789ABCDEFGHJKMNPQ") == "0111234567" + "89ABCDEFGHJKMNPQ")
    #expect(EnrollCode.normalize("ZZZZZZZZZZZZZZZZZZZZZZZZZZ") == nil)  // top bits
    #expect(EnrollCode.normalize("0123") == nil)
  }
}
