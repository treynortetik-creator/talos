import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("The Talos channel beside the owner's own, and in every command shown")
struct MainChannelFlagSavedTests {
  let flag = "--dangerously-load-development-channels"
  let ours = "server:talos-app"

  private func count(_ args: [String], _ x: String) -> Int { args.filter { $0 == x }.count }

  // MARK: gap 1: another channel

  @Test func aSpaceFormOtherChannelStaysAndOursJoinsItsFlag() {
    let out = MainChannelFlag.ensured([flag, "server:other", "--model", "opus"])
    #expect(out == [flag, ours, "server:other", "--model", "opus"])
    #expect(count(out, flag) == 1, "one flag")
    #expect(Set(AutoConfirmGuard.channels(inArgv: out)) == ["server:other", ours])
  }

  @Test func anEqualsFormOtherChannelStaysAndOursIsAdded() {
    let out = MainChannelFlag.ensured(["\(flag)=server:other", "--model", "opus"])
    #expect(out.first == "\(flag)=server:other", "theirs is never replaced or moved")
    #expect(Set(AutoConfirmGuard.channels(inArgv: out)) == ["server:other", ours])
    #expect(count(out, ours) == 1)
  }

  @Test func severalOtherChannelsAllStay() {
    let out = MainChannelFlag.ensured([flag, "server:a", "server:b"])
    #expect(Set(AutoConfirmGuard.channels(inArgv: out)) == ["server:a", "server:b", ours])
    #expect(count(out, "server:a") == 1 && count(out, "server:b") == 1)
  }

  @Test func ifOursIsAlreadyThereNothingChanges() {
    for a in [
      [flag, ours], [flag, ours, "--model", "opus"], [flag, "server:other", ours], ["\(flag)=\(ours)"], ["\(flag)=server:other", flag, ours],
      ["--model", "opus", flag, ours, "--", "hello"],
    ] {
      #expect(MainChannelFlag.ensured(a) == a, "\(a)")
    }
  }

  @Test func neverTwice() {
    for a in [[], ["--model", "opus"], [flag, "server:other"], ["\(flag)=server:other"], ["--model"], ["--", flag, ours]] {
      let e = MainChannelFlag.ensured(a)
      #expect(MainChannelFlag.ensured(e) == e, "idempotent: \(a)")
      let before = Array(e.prefix(while: { $0 != "--" }))  // what follows the dashes is the prompt
      #expect(count(before, ours) + before.filter { $0 == "\(flag)=\(ours)" }.count == 1, "exactly once: \(e)")
    }
  }

  @Test func aFlagAfterTheDashesIsThePromptAndOursIsStillAdded() {
    let out = MainChannelFlag.ensured(["--model", "opus", "--", flag, "server:other"])
    #expect(out == ["--model", "opus", flag, ours, "--", flag, "server:other"])
  }

  // MARK: gap 2: the saved command, Copy Terminal text and rollback

  private func config(_ args: [String]) -> DesktopConfig {
    var c = DesktopConfig.defaults
    c.agentDir = "/home/alex/agent"
    c.claudePath = "auto"
    c.args = args
    return c
  }

  @Test func theRollbackCommandAndTheCopyTextCarryTheFlag() {
    let c = config(["--dangerously-skip-permissions"])
    let spec = LaunchSpec.rollback(c, home: "/home/alex")
    #expect(spec.args == ["--dangerously-skip-permissions", flag, ours])
    let text = spec.render()
    #expect(text.contains("\(flag) \(ours)"), Comment(rawValue: text))
    #expect(count(spec.args, ours) == 1)
    // with the owner's own channel: kept, ours beside it
    let other = LaunchSpec.rollback(config([flag, "server:other"]), home: "/home/alex")
    #expect(other.args == [flag, ours, "server:other"])
    // one that has it already: unchanged
    #expect(LaunchSpec.rollback(config([flag, ours]), home: "/home/alex").args == [flag, ours])
  }

  @Test func theSessionBoxShowsTheSavedCommandWithTheFlag() {
    let c = config(["--model", "opus"])
    #expect(LaunchEdit.line(for: c).contains("\(flag) \(ours)"))
    #expect(LaunchEdit.evaluate(LaunchEdit.line(for: c), against: c, home: "/home/alex") == .unchanged)
  }

  @Test func aLineSavedFromTheBoxCarriesItAndDeletingItChangesNothing() {
    let c = config([flag, ours, "--x"])
    guard case .updated(_, let args) = LaunchEdit.evaluate("claude --y", against: c, home: "/home/alex") else {
      Issue.record("not updated")
      return
    }
    #expect(args == ["--y", flag, ours] || args == [flag, ours, "--y"], "\(args)")
    #expect(count(args, ours) == 1)
    #expect(LaunchEdit.evaluate("claude --x", against: c, home: "/home/alex") == .unchanged, "deleted from the box: kept")
    guard case .updated(_, let withOther) = LaunchEdit.evaluate("claude \(flag) server:other", against: c, home: "/home/alex") else {
      Issue.record("not updated")
      return
    }
    #expect(Set(AutoConfirmGuard.channels(inArgv: withOther)) == ["server:other", ours], "their channel stays, ours joins")
  }

  @Test func adoptAndThePickerKeepOrAddIt() {
    let plan = AdoptPlan(pid: 1, agentDir: "/home/alex/agent", claudePath: "claude", args: ["--dangerously-skip-permissions"], env: [:], sessionId: nil, envReadable: true)
    #expect(plan.applied(to: DesktopConfig.defaults, home: "/home/alex").args == ["--dangerously-skip-permissions", flag, ours])
    func saved(_ mode: PermissionMode, _ args: [String]) -> [String] {
      guard case .updated(let a) = PermissionModeSetting.evaluate(mode, against: config(args), addsChannelsFlag: true) else { return args }
      return a
    }
    let picked = saved(.ask, ["--dangerously-skip-permissions"])
    #expect(picked == ["--permission-mode", "default", flag, ours])
    #expect(saved(.bypass, picked) == ["--dangerously-skip-permissions", flag, ours], "kept across a rewrite, once")
    #expect(count(saved(.auto, [flag, ours, "--permission-mode", "plan"]), ours) == 1)
  }

  // MARK: threads

  @Test func aThreadSessionNeverGetsItEvenWhenMainHasIt() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let spec = try WorkerSpec.build(fenceInputs(t, flag: nil, mainArgs: [flag, ours, "--dangerously-skip-permissions"]))
    #expect(!spec.args.contains(flag) && !spec.args.contains(ours), "\(spec.args)")
    #expect(throws: WorkerSpec.BuildError.self) {
      var bad = spec
      bad.args.append(contentsOf: [flag, ours])
      try bad.validate()
    }
  }
}
