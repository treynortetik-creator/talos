import CoreGraphics
import Foundation
import Testing

@testable import TalosDesktopCore

/// The one thing an agent may never do in Talos (docs/SECURITY.md "An agent in Talos"): answer an approval card or a permission
/// prompt. The window code itself (AppKit, WebKit) is tested in TalosDesktopGuiTests and apps/web/test/protected-input.test.ts; here
/// the rules and the posting side are, against a stand-in window that classifies events with the real `SyntheticInput.classify`.
struct FixedScreenAllowList: ScreenAllowListProvider {
  let apps: [ScreenAllowedApp]
  init(_ apps: [ScreenAllowedApp]) { self.apps = apps }
  func allowedApps() -> [ScreenAllowedApp] { apps }
}

@Suite("Synthetic input: the origin of an event")
struct SyntheticInputClassifyTests {
  private func origin(
    pid: Int64? = 0, state: Int64? = SyntheticInput.hidSystemStateId, user: Int64? = 0, inFlight: Bool = false
  ) -> SyntheticInput.Origin {
    SyntheticInput.classify(sourcePid: pid, sourceStateId: state, userData: user, postedByThisProcessNow: inFlight)
  }

  @Test func onlyTheHardwareWithNothingOfOursInFlightIsTheOwner() {
    #expect(origin() == .human, "the mouse, trackpad or keyboard")
    #expect(origin(pid: 4242) == .synthetic, "another program's event, from the hardware state")
    #expect(origin(pid: Int64(getpid())) == .synthetic, "this process's own post")
    #expect(origin(user: 7) == .synthetic, "carries a token of ours, whatever else it says")
    #expect(origin(state: Int64(CGEventSourceStateID.combinedSessionState.rawValue)) == .synthetic)
    #expect(origin(state: Int64(CGEventSourceStateID.privateState.rawValue)) == .synthetic)
    #expect(origin(state: -1) == .synthetic)
    #expect(origin(inFlight: true) == .synthetic, "one of our events still awaits its answer: this one could be it")
  }

  @Test func anEventThatCannotBeReadIsSynthetic() {
    #expect(origin(pid: nil, state: nil, user: nil) == .synthetic, "no CGEvent behind it: failing closed")
    #expect(origin(pid: 0, state: nil) == .synthetic)
    #expect(origin(pid: nil) == .synthetic)
    #expect(origin(user: nil) == .synthetic)
  }

  @Test func theHardwareStateIdIsMacOSsOwn() {
    #expect(SyntheticInput.hidSystemStateId == Int64(CGEventSourceStateID.hidSystemState.rawValue))
    #expect(SyntheticInput.hidSystemStateId == PopupClickCheck.hidSystemStateId)
  }

  @Test func theNeedsYouPopupCountsNoClickWhileOneOfOursIsInFlight() {
    func real(pid: Int64 = 0, inFlight: Bool = false) -> Bool {
      PopupClickCheck.isRealClick(
        kind: .leftMouseUp, age: 0.05, sameWindow: true, onButton: true, sourcePid: pid, sourceStateId: PopupClickCheck.hidSystemStateId,
        eventsOfOursInFlight: inFlight)
    }
    #expect(real())
    #expect(!real(pid: Int64(getpid())), "a click Talos posted for an agent")
    #expect(!real(inFlight: true), "pid 0 but one of ours is in flight")
  }
}

@Suite("Synthetic input: the answers to an agent's events")
struct SyntheticInputFlightTests {
  @Test func tokensAreUniqueAndNeverZero() {
    let f = SyntheticInput.Flight()
    let a = f.begin(), b = f.begin()
    #expect(a != 0 && b != 0 && a != b)
  }

  @Test func eventsAreInFlightUntilAnsweredNotForAFixedSpan() {
    let f = SyntheticInput.Flight()
    #expect(!f.active)
    let t = f.begin()
    #expect(f.active, "being posted")
    f.expect(t, answers: 2)
    f.end()
    #expect(f.active, "posted, not yet answered")
    f.handled(t)
    #expect(f.active, "two answers were owed")
    f.handled(t)
    #expect(!f.active)
    // a request that gave up lets go of its tokens
    let u = f.begin()
    f.expect(u, answers: 1)
    f.end()
    f.forget([u])
    #expect(!f.active)
    f.end()  // an end without a begin never goes below zero
    _ = f.begin()
    #expect(f.active)
  }

