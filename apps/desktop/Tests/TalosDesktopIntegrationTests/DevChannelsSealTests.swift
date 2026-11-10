import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The seal on the confirmed launch (Part 2 of the dev-channels card): the guard trusts `confirmed_launch` only while its MAC verifies under a
/// key that is not in desktop.json. Anything else (a fingerprint an agent wrote, a MAC that does not verify, a key that is gone, a Keychain that
/// cannot be read) is a changed launch: the warning goes to the card, and the owner's one tap seals it again. The default suite uses the in-memory store.
private func edit(_ r: Rig, _ change: (inout DesktopConfig) -> Void) throws {
  var c = try #require(try ConfigFile.load(r.configPath))
  change(&c)
  try ConfigFile.save(c, to: r.configPath)
}

@Suite("Main's confirmed launch is sealed", .serialized)
struct DevChannelsSealTests {
  /// A sealed, unchanged launch is automatic (every other suite relies on it); the seal does not get in the way.
  @Test func aSealedLaunchIsAutomatic() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    #expect(r.config.confirmedLaunchMac != nil && r.config.launchTrust == LaunchTrustMigration.version)
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.autoConfirms == 1 && r.offer == nil)
  }

  /// An agent writes the current fingerprint into desktop.json itself: no MAC, so no trust.
  @Test func aFingerprintWrittenWithoutAMacIsRefused() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", launchConfirmed: false)
    defer { r.teardown() }
    let fp = r.config.launchFingerprint(resolvedClaude: r.config.claudePath)
    try edit(r) {
      $0.confirmedLaunch = fp
      $0.launchTrust = LaunchTrustMigration.version  // the migration has run: this is not a leftover, it is a new write
    }
    r.makeSupervisor()
    r.start()
    r.expectHeldAtNeedsYou("launchChanged")
    #expect(r.offer != nil)
  }

  /// ... with the old MAC of another launch, or a made-up one.
  @Test(arguments: ["madeUp", "ofAnotherLaunch"])
  func aMacThatDoesNotVerifyIsRefused(which: String) throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let other = try { () -> String in
      var c = DesktopConfig.defaults
      LaunchSeal.confirm(&c, fingerprint: "another-launch", parts: [:], trust: r.trust)
      return c.confirmedLaunchMac ?? ""
    }()
    try edit(r) { $0.confirmedLaunchMac = which == "madeUp" ? String(repeating: "ab", count: 32) : other }
    r.makeSupervisor()
    r.start()
    r.expectHeldAtNeedsYou("launchChanged")
  }

  /// Rewriting the fingerprint to match a launch an agent changed, keeping the old MAC: the MAC covers the fingerprint.
  @Test func aRewrittenFingerprintKeepsNoTrust() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.sup.mutateConfig { $0.args.append("--some-new-flag") }
    let changed = r.sup.currentConfig().launchFingerprint(resolvedClaude: r.config.claudePath)
    try edit(r) {
      $0.args.append("--some-new-flag")
      $0.confirmedLaunch = changed
    }
    r.makeSupervisor()
    r.start()
    r.expectHeldAtNeedsYou("launchChanged")
  }

  /// No key (a new Mac, a deleted item): fail closed; the owner's tap makes a key, seals, and the next start is automatic.
  @Test func aMissingKeyFailsClosedAndTheTapMakesANewOne() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown() }
    r.trust.dropKey()
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    #expect(o.launch_changed == [], "the launch is the same; what is missing is the key: 'not confirmed on this Mac yet'")
    #expect(r.audit.contains("reason=launchChanged"), "audit: \(r.audit)")
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.trust.hasKey, "the owner's confirm made the key")
    let c = r.config
    #expect(LaunchSeal.isConfirmed(c, fingerprint: c.launchFingerprint(resolvedClaude: c.claudePath), parts: c.launchParts(resolvedClaude: c.claudePath), trust: r.trust))
    r.sup.restartCold()
    #expect(r.wait(60) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.autoConfirms == 1, "the second start was answered by the app: \(r.audit)")
    #expect(keys.presses == ["ENTER", "ENTER"], "\(keys.keys)")
  }

  /// A Keychain that cannot be read: the same, and a tap while it cannot be used stores the fingerprint unsealed, so the next start asks again.
  @Test func aKeychainThatCannotBeReadFailsClosedAndAsksAgainNextStart() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown() }
    r.trust.available = false
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(keys.presses == ["ENTER"], "the owner's tap still answers the dialog")
    #expect(r.audit.contains("launch_seal_unavailable"), "audit: \(r.audit)")
    #expect(r.config.confirmedLaunchMac == nil)
    r.sup.restartCold()
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && r.offer != nil }, "asked again: audit \(r.audit)")
    #expect(r.autoConfirms == 0)
  }

  /// The update that brings the seal: a plain fingerprint (nothing proves who wrote it) is cleared once, the first start asks, the tap seals.
  @Test func theUpdateThatBringsTheSealAsksOnceThenNeverAgain() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", launchConfirmed: false)
    defer { r.teardown() }
    let fp = r.config.launchFingerprint(resolvedClaude: r.config.claudePath)
    try edit(r) {
      $0.confirmedLaunch = fp  // the old shape: a fingerprint, no MAC, no launch_trust
      $0.launchTrust = nil
    }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.makeSupervisor()
    #expect(r.audit.contains("launch_trust_migrated"))
    #expect(r.config.confirmedLaunch == nil && r.config.launchTrust == LaunchTrustMigration.version, "the unsealed value is cleared and the step recorded")
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    #expect(o.launch_changed == [], "it says 'not confirmed on this Mac yet', not 'changed'")
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.config.confirmedLaunchMac != nil }, "\(r.phase())")
    // an app relaunch on the same Mac: sealed, so the migration does not run again
    let ran = r.audit.components(separatedBy: "launch_trust_migrated").count
    r.makeSupervisor()
    #expect(r.audit.components(separatedBy: "launch_trust_migrated").count == ran)
    #expect(r.config.confirmedLaunchMac != nil)
  }
}
