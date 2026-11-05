import AppKit
import Foundation
import Testing
import WebKit
import TalosDesktopCore
@testable import TalosDesktop

/// The companion feed through a real WKWebView into the real decoder and `WebController` (DESKTOP-COMPANION-SPEC 7, 10).
/// Two kinds of page: the real one (the actual `attachShell`, bridge and feed from apps/web, bundled by
/// Fixtures/companion/build-harness.mjs, on a real store) and small hand-written pages that post exact messages, for the
/// cases the real page never produces (an old page, a bad frame, a frame before `ready`, a sub-frame).
/// Needs TALOS_GUI_TESTS=1 (WebKit processes) and `node` (the bundler). Neither missing is a skip: the test fails loudly.
@MainActor
@Suite("CompanionFeedGui", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct CompanionFeedGuiTests {
  let relay = RelayOrigin("https://relay.example.com")!
  static let base = URL(string: "https://relay.example.com/")!

  // MARK: rig

  struct Rig {
    let c: WebController
    let wv: WKWebView
    let got: () -> [WebToNative]
    let feeds: () -> [CompanionFeed?]
  }

  func rig() throws -> Rig {
    _ = NSApplication.shared
    let c = WebController()
    var got: [WebToNative] = []
    var feeds: [CompanionFeed?] = []
    c.testHook = { got.append($0) }
    c.onCompanionFeed = { feeds.append($0) }
    c.configure(relay: relay)
    c.prepare()
    return Rig(c: c, wv: try #require(c.webView), got: { got }, feeds: { feeds })
  }

  /// Polls until `cond` holds or `seconds` pass. Returns how long it took, or nil on timeout.
  @discardableResult
  func until(_ seconds: Double, _ cond: () -> Bool) async -> Double? {
    let start = Date()
    while Date().timeIntervalSince(start) < seconds {
      if cond() { return Date().timeIntervalSince(start) }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return cond() ? Date().timeIntervalSince(start) : nil
  }

  func pump(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) }

  /// A page that posts the given messages (JSON literals) in order, after defining `send`.
  func load(_ r: Rig, body: String, script: String) async {
    let html = "<html><body>\(body)<script>function send(m){window.webkit.messageHandlers.talos.postMessage(m)}\n\(script)</script></body></html>"
    r.wv.loadHTMLString(html, baseURL: Self.base)
    await pump(0.4)
  }

  static let readyJS = "send({type:'ready',shell_api:1,features:['notify','badge','compose','companion/1'],signed_in:true});"
  static let frameJS = """
    {type:'companion_state',link:'online',mac_online:true,busy:false,needs:1,working:2,queued:0,on_call:0,unread:3,failed:0,
     rows:[{thread_id:'general',state:'needs_you'},{thread_id:'daily',state:'working'}],last_reply:{thread_id:'general',seq:48123}}
    """

  /// The real page, bundled once per run. A missing node or a failed bundle fails the test (never a skip).
  static let harness: Result<String, HarnessError> = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<2 { url.deleteLastPathComponent() }  // .../apps/desktop/Tests
    let script = url.appending(path: "Fixtures/companion/build-harness.mjs").path
    let out = FileManager.default.temporaryDirectory.appending(path: "talos-companion-harness-\(UUID().uuidString)")
    do { try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true) } catch {
      return .failure(HarnessError("can't make a temp dir: \(error)"))
    }
    let js = out.appending(path: "harness.js")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = ["node", script, js.path]
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = (env["PATH"] ?? "") + ":/opt/homebrew/bin:/usr/local/bin"
    p.environment = env
    let err = Pipe()
    p.standardError = err
    p.standardOutput = err
    do { try p.run() } catch { return .failure(HarnessError("can't run node: \(error)")) }
    // Read to EOF first: a build that prints more than the pipe holds (about 64 KB) blocks on write, and waiting for it to
    // exit before reading would hang the run here instead of failing it.
    let log = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    p.waitUntilExit()
    guard p.terminationStatus == 0, let text = try? String(contentsOf: js, encoding: .utf8) else {
      return .failure(HarnessError("build-harness.mjs exited \(p.terminationStatus): \(log.prefix(600))"))
    }
    try? FileManager.default.removeItem(at: out)
    return .success(text)
  }()
  struct HarnessError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
  }

  func loadRealPage(_ r: Rig) async throws {
    let js = try Self.harness.get()
    r.wv.loadHTMLString("<html><body></body></html>", baseURL: Self.base)
    await pump(0.4)
    _ = try? await r.wv.evaluateJavaScript(js)
  }

  func js(_ r: Rig, _ s: String) async throws -> Any? { try await r.wv.evaluateJavaScript(s) }

  // MARK: the real page

  @Test func aStoreChangeReachesTheControllerAndSignOutClearsIt() async throws {
    let r = try rig()
    try await loadRealPage(r)
    #expect(await until(5) { r.c.companionFeed != nil } != nil, "no feed arrived; got \(r.got())")
    #expect(r.c.pageFeatures.contains("companion/1"))
    #expect(r.c.companionFeed?.working == 0)

    _ = try await js(r, "window.__h.setStatus('general','working')")
    // The page pushes a change after its short coalescing pause, and re-sends everything every 30 s regardless. Reaching the
    // Mac inside this wait (shorter than that tick) therefore means the change itself was pushed; the wait only caps a hang.
    let t = await until(20) { r.c.companionFeed?.working == 1 }
    #expect(t != nil, "a store change never reached the feed")
    #expect(r.c.companionFeed?.rows.first == .init(threadId: "general", state: .working))

    _ = try await js(r, "window.__h.signOut()")
    let cleared = await until(20) { r.c.companionFeed == nil }  // shorter than the page's 30 s tick, so sign-out itself did it
    #expect(cleared != nil, "sign-out never cleared the feed")
    #expect(r.feeds().last == .some(nil), "the callback must report the clear")

    _ = try await js(r, "window.__h.signIn()")
    // Sign-out then sign-in at once: the shell threw its feed away at the ready in between, so the page must resend.
    #expect(await until(3) { r.c.companionFeed != nil } != nil, "signing back in must bring the feed back")
  }

  /// Native sign-out and "Forget this Mac" end the session from the Mac side, with a page that is still alive and still
  /// feeding. The feed must be gone the moment they return, not when the reload commits, and a frame the old page sends
  /// in between must not bring it back.
  @Test func nativeSignOutClearsALiveFeedAtOnceAndALateFrameCannotBringItBack() async throws {
    let r = try rig()
    try await loadRealPage(r)
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    _ = try await js(r, "window.__h.setStatus('general','working')")
    #expect(await until(2) { r.c.companionFeed?.working == 1 } != nil)
    await r.c.signOut()
    #expect(r.c.companionFeed == nil, "signOut() returned with the feed still standing")
    #expect(r.feeds().last == .some(nil), "the callback must report the clear")
    _ = try? await js(r, "window.__h.setStatus('general','queued')")
    await pump(0.1)
    #expect(r.c.companionFeed == nil, "a frame from the old page after signOut() fed the pet")
  }

  @Test func forgetThisMacWipeClearsALiveFeedAtOnce() async throws {
    let r = try rig()
    try await loadRealPage(r)
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    await r.c.wipeSiteData()
    #expect(r.c.companionFeed == nil, "wipeSiteData() returned with the feed still standing")
    #expect(r.feeds().last == .some(nil))
  }

  @Test func aFrameCapturedFromTheRealPageHoldsNoThreadNameAndNoMessageText() async throws {
    let r = try rig()
    try await loadRealPage(r)
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    _ = try await js(r, "window.__h.addReply('general', 'SECRET REPLY **bold** \\u202e hidden')")
    _ = try await js(r, "window.__h.setStatus('inbox','working')")
    #expect(await until(2) { r.c.companionFeed?.rows.contains { $0.threadId == "inbox" } == true } != nil)
    let frames = try #require(try await js(r, "JSON.stringify(window.__h.companionFrames())") as? String)
    let names = try #require(try await js(r, "JSON.stringify(window.__h.names())") as? String)
    #expect(frames.contains("companion_state") && names.count > 4)
    #expect(!frames.contains("SECRET") && !frames.contains("bold"))
    let nameList = try #require(try JSONSerialization.jsonObject(with: Data(names.utf8)) as? [String])
    for n in nameList { #expect(!frames.contains("\"\(n)\""), "thread name \(n) leaked into a frame") }
  }

  @Test func theLastReplyRoundTripsAsPlainTextAndANewerClickSupersedes() async throws {
    let r = try rig()
    try await loadRealPage(r)
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    _ = try await js(r, "window.__h.addReply('general', '**Done** with [the link](https://x.test/a).')")

    var first: LastReplyTracker.Outcome?
    var second: LastReplyTracker.Outcome?
    r.c.requestLastReply(thread: "general") { first = $0 }
    r.c.requestLastReply(thread: "general") { second = $0 }
    #expect(await until(5) { second != nil } != nil, "no answer to the second request")
    #expect(first == .superseded)
    #expect(second == .text("Done with the link (https://x.test/a).", truncated: false))

    var empty: LastReplyTracker.Outcome?
    r.c.requestLastReply(thread: "inbox") { empty = $0 }  // nothing loaded in that thread
    #expect(await until(5) { empty != nil } != nil)
    #expect(empty == .empty)
  }

  // MARK: hand-written pages

  @Test func anOldPageWithoutCompanionFeatureNeverFeedsThePetAndCannotBeAsked() async throws {
    let r = try rig()
    await load(r, body: "", script: "send({type:'ready',shell_api:1,features:['notify','badge'],signed_in:true}); send(\(Self.frameJS)); send({type:'badge',count:2});")
    #expect(await until(5) { r.got().contains(.badge(2)) } != nil)
    #expect(r.c.companionFeed == nil)
    #expect(r.feeds().isEmpty)
    var outcome: LastReplyTracker.Outcome?
    r.c.requestLastReply(thread: "general") { outcome = $0 }
    #expect(outcome == .unavailable, "a page without companion/1 must not be asked")
  }

  @Test func aFrameBeforeReadyIsIgnoredAndTheNextOneIsTaken() async throws {
    let r = try rig()
    await load(r, body: "", script: "send(\(Self.frameJS)); \(Self.readyJS)")
    #expect(await until(5) { r.c.pageReady } != nil)
    await pump(0.3)
    #expect(r.c.companionFeed == nil, "a frame that arrived before ready must not stand")
    _ = try await js(r, "send(\(Self.frameJS))")
    #expect(await until(3) { r.c.companionFeed != nil } != nil)
  }

  @Test func aBadFrameClearsTheFeedAndAnUnknownRowStateDropsOnlyThatRow() async throws {
    let r = try rig()
    await load(r, body: "", script: Self.readyJS + "send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    #expect(r.c.companionFeed?.rows.count == 2)

    _ = try await js(r, "send({type:'companion_state',link:'online',mac_online:true,busy:false,needs:1,working:0,queued:0,on_call:0,unread:0,failed:0,rows:[{thread_id:'a',state:'needs_you'},{thread_id:'b',state:'dreaming'}],last_reply:null})")
    #expect(await until(3) { r.c.companionFeed?.rows.map(\.threadId) == ["a"] } != nil, "got \(String(describing: r.c.companionFeed))")

    _ = try await js(r, "send({type:'companion_state',link:'online',mac_online:true,busy:false,needs:-1,working:0,queued:0,on_call:0,unread:0,failed:0,rows:[],last_reply:null})")
    #expect(await until(3) { r.c.companionFeed == nil } != nil, "a bad frame must clear the old feed, not leave it standing")
    #expect(r.got().contains(.companionInvalid))
  }

  @Test func aSubFrameCannotFeedThePetAndAnUnknownTypeDoesNotBreakTheOnesAfterIt() async throws {
    let r = try rig()
    let inner = Self.frameJS.replacingOccurrences(of: "\n", with: " ")
    await load(
      r,
      body: "<iframe sandbox=\"allow-scripts\" srcdoc=\"<script>try{window.parent.webkit.messageHandlers.talos.postMessage(\(inner.replacingOccurrences(of: "\"", with: "&quot;")))}catch(e){};window.webkit.messageHandlers.talos.postMessage(\(inner.replacingOccurrences(of: "\"", with: "&quot;")))</script>\"></iframe>",
      script: Self.readyJS + "send({type:'companion_state_v9',x:1}); send({type:'badge',count:5});")
    #expect(await until(5) { r.got().contains(.badge(5)) } != nil, "got \(r.got())")
    await pump(0.5)
    #expect(r.c.companionFeed == nil, "a sub-frame fed the pet")
  }

  @Test func theFeedGoesAfterNinetySecondsOfSilenceNotBefore() async throws {
    let r = try rig()
    await load(r, body: "", script: Self.readyJS + "send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    r.c.checkCompanionStale(at: .now.advanced(by: .seconds(80)))
    #expect(r.c.companionFeed != nil)
    r.c.checkCompanionStale(at: .now.advanced(by: .seconds(95)))
    #expect(r.c.companionFeed == nil)
    #expect(r.feeds().last == .some(nil))
  }

  @Test func theRealStaleTimerClearsASilentFeedAndEachFrameMovesTheDeadline() async throws {
    let r = try rig()
    // The limit is wide against the gaps between frames (1 s against 3 s), so a busy machine that stalls a pump for a
    // second or two does not look like silence. The frames still run past the limit in total (4 s), which is what shows
    // each one moves the deadline.
    r.c.useCompanionStaleLimitForTest(.seconds(3))
    await load(r, body: "", script: Self.readyJS + "send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    // A frame every second keeps it alive well past the 3 s limit.
    for _ in 0..<4 {
      await pump(1.0)
      _ = try await js(r, "send(\(Self.frameJS))")
    }
    #expect(r.c.companionFeed != nil, "frames arriving inside the limit must keep the feed")
    // Then silence: the timer, not a test seam, clears it.
    let t = await until(30) { r.c.companionFeed == nil }  // only caps a hang: the 3 s limit is the real timer's
    #expect(t != nil, "silence never cleared the feed")
    #expect(r.feeds().last == .some(nil))
  }

  @Test func aWakeFromSleepClearsTheFeedUntilTheNextFrame() async throws {
    let r = try rig()
    await load(r, body: "", script: Self.readyJS + "send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: nil)
    #expect(await until(2) { r.c.companionFeed == nil } != nil)
    _ = try await js(r, "send(\(Self.frameJS))")
    #expect(await until(3) { r.c.companionFeed != nil } != nil)
  }

  @Test func aNewDocumentDropsTheFeedAndEndsAReplyRequestOnce() async throws {
    let r = try rig()
    // The page takes the request (returns true) and never answers.
    await load(r, body: "", script: "window.talosNative={receive:function(){return true}};" + Self.readyJS + "send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    var calls: [LastReplyTracker.Outcome] = []
    r.c.requestLastReply(thread: "general") { calls.append($0) }
    await pump(0.3)
    #expect(calls.isEmpty)
    r.wv.loadHTMLString("<html><body>next page</body></html>", baseURL: Self.base)
    #expect(await until(3) { !calls.isEmpty } != nil)
    #expect(calls == [.unavailable])
    #expect(r.c.companionFeed == nil)
    await pump(3.3)  // the old request's timeout fires now and must do nothing
    #expect(calls == [.unavailable])
  }

  @Test func aSilentPageTimesOutAfterThreeSeconds() async throws {
    let r = try rig()
    await load(r, body: "", script: "window.talosNative={receive:function(){return true}};" + Self.readyJS + "send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    var outcome: LastReplyTracker.Outcome?
    let start = Date()
    r.c.requestLastReply(thread: "general") { outcome = $0 }
    #expect(await until(6) { outcome != nil } != nil)
    #expect(outcome == .timedOut)
    #expect(Date().timeIntervalSince(start) >= 2.9)
  }

  @Test func aLateOrWrongAnswerIsDroppedAndNeverShown() async throws {
    let r = try rig()
    // This page answers every request with a wrong request id first, then a wrong thread, then the right one.
    let script = """
      window.talosNative={receive:function(raw){var m=JSON.parse(raw);
        send({type:'companion_reply',req:'r999',thread_id:m.thread_id,text:'WRONG REQ',truncated:false});
        send({type:'companion_reply',req:m.req,thread_id:'other',text:'WRONG THREAD',truncated:false});
        send({type:'companion_reply',req:m.req,thread_id:m.thread_id,text:'right',truncated:false});
        send({type:'companion_reply',req:m.req,thread_id:m.thread_id,text:'second answer',truncated:false});
        return true}};
      """
    await load(r, body: "", script: script + Self.readyJS + "send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    var calls: [LastReplyTracker.Outcome] = []
    r.c.requestLastReply(thread: "general") { calls.append($0) }
    #expect(await until(5) { !calls.isEmpty } != nil)
    await pump(0.4)
    #expect(calls == [.text("right", truncated: false)])
  }

  @Test func aPageThatRefusesTheRequestEndsItAtOnceAsUnavailable() async throws {
    let r = try rig()
    // The page's bridge answers false (as it does when signed out): the Mac must not wait out the timeout.
    await load(r, body: "", script: "window.talosNative={receive:function(){return false}};" + Self.readyJS + "send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    var calls: [LastReplyTracker.Outcome] = []
    r.c.requestLastReply(thread: "general") { calls.append($0) }
    // The outcome is `.unavailable`, not `.timedOut`: a request that waited out its 3 s timeout could not report it. The
    // wait only caps a hang.
    #expect(await until(20) { !calls.isEmpty } != nil)
    #expect(calls == [.unavailable], "a refusal must not wait for the 3 s timeout")
    await pump(3.3)
    #expect(calls == [.unavailable], "the timeout of a finished request must do nothing")
  }

  @Test func theCallbackFiresOncePerChangeAndNotForAnEqualFrame() async throws {
    let r = try rig()
    await load(r, body: "", script: Self.readyJS + "send(\(Self.frameJS)); send(\(Self.frameJS)); send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    await pump(0.5)
    #expect(r.feeds().count == 1, "three equal frames made \(r.feeds().count) callbacks")
    _ = try await js(r, "send(\(Self.frameJS.replacingOccurrences(of: "needs:1", with: "needs:2")))")
    #expect(await until(3) { r.feeds().count == 2 } != nil)
    #expect(r.feeds().last??.needs == 2)
  }

  @Test func requestsAreRefusedBeforeAnythingIsSentWhenTheThreadIdIsBad() async throws {
    let r = try rig()
    await load(r, body: "", script: Self.readyJS + "send(\(Self.frameJS));")
    #expect(await until(5) { r.c.companionFeed != nil } != nil)
    var outcome: LastReplyTracker.Outcome?
    r.c.requestLastReply(thread: "Not A Thread") { outcome = $0 }
    #expect(outcome == .unavailable)
  }
}