  @Test func aRequestWaitsForItsOwnAnswersAndHearsItsOwnDrops() {
    let f = SyntheticInput.Flight()
    let a = f.begin(), b = f.begin()
    f.expect(a, answers: 1)
    f.expect(b, answers: 1)
    f.drop(b)  // someone else's request hit a button
    f.handled(a)
    #expect(f.wait([a], timeout: 0.2) == .handled, "a's answer is not b's drop")
    #expect(f.wait([b], timeout: 0.2) == .dropped)
    #expect(f.wait([a, b], timeout: 0.2) == .dropped)
    #expect(f.strayDrops == 0)
    f.drop(0)
    f.drop(9999)
    #expect(f.strayDrops == 2, "a drop with no token of ours is counted, and belongs to no request")
    #expect(f.wait([a], timeout: 0.2) == .handled)
  }

  @Test func noAnswerInTimeIsUnverifiedNeverHandled() {
    let f = SyntheticInput.Flight()
    let a = f.begin()
    f.expect(a, answers: 1)
    #expect(f.wait([a], timeout: 0.05) == .unverified)
  }

  @Test func aLateAnswerOrDropFromAnotherThreadIsHeard() async {
    let f = SyntheticInput.Flight()
    let a = f.begin(), b = f.begin()
    f.expect(a, answers: 1)
    f.expect(b, answers: 1)
    Thread.detachNewThread {
      Thread.sleep(forTimeInterval: 0.05)
      f.handled(a)
      f.drop(b)
    }
    #expect(f.wait([a], timeout: 2) == .handled)
    #expect(f.wait([b], timeout: 2) == .dropped)
  }
}

/// A stand-in for a Talos window with a card on it: Approve at `approve`, a harmless spot elsewhere, and a terminal at `terminal`. It
/// reads each event the way the real windows do, with `SyntheticInput.classify` on the fields the system would put on it: the token the
/// post carried (and this process's pid), or nothing at all for a person. A synthetic event on Approve or on the terminal is dropped
/// and reported against its token; every event is answered, as the page and the windows answer.
final class FakeCardWindow: @unchecked Sendable {
  let approve = CGPoint(x: 100, y: 100)
  let elsewhere = CGPoint(x: 300, y: 200)
  let terminal = CGPoint(x: 50, y: 250)
  let flight: SyntheticInput.Flight
  private let lock = NSLock()
  private var _answered = 0
  private var _typedInTerminal = 0
  /// Whether the keyboard focus is on Approve, or in a terminal.
  var focusOnApprove = false
  var focusInTerminal = false
  /// How long the window takes to deal with an event (0: at once), and whether it answers at all.
  var delay = 0.0
  var answers = true
  var answered: Int { lock.withLock { _answered } }
  var typedInTerminal: Int { lock.withLock { _typedInTerminal } }
  init(flight: SyntheticInput.Flight) { self.flight = flight }

  /// What the system delivers: an agent's post carries this process's pid and its token; a person's carries neither.
  func deliver(_ e: ScreenInputEvent, token: Int64, fromPid pid: Int64) {
    let work = { [self] in
      let origin = SyntheticInput.classify(
        sourcePid: pid, sourceStateId: SyntheticInput.hidSystemStateId, userData: token, postedByThisProcessNow: flight.active)
      let onApprove: Bool, inTerminal: Bool
      func isKey(_ c: ScreenKeyCombo) -> Bool { [36, 49, 76].contains(c.keyCode) }
      switch e {
      case .click(let p, _, _):
        onApprove = p == approve
        inTerminal = p == terminal
      case .key(let k):
        onApprove = focusOnApprove && isKey(k)
        inTerminal = focusInTerminal
      case .keys(let ks):
        onApprove = focusOnApprove && ks.contains(where: isKey)
        inTerminal = focusInTerminal
      case .text(let s):
        onApprove = focusOnApprove && (s.contains("\n") || s.contains("\r") || s.contains(" "))
        inTerminal = focusInTerminal
      case .scroll:
        onApprove = false
        inTerminal = false
      }
      if origin == .synthetic, onApprove || inTerminal {
        flight.drop(token)
      } else if origin == .human {
        lock.withLock {
          if onApprove { _answered += 1 }
          if inTerminal { _typedInTerminal += 1 }
        }
      } else if inTerminal {
        lock.withLock { _typedInTerminal += 1 }  // can't happen: a synthetic event in a terminal is dropped above
      }
      if token != 0, answers { for _ in 0..<e.answers { flight.handled(token) } }
    }
    // a thread of its own: the shared pools are busy with other suites' waits, and a late answer must not depend on them
    let wait = delay
    if wait > 0 {
      Thread.detachNewThread {
        Thread.sleep(forTimeInterval: wait)
        work()
      }
    } else { work() }
  }
}

