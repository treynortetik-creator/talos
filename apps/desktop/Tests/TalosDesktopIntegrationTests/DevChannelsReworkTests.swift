import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Review fixes for the dev-channels card: no accept option without the channel list, the signed launch_changed is compared, never a second
/// Enter, the owner's Exit mark ends with the start, a card press is not a pane Enter.
private func keyed(_ keys: KeyLog, _ extra: [String: String] = [:]) -> [String: String] {
  ["FAKE_DLG_KEYLOG": keys.path].merging(extra) { _, b in b }
}

@Suite("Dev-channels card: review fixes", .serialized)
struct DevChannelsReworkTests {
  /// A channels line that cannot be carried whole (over 500 characters) is offered with Exit only: the owner cannot accept what he cannot see.
  @Test func aChannelLineTooLongOffersNoAcceptOption() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let long = "server:talos-app, " + (0..<40).map { "server:extra-channel-\($0)" }.joined(separator: ", ")
    #expect(long.count > 500)
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys, ["FAKE_CHANNELS": long]))
    defer { r.teardown() }
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    #expect(o.subject == nil)
    #expect(o.options == ["Exit"], "\(o.options)")
    #expect(!o.options.contains("I am using this for local development"))
  }

  /// The card the owner signed said nothing of a changed launch, while the Mac's record says the launch changed (an agent edited
  /// `main_dialog` in workers.json to hide it): nothing is pressed.
  @Test func anAnswerSignedOverACardThatHidesTheLaunchChangePressesNothing() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys), launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    #expect(o.launch_changed != nil)
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1", omitLaunchChanged: true)
    #expect(r.wait(10) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unverified", "\(String(describing: r.result))")
    #expect(keys.presses.isEmpty && r.config.confirmedLaunch == nil)
  }

  /// The guard auto-confirms in the same tick the owner's tap is read: one Enter only (the dialog is slow to go, so a second would reach it).
  @Test(.enabled(if: Rig.hasTmux))
  func anOfferStillUpWhenTheGuardConfirmsGetsOneEnter() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.tmux, scenario: "dev-dialog-keys.sh", env: keyed(keys, ["FAKE_STICKY": "1"]))
    defer { r.teardown() }
    let typing = r.root + "/typing"
    let shim = r.root + "/tmux-typing-shim"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = list-clients ] && [ -e '\(typing)' ]; then date +%s; exit 0; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    FileManager.default.createFile(atPath: typing, contents: Data())
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.sup.start()  // ticks by hand: the guard's confirm and the tap are read in one tick
    let o = try #require(r.poll(40) { r.sup.tickNow(); return r.offer }, "audit: \(r.audit)")
    unlink(typing)
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    r.sup.tickNow()
    for _ in 0..<4 {
      usleep(100_000)
      r.sup.tickNow()
    }
    #expect(keys.presses == ["ENTER"], "one Enter only: \(keys.keys), audit: \(r.audit)")
    #expect(r.autoConfirms == 1)
    #expect(r.answeredEvents.isEmpty, "the tap pressed nothing")
  }

  /// The owner's Exit times out (the dialog stays), he accepts in the pane, the session runs: the mark is over, so a later crash restarts.
  @Test func anExitThatTimedOutDoesNotMakeALaterCrashAStop() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys, ["FAKE_STICKY_EXIT": "1"]), launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    try r.tap(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(10) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" })
    #expect(r.phase() == .starting, "Exit did not end the process")
    r.host.send(keys: [0x1b, 0x4f, 0x41])  // the owner: Up, then Enter, in the pane
    usleep(300_000)
    r.humanEnter()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), keys \(keys.keys), audit: \(r.audit)")
    let pid = try #require(r.sup.status.childPid)
    kill(pid, SIGKILL)
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count >= 2 }, "a crash restarts: \(r.phase()), audit: \(r.audit)")
    #expect(r.phase() != .stopped(.user))
  }

  /// A tap on the card is not also a pane Enter: no `human_confirm`, no humanConfirmed event, one seal.
  @Test func aCardPressIsNotAlsoAHumanConfirm() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys), launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.config.confirmedLaunchMac != nil }, "\(r.phase())")
    for _ in 0..<5 {
      usleep(150_000)
      r.sup.tickNow()
    }
    #expect(!r.audit.contains("human_confirm"), "audit: \(r.audit)")
    #expect(!r.allEvents.contains { if case .humanConfirmed = $0 { return true } else { return false } })
    #expect(r.config.session.confirmedAt != nil, "the first-start row is still satisfied")
  }
}
