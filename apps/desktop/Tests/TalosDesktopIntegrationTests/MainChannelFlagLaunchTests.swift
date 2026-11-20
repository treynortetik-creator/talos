import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// A launch command saved or imported without the channels flag still starts Main with it, and so does the restart after an update.
/// Real pty, the fake `claude`; every wait only caps a hang.
@Suite("Main always passes the channels flag (real pty)", .serialized)
struct MainChannelFlagLaunchTests {
  @Test func aCommandWithoutTheFlagStartsWithItAndKeepsItAcrossTheRestart() throws {
    let r = try Rig(
      .direct, scenario: "dev-dialog.sh", timings: Rig.defaultTimings(),
      configure: { c in
        c.args = ["--dangerously-skip-permissions"]  // imported by hand: no channels flag
        c.autoConfirmRestart = false
      })
    defer { r.teardown() }
    r.tuneOptions = { $0.addsChannelsFlag = true }  // as the app sets it
    _ = r.makeSupervisor()
    r.start()
    #expect(r.wait(30) { r.starts.count >= 1 }, "started: \(r.audit)")
    let first = try #require(r.starts.first)
    #expect(first.contains("--dangerously-load-development-channels") && first.contains("server:talos-app"), "first start: \(first)")
    #expect(r.config.args == ["--dangerously-skip-permissions", MainChannelFlag.flag, "server:talos-app"], "the saved command carries the flag too, once: \(r.config.args)")
    #expect(r.audit.contains("channels_flag_saved"), "audit: \(r.audit)")
    // the update's restart is the same cold restart (`Supervisor.restartMain(onto:)` calls `restartCold`)
    r.sup.restartCold()
    #expect(r.wait(30) { r.starts.count >= 2 }, "restarted: \(r.starts) \(r.audit)")
    let second = r.starts[1]
    #expect(second.contains("--dangerously-load-development-channels") && second.contains("server:talos-app"), "after the restart: \(second)")
    #expect(second.contains("--resume"), "the restart resumes the conversation")
  }