@Suite("Synthetic input: an agent in Talos never answers a card")
struct SyntheticInputGuardTests {
  static let talosAllowed: Set<String> = [ScreenCore.talosBundleID]

  /// A core whose front app is Talos (this process, as far as the flight knows), on the list, and whose fake input hands every event
  /// to the card window as this process's own post.
  func rig(focusOnApprove: Bool = false, focusInTerminal: Bool = false, delay: Double = 0, answers: Bool = true)
    -> (ScreenCore, FakeCardWindow, FakeInput)
  {
    let flight = SyntheticInput.Flight(ownPid: Fx.talos.pid)
    let win = FakeCardWindow(flight: flight)
    win.focusOnApprove = focusOnApprove
    win.focusInTerminal = focusInTerminal
    win.delay = delay
    win.answers = answers
    let input = FakeInput()
    input.after = { [unowned input] n in win.deliver(input.posted[n - 1], token: input.tokens[n - 1], fromPid: Int64(getpid())) }
    let apps = FakeApps(front: Fx.talos)
    apps.under = { _ in Fx.talos }
    return (Fx.core(input: input, apps: apps, flight: flight), win, input)
  }

  @Test func theAgentCanClickAndTypeInTalosAnywhereButOnAnAnswerButtonOrATerminal() throws {
    let (core, win, input) = rig()
    #expect(try core.perform(.click(win.elsewhere), allowedBundleIDs: Self.talosAllowed) == 1)
    #expect(try core.perform(.type("hello"), allowedBundleIDs: Self.talosAllowed) == 1)
    #expect(try core.perform(.key("return"), allowedBundleIDs: Self.talosAllowed) == 1)
    #expect(input.posted.count == 3)
    #expect(win.answered == 0)
  }

  @Test func eachPostCarriesItsOwnTokenAndIsAnsweredBeforeTheRequestEnds() throws {
    let (core, win, input) = rig()
    try core.perform(.click(win.elsewhere), allowedBundleIDs: Self.talosAllowed)
    try core.perform(.click(win.elsewhere), allowedBundleIDs: Self.talosAllowed)
    #expect(input.tokens.count == 2 && input.tokens[0] != 0 && input.tokens[0] != input.tokens[1])
    #expect(!core.flight.active, "everything answered: nothing is held in flight")
  }

  @Test func aSyntheticClickOnApproveDoesNothingAndTheAgentIsToldSo() {
    let (core, win, _) = rig()
    #expect(throws: ScreenRefusal.protectedPrompt) { try core.perform(.click(win.approve), allowedBundleIDs: Self.talosAllowed) }
    #expect(throws: ScreenRefusal.protectedPrompt) { try core.perform(.click(win.approve, count: 2), allowedBundleIDs: Self.talosAllowed) }
    #expect(win.answered == 0)
    #expect(!core.flight.active)
  }

  @Test func aSyntheticReturnOrSpaceOnAFocusedApproveDoesNothing() {
    let (core, win, _) = rig(focusOnApprove: true)
    for r: ScreenInputRequest in [.key("return"), .key("enter"), .key("space"), .type("\n"), .type("go on"), .type("ok\r")] {
      #expect(throws: ScreenRefusal.protectedPrompt, "\(r)") { try core.perform(r, allowedBundleIDs: Self.talosAllowed) }
    }
    #expect(win.answered == 0)
  }

  /// R1-1, R1-3: a terminal in Talos (the agent's pane, the owner's own shell, the sign-in pane) takes nothing an agent sends.
  @Test func nothingAnAgentSendsReachesATerminal() {
    let (core, win, _) = rig(focusInTerminal: true)
    for r: ScreenInputRequest in [.click(win.terminal), .key("return"), .key("y"), .type("y"), .type("rm -rf ~\n")] {
      #expect(throws: ScreenRefusal.protectedPrompt, "\(r)") { try core.perform(r, allowedBundleIDs: Self.talosAllowed) }
    }
    #expect(win.typedInTerminal == 0)
    // and the owner's own keys do reach it
    win.deliver(.key(try! ScreenKeyCombo.parse("y")), token: 0, fromPid: 0)
    #expect(win.typedInTerminal == 1)
  }

  /// R1-6: a drop that the window reports a moment late is still this request's refusal, not a success.
  @Test func aLateDropIsStillTheRequestsRefusal() {
    let (core, win, _) = rig(delay: 0.08)
    var c = core
    c.deliveryTimeout = 3
    #expect(throws: ScreenRefusal.protectedPrompt) { try c.perform(.click(win.approve), allowedBundleIDs: Self.talosAllowed) }
    #expect(win.answered == 0)
  }

  /// R1-6: no answer from the window is "unverified", never "sent".
  @Test func aWindowThatNeverAnswersIsUnverifiedNotSuccess() {
    let (core, win, _) = rig(answers: false)
    #expect(throws: ScreenRefusal.deliveryUnverified) { try core.perform(.click(win.elsewhere), allowedBundleIDs: Self.talosAllowed) }
    #expect(!core.flight.active, "the request let go of its tokens")
  }

  @Test func anEventAimedAtAnotherAppWaitsForNothing() throws {
    let flight = SyntheticInput.Flight(ownPid: Fx.talos.pid)
    let input = FakeInput()  // nothing answers
    let core = Fx.core(input: input, apps: FakeApps(front: Fx.notes), flight: flight)
    #expect(try core.perform(.key("a"), allowedBundleIDs: ["com.example.notes"]) == 1)
    #expect(try core.perform(.type("abc"), allowedBundleIDs: ["com.example.notes"]) == 1)
  }