  /// An install whose launch was confirmed over its saved flags (no channels flag) before the flag was added to every launch: the owner's
  /// yes still counts. The start re-seals it once over the flags it really passes (an audit row says so), the dev warning is answered by
  /// the app as before, and Main runs with no stall. The seal then covers the launched argv.
  @Test func anInstallSealedBeforeTheFlagWasAddedRestartsWithoutAStallAndIsResealedOnce() throws {
    let r = try Rig(
      .direct, scenario: "dev-dialog.sh", timings: Rig.defaultTimings(),
      configure: { c in c.args = ["--dangerously-skip-permissions"] })  // sealed by the rig over exactly these saved flags
    defer { r.teardown() }
    r.tuneOptions = { $0.addsChannelsFlag = true }
    _ = r.makeSupervisor()
    let launched = MainChannelFlag.ensured(r.config.args)
    let claude = r.config.claudePath
    #expect(
      LaunchSeal.isConfirmed(
        r.config, fingerprint: r.config.launchFingerprint(resolvedClaude: claude), parts: r.config.launchParts(resolvedClaude: claude),
        trust: r.trust), "before: sealed over the saved flags")
    #expect(
      !LaunchSeal.isConfirmed(
        r.config, fingerprint: r.config.launchFingerprint(resolvedClaude: claude, args: launched),
        parts: r.config.launchParts(resolvedClaude: claude, args: launched), trust: r.trust), "not yet over the launched ones")
    // what the restart check says before any start: the old confirmation still counts, so an update's restart is not refused
    #expect(MainRestartCheck.seal(r.config, resolvedClaude: claude, trust: r.trust, args: launched) == .confirmed)
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "running with no stall: \(r.phase()) \(String(describing: r.sup.status.needsYou)) \(r.audit)")
    #expect(r.sup.status.needsYou == nil)
    #expect(r.audit.contains("channels_flag_reseal"), "the migration is on the record")
    #expect(r.audit.components(separatedBy: "channels_flag_reseal").count == 2, "once")
    #expect(
      LaunchSeal.isConfirmed(
        r.config, fingerprint: r.config.launchFingerprint(resolvedClaude: claude, args: launched),
        parts: r.config.launchParts(resolvedClaude: claude, args: launched), trust: r.trust), "after: the seal covers the launched argv")
    #expect(r.config.args == ["--dangerously-skip-permissions", MainChannelFlag.flag, "server:talos-app"], "the saved command carries the flag, once: \(r.config.args)")
    // the next restart (an update's) comes back with no stall and no second migration
    r.sup.restartCold()
    #expect(r.wait(30) { r.starts.count >= 2 && isRunning(r.phase()) }, "restart: \(r.phase()) \(r.audit)")
    #expect(r.audit.components(separatedBy: "channels_flag_reseal").count == 2)
  }

  /// A launch that was never confirmed stays unconfirmed: the migration only carries an owner's yes over, it never makes one.
  @Test func anInstallThatWasNeverConfirmedIsNeverSealedByTheMigration() throws {
    let r = try Rig(
      .direct, scenario: "dev-dialog.sh", timings: Rig.defaultTimings(), launchConfirmed: false,
      configure: { c in
        c.args = ["--dangerously-skip-permissions"]
        c.autoConfirmRestart = false
      })
    defer { r.teardown() }
    r.tuneOptions = { $0.addsChannelsFlag = true }
    _ = r.makeSupervisor()
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart }, "the owner is asked: \(r.audit)")
    #expect(!r.audit.contains("channels_flag_reseal") && r.config.confirmedLaunchMac == nil)
  }

  /// The permission picker's rewrite (and an agent's request) keeps the Talos channel in the saved command, once; on a supervisor that is
  /// not Main's, or with the option off, nothing is added.
  @Test func aPermissionModeChangeKeepsTheFlagInTheSavedCommandOnce() throws {
    let r = try Rig(
      .direct, scenario: "idle.sh", timings: Rig.defaultTimings(),
      configure: { c in c.args = ["--dangerously-skip-permissions"] })
    defer { r.teardown() }
    r.tuneOptions = { $0.addsChannelsFlag = true }
    _ = r.makeSupervisor()
    r.sup.changePermissionMode(.ask, restart: false)
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "default", MainChannelFlag.flag, "server:talos-app"] }, "\(r.config.args)")
    r.sup.changePermissionMode(.auto, restart: false)
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "auto", MainChannelFlag.flag, "server:talos-app"] }, "once: \(r.config.args)")
    // a command that names the flag with another channel keeps it, and ours joins it
    r.sup.mutateConfig { $0.args = [MainChannelFlag.flag, "server:other"] }
    r.sup.changePermissionMode(.bypass, restart: false)
    #expect(
      r.wait(10) { Set(AutoConfirmGuard.channels(inArgv: r.config.args)) == ["server:other", "server:talos-app"] && r.config.args.contains("--dangerously-skip-permissions") },
      "\(r.config.args)")
  }

  /// A seal over the saved flags that cannot be carried over (the Keychain is unreadable at this start) is never lost to the saved
  /// command's rewrite: nothing is written, and the next start, with the Keychain back, carries it over with no new question.
  @Test func anOldSealIsNotLostWhenTheKeychainCannotBeReadAtAStart() throws {
    let r = try Rig(
      .direct, scenario: "dev-dialog.sh", timings: Rig.defaultTimings(),
      configure: { c in c.args = ["--dangerously-skip-permissions"] })  // sealed by the rig over exactly these saved flags
    defer { r.teardown() }
    r.tuneOptions = { $0.addsChannelsFlag = true }
    _ = r.makeSupervisor()
    r.trust.available = false
    r.start()
    #expect(r.wait(30) { r.starts.count >= 1 }, "started: \(r.audit)")
    #expect(r.config.args == ["--dangerously-skip-permissions"], "the old seal is kept: nothing is written: \(r.config.args)")
    #expect(!r.audit.contains("channels_flag_saved") && !r.audit.contains("channels_flag_reseal"), Comment(rawValue: r.audit))
    r.sup.stop()
    #expect(r.wait(20) { r.sup.tickNow(); if case .stopped(.user) = r.phase() { return true } else { return false } }, "\(r.phase())")
    r.trust.available = true  // the Keychain is back
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "running with no new question: \(r.phase()) \(r.audit)")
    #expect(r.audit.contains("channels_flag_reseal"), "carried over now: \(r.audit)")
    #expect(r.config.args == ["--dangerously-skip-permissions", MainChannelFlag.flag, "server:talos-app"], "\(r.config.args)")
  }
}