  /// R1-6 / class 10: two requests at once. One on Approve is refused; the other, elsewhere, goes through; neither reads the other's drop.
  @Test func twoRequestsAtOnceEachHearTheirOwnAnswer() {
    let (core, win, _) = rig(delay: 0.05)
    var c = core
    c.deliveryTimeout = 5
    let results = LockedValue<[Int: Bool]>([:])
    let done = DispatchGroup()
    for i in 0..<6 {
      done.enter()
      Thread.detachNewThread { [c] in
        let onApprove = i % 2 == 0
        let ok = (try? c.perform(.click(onApprove ? win.approve : win.elsewhere), allowedBundleIDs: Self.talosAllowed)) != nil
        results.withLock { $0[i] = ok }
        done.leave()
      }
    }
    done.wait()
    for i in 0..<6 { #expect(results.value[i] == (i % 2 != 0), "request \(i)") }
  }

  /// The same window, the owner's hand: the same click answers.
  @Test func theOwnersOwnClickAndKeyStillAnswer() {
    let (_, win, _) = rig(focusOnApprove: true)
    win.deliver(.click(win.approve, button: .left, count: 1), token: 0, fromPid: 0)
    win.deliver(.key(try! ScreenKeyCombo.parse("return")), token: 0, fromPid: 0)
    #expect(win.answered == 2)
  }

  @Test func theOwnersClickWhileOneOfOursStillAwaitsItsAnswerIsRefusedAndTheNextOneAnswers() {
    let flight = SyntheticInput.Flight()
    let win = FakeCardWindow(flight: flight)
    let t = flight.begin()
    flight.expect(t, answers: 1)
    flight.end()
    win.deliver(.click(win.approve, button: .left, count: 1), token: 0, fromPid: 0)
    #expect(win.answered == 0 && flight.strayDrops == 1, "fail closed while an event of ours is awaiting its answer")
    flight.handled(t)
    win.deliver(.click(win.approve, button: .left, count: 1), token: 0, fromPid: 0)
    #expect(win.answered == 1)
  }

  @Test func everyPostIsMarkedInFlightWhileItIsDelivered() throws {
    let flight = SyntheticInput.Flight()
    let input = FakeInput()
    let seen = LockedValue<[Bool]>([])
    input.after = { _ in seen.value.append(flight.active) }
    let core = Fx.core(input: input, apps: FakeApps(front: Fx.notes), flight: flight)
    try core.perform(.type("abcdefghijklmnopqrstuvwxyz"), allowedBundleIDs: ["com.example.notes"])
    #expect(seen.value.count == 2 && seen.value.allSatisfy { $0 })
  }

  /// Class 7: the socket, which every screen tool goes through (screen_click, screen_key, screen_type), says the same.
  @Test(arguments: [
    #"{"op":"click","x":100,"y":100}"#, #"{"op":"key","keys":"return"}"#, #"{"op":"key","keys":"space"}"#, #"{"op":"type","text":"\n"}"#,
  ])
  func everyScreenToolRefusesAtTheSameButton(json: String) async throws {
    let request = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    let (core, win, _) = rig(focusOnApprove: true)
    let talos = ScreenAllowedApp(bundleID: ScreenCore.talosBundleID, name: "Talos")
    let p = ScreenProtocol(service: core, allowList: FixedScreenAllowList([talos]), signing: FakeSigning())
    let line = try JSONSerialization.data(withJSONObject: request.merging(["v": 1, "id": "1"]) { a, _ in a })
    let a = try #require(try JSONSerialization.jsonObject(with: await p.answer(line)) as? [String: Any])
    #expect(a["ok"] as? Bool == false)
    let e = a["error"] as? [String: Any]
    #expect(e?["code"] as? String == "protected_prompt", "\(a)")
    #expect((e?["text"] as? String)?.contains("approval card or a permission prompt") == true)
    #expect(win.answered == 0)
  }

  /// R1-3: through the socket, typing at the owner's shell is refused too, and what the owner's shell would have read stays empty.
  @Test func screenTypeAtAnOwnerShellIsRefusedThroughTheSocket() async throws {
    let (core, win, _) = rig(focusInTerminal: true)
    let talos = ScreenAllowedApp(bundleID: ScreenCore.talosBundleID, name: "Talos")
    let p = ScreenProtocol(service: core, allowList: FixedScreenAllowList([talos]), signing: FakeSigning())
    let line = try JSONSerialization.data(withJSONObject: ["v": 1, "id": "1", "op": "type", "text": "touch /tmp/x\n"] as [String: Any])
    let a = try #require(try JSONSerialization.jsonObject(with: await p.answer(line)) as? [String: Any])
    #expect((a["error"] as? [String: Any])?["code"] as? String == "protected_prompt")
    #expect(win.typedInTerminal == 0)
  }
}

/// A Talos window in the small: a thread row, a composer, and a card whose Approve is protected. Events come in as this process's own post.
final class FakeTalosApp: @unchecked Sendable {
  let threadRow = CGPoint(x: 30, y: 60), composer = CGPoint(x: 200, y: 280), approve = CGPoint(x: 100, y: 100)
  let flight: SyntheticInput.Flight
  private let lock = NSLock()
  private var _open: String?, _draft = "", _sent: [String] = [], _focusComposer = false, _answered = 0
  init(flight: SyntheticInput.Flight) { self.flight = flight }
  var openThread: String? { lock.withLock { _open } }
  var sent: [String] { lock.withLock { _sent } }
  var answered: Int { lock.withLock { _answered } }
  func deliver(_ e: ScreenInputEvent, token: Int64) {
    lock.withLock {
      switch e {
      case .click(let p, _, _):
        if p == threadRow { _open = "trip" }
        if p == composer { _focusComposer = true }
        if p == approve { flight.drop(token) }  // a synthetic click on a protected button
      case .text(let s): if _focusComposer { _draft += s }
      case .keys(let ks):
        if _focusComposer { for k in ks { if k.keyCode == 36 { if !_draft.isEmpty { _sent.append(_draft); _draft = "" } } else { _draft += "x" } } }
      case .key(let k): if _focusComposer, k.keyCode == 36, !_draft.isEmpty { _sent.append(_draft); _draft = "" }
      case .scroll: break
      }
    }
    for _ in 0..<e.answers { flight.handled(token) }
  }
}

@Suite("An agent drives Talos: open a thread, type, send")
struct TalosDriveThroughTests {
  @Test func openAThreadTypeAndSendThroughTheScreenTools() async throws {
    let flight = SyntheticInput.Flight(ownPid: Fx.talos.pid)
    let app = FakeTalosApp(flight: flight)
    let input = FakeInput()
    input.after = { [unowned input] n in app.deliver(input.posted[n - 1], token: input.tokens[n - 1]) }
    let apps = FakeApps(front: Fx.talos)
    apps.under = { _ in Fx.talos }
    let core = Fx.core(input: input, apps: apps, flight: flight)
    let talos = ScreenAllowedApp(bundleID: ScreenCore.talosBundleID, name: "Talos")
    let p = ScreenProtocol(service: core, allowList: FixedScreenAllowList([talos]), signing: FakeSigning())
    func call(_ o: [String: Any]) async throws -> [String: Any] {
      let line = try JSONSerialization.data(withJSONObject: o.merging(["v": 1, "id": "1"]) { a, _ in a })
      return try #require(try JSONSerialization.jsonObject(with: await p.answer(line)) as? [String: Any])
    }
    #expect(try await call(["op": "click", "x": 30, "y": 60])["ok"] as? Bool == true)
    #expect(app.openThread == "trip")
    #expect(try await call(["op": "click", "x": 200, "y": 280])["ok"] as? Bool == true)
    #expect(try await call(["op": "type", "text": "hello from the agent"])["ok"] as? Bool == true)
    #expect(try await call(["op": "key", "keys": "return"])["ok"] as? Bool == true)
    #expect(app.sent == ["hello from the agent"])
    // and the card's button in the same window is the one place that says no
    let no = try await call(["op": "click", "x": 100, "y": 100])
    #expect((no["error"] as? [String: Any])?["code"] as? String == "protected_prompt")
    #expect(app.answered == 0)
  }
}

@Suite("Talos on the allowed list like any app")
struct TalosAllowedLikeAnyAppTests {
  nonisolated(unsafe) static let talosApp: [String: Any] = [
    "bundle_id": "app.talos.desktop", "team_id": "ABCDE12345",
    "requirement": "anchor apple generic and identifier \"app.talos.desktop\" and certificate leaf[subject.OU] = ABCDE12345",
    "name": "Talos", "signer": "developer",
  ]

  @Test func aSignedTalosEntryIsAcceptedAndKeptWithItsProof() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let app = try s.add(ProofKit.proof(app: Self.talosApp)).get()
    #expect(app.bundleID == "app.talos.desktop" && app.name == "Talos" && app.teamID == "ABCDE12345")
    #expect(s.allowedApps().map(\.bundleID) == ["app.talos.desktop"])
    // a dev build is another app id, allowed on its own proof
    let dev = try s.add(ProofKit.proof(app: Self.talosApp.merging(["bundle_id": "app.talos.desktop.dev", "name": "Talos Dev"]) { _, n in n }, cardId: "c_dev")).get()
    #expect(dev.bundleID == "app.talos.desktop.dev")
    // and it is listed in Settings
    let model = ScreenAllowedAppsModel(store: s)
    #expect(model.rows.map(\.bundleID).sorted() == ["app.talos.desktop", "app.talos.desktop.dev"])
  }

  @Test(arguments: [
    ("signed by a phone that is not paired", ProofKit.proof(app: talosApp, signer: ProofKit.stranger), ScreenAllowProofCheck.Step.device),
    ("names the paired phone but another key signed", ProofKit.proof(app: talosApp, signer: ProofKit.stranger, claimDevice: ProofKit.device), .signature),
    ("Not now", ProofKit.proof(app: talosApp, action: "kill"), .frame),
    ("another card's binding", ProofKit.proof(app: talosApp, hashOf: "{}"), .binding),
  ])
  func aSignatureThatDoesNotCheckStillAllowsNothing(why: String, proof: ScreenAllowProof, step: ScreenAllowProofCheck.Step) {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    #expect(s.add(proof) == .failure(.proof(step)), "\(why)")
    #expect(s.allowedApps().isEmpty)
  }

  /// The entry is bound to Talos's signature: another program that claims the id gets no input.
  @Test func aProgramClaimingTalosIdWithAnotherSignatureGetsNothing() throws {
    let signing = FakeSigning()
    signing.refusePIDs = [777]
    let entry = ScreenAllowedApp(bundleID: ScreenCore.talosBundleID, teamID: "ABCDE12345", designatedRequirement: "x", name: "Talos")
    let input = FakeInput()
    let apps = FakeApps(front: Fx.talos)
    apps.under = { _ in Fx.talos }
    let core = Fx.core(input: input, apps: apps)
    #expect(throws: ScreenRefusal.appNotAllowed(app: ScreenCore.talosBundleID, subject: .running(pid: 777))) {
      try core.perform(.type("x"), allowed: ScreenAllowed(apps: [entry], signing: signing))
    }
    #expect(input.posted.isEmpty)
    signing.refusePIDs = []
    #expect(try core.perform(.type("x"), allowed: ScreenAllowed(apps: [entry], signing: signing)) == 1)
  }

  @Test func theWordsNoLongerSayTalosCannotBeControlled() {
    #expect(!ScreenAllowedAppsModel.explainer.contains("never on this list"))
    #expect(ScreenAllowedAppsModel.explainer.contains("approval card or a permission prompt"))
    for r in [ScreenRefusal.protectedPrompt, .appNotAllowed(app: ScreenCore.talosBundleID)] {
      #expect(!r.reason.contains("Talos itself"), "\(r.reason)")
    }
  }

  /// A screenshot with Talos allowed shows Talos's windows; with Talos off the list they are a gap, like any other app's.
  @Test func captureIncludesTalosWindowsOnceAllowed() async throws {
    let talosWindow = ScreenWindow(id: 40, ownerBundleID: ScreenCore.talosBundleID, ownerPID: 777, frame: CGRect(x: 40, y: 40, width: 150, height: 100))
    let content = ScreenContent(
      displays: [Fx.display], windows: [talosWindow, Fx.secretWindow, Fx.notesWindow, Fx.wallpaper], mainDisplayID: 1)
    var colours = Fx.colours
    colours[40] = .allowed
    let core = Fx.core(capture: FakeCapture(content, colours: colours))
    let with = try await core.agentCapture(allowedBundleIDs: ["com.example.notes", ScreenCore.talosBundleID])
    #expect(with.shownApps == ["com.example.notes", ScreenCore.talosBundleID].sorted())
    #expect(with.hiddenWindows == 1, "the secret app's window only")
    let without = try await core.agentCapture(allowedBundleIDs: ["com.example.notes"])
    #expect(without.shownApps == ["com.example.notes"])
    #expect(without.hiddenWindows == 2, "Talos is a gap like any app not on the list")
    // a window of Talos, named by id
    let one = try await core.agentCapture(allowedBundleIDs: [ScreenCore.talosBundleID], area: .window(40))
    #expect(one.shownApps == [ScreenCore.talosBundleID])
    await #expect(throws: ScreenRefusal.appNotAllowed(app: ScreenCore.talosBundleID, subject: .running(pid: 777))) {
      _ = try await core.agentCapture(allowedBundleIDs: ["com.example.notes"], area: .window(40))
    }
  }

  /// R1-2: a window the app marks secret (the one holding the sign-in setup link) is a gap in every agent screenshot, even when its
  /// app is allowed, and cannot be asked for by id.
  @Test func aSecretWindowIsNeverInAnAgentScreenshot() async throws {
    let secret = ScreenWindow(id: 41, ownerBundleID: ScreenCore.talosBundleID, ownerPID: 777, frame: CGRect(x: 60, y: 60, width: 150, height: 100))
    let other = ScreenWindow(id: 40, ownerBundleID: ScreenCore.talosBundleID, ownerPID: 777, frame: CGRect(x: 220, y: 60, width: 100, height: 100))
    let content = ScreenContent(displays: [Fx.display], windows: [secret, other, Fx.notesWindow, Fx.wallpaper], mainDisplayID: 1)
    var colours = Fx.colours
    colours[41] = .magenta
    colours[40] = .allowed
    var core = Fx.core(capture: FakeCapture(content, colours: colours))
    let talos: Set<String> = ["com.example.notes", ScreenCore.talosBundleID]
    let before = try await core.agentCapture(allowedBundleIDs: talos)
    #expect(before.hiddenWindows == 0)
    core.secretWindows = { [41] }
    let shot = try await core.agentCapture(allowedBundleIDs: talos)
    #expect(shot.hiddenWindows == 1, "the secret window is a gap")
    await #expect(throws: ScreenRefusal.windowNotFound(41)) {
      _ = try await core.agentCapture(allowedBundleIDs: talos, area: .window(41))
    }
    let ok = try await core.agentCapture(allowedBundleIDs: talos, area: .window(40))
    #expect(ok.shownApps == [ScreenCore.talosBundleID])
    // the registry the app writes to
    ScreenSecretWindows.set(4242, hidden: true)
    #expect(ScreenSecretWindows.current.contains(4242))
    ScreenSecretWindows.set(4242, hidden: false)
    #expect(!ScreenSecretWindows.current.contains(4242))
  }
}
