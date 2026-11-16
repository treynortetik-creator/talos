import Foundation
import Testing
@testable import TalosDesktopCore

/// After a pointer's Enter (`EnterDetection`): each read of the pane is one class, and the Enter is flagged when Talos's line is still in
/// the box `laterDelay` on, or when a select that was not there before the Enter shows right after it or later. Real captures where there
/// are some; the box rows as Claude Code draws them.
@Suite("Enter detection")
struct EnterDetectionTests {
  static let rule = KeyGuardTests.rule
  static let ours = ["⏺ Done.", rule, "❯\u{00A0}" + PointerTyper.text, rule, "  ? for shortcuts"]
  static let empty = ["⏺ Done.", rule, "❯\u{00A0}", rule, "  ? for shortcuts"]
  static let draft = ["⏺ Done.", rule, "❯\u{00A0}fix the build", rule, "  ? for shortcuts"]

  @Test func eachReadIsOneClass() throws {
    #expect(EnterDetection.classify(nil) == .unreadable)
    #expect(EnterDetection.classify([]) == .none)
    #expect(EnterDetection.classify(["⏺ Working…"]) == .none)
    #expect(EnterDetection.classify(Self.empty) == .boxEmpty)
    #expect(EnterDetection.classify(Self.ours) == .boxOurs)
    #expect(EnterDetection.classify(Self.draft) == .boxOther)
    #expect(EnterDetection.classify(Self.ours.map { $0.replacingOccurrences(of: "inbound.", with: "inbound. and more") }) == .boxOther)
    #expect(EnterDetection.classify(try KeyGuardTests.capture("real-2.1.318/empty-input.txt")) == .boxEmpty)
    #expect(EnterDetection.classify(try KeyGuardTests.capture("real-2.1.318/bash-permission.txt")) == .prompt)
    #expect(EnterDetection.classify(try KeyGuardTests.capture("real-2.1.318/trust-dialog.txt")) == .dialog)
    #expect(EnterDetection.classify(try KeyGuardTests.synthetic("usage-limit")) == .usageLimit)
    // the quoted menu over Claude's box is the box, not the menu
    #expect(EnterDetection.classify(try KeyGuardTests.synthetic("usage-limit-quoted")) == .boxEmpty)
  }

  @Test func flaggedOnlyForTheLineLeftInTheBoxOrANewSelect() {
    typealias C = EnterDetection.Class
    let cases: [(C, C, C, EnterDetection.Why?)] = [
      (.boxOurs, .boxEmpty, .boxEmpty, nil),  // the Enter took the line
      (.boxOurs, .none, .none, nil),  // the turn started and the box is gone from the region read
      (.boxOurs, .boxOurs, .boxEmpty, nil),  // drawn a moment late
      (.boxOurs, .boxOurs, .boxOurs, .lineStillInBox),
      (.boxOurs, .boxEmpty, .boxOurs, .lineStillInBox),
      (.boxOurs, .prompt, .boxEmpty, .promptAppeared),
      (.boxOurs, .boxEmpty, .prompt, nil),  // the Enter went into the box: a select later is the turn's own (mid-turn send)
      (.boxOurs, .boxOther, .prompt, .promptAppeared),
      (.boxOurs, .dialog, .dialog, .promptAppeared),
      (.boxOurs, .usageLimit, .usageLimit, .promptAppeared),
      (.boxOurs, .prompt, .boxOurs, .lineStillInBox),  // both hold: the first in order
      (.boxOurs, .unreadable, .boxEmpty, nil),  // an unreadable read is neither
      (.boxOurs, .unreadable, .unreadable, nil),
      (.boxOurs, .boxOther, .boxOther, nil),
      (.prompt, .prompt, .prompt, nil),  // there before the Enter: not one that appeared
      (.unreadable, .prompt, .boxEmpty, .promptAppeared),
      (.prompt, .dialog, .boxEmpty, nil),  // a select already up before the Enter: no new one (the guard refuses that Enter anyway)
    ]
    for (pre, after, later, want) in cases {
      #expect(EnterDetection.judge(pre: pre, after: after, later: later) == want, "\(pre) \(after) \(later)")
    }
    // a slow redraw: `later` still showed our line, and the read at `slowDelay` decides
    #expect(EnterDetection.judge(pre: .boxOurs, after: .boxOurs, later: .boxOurs, latest: .boxEmpty) == nil)
    #expect(EnterDetection.judge(pre: .boxOurs, after: .boxOurs, later: .boxOurs, latest: .boxOurs) == .lineStillInBox)
    #expect(EnterDetection.judge(pre: .boxOurs, after: .boxOurs, later: .boxOurs, latest: .prompt) == .promptAppeared)
    #expect(EnterDetection.judge(pre: .boxOurs, after: .boxEmpty, later: .boxOurs, latest: .prompt) == nil, "after the box emptied")
    #expect(EnterDetection.slowDelay == 1.0 && EnterDetection.laterDelay == 0.3)
  }

  /// The shared vectors (Fixtures/enter-detection-vectors.json, the Linux supervisor's enter-check.ts is held to the same file): each
  /// capture's class and the verdict, on plain rows (null: unreadable).
  @Test func theSharedVectorsGiveTheSameClassesAndVerdict() throws {
    struct Vector: Decodable {
      struct Classes: Decodable { var pre: String; var after: String; var later: String; var latest: String? }
      var name: String
      var pre: [String]?
      var after: [String]?
      var later: [String]?
      /// The look at `slowDelay`: nil when not taken (the key absent), `.some(nil)` when taken and unreadable (null).
      var latest: [String]??
      var flagged: Bool
      var why: String?
      var classes: Classes
      enum CodingKeys: String, CodingKey { case name, pre, after, later, latest, flagged, why, classes }
      init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        pre = try c.decodeIfPresent([String].self, forKey: .pre)
        after = try c.decodeIfPresent([String].self, forKey: .after)
        later = try c.decodeIfPresent([String].self, forKey: .later)
        latest = c.contains(.latest) ? .some(try c.decodeIfPresent([String].self, forKey: .latest)) : nil
        flagged = try c.decode(Bool.self, forKey: .flagged)
        why = try c.decodeIfPresent(String.self, forKey: .why)
        classes = try c.decode(Classes.self, forKey: .classes)
      }
    }
    struct File: Decodable { var vectors: [Vector] }
    let url = KeyGuardTests.fixtures.appendingPathComponent("enter-detection-vectors.json")
    let file = try JSONDecoder().decode(File.self, from: Data(contentsOf: url))
    #expect(file.vectors.count == 11)
    for v in file.vectors {
      let c = (EnterDetection.classify(v.pre), EnterDetection.classify(v.after), EnterDetection.classify(v.later))
      let latest = v.latest.map { EnterDetection.classify($0) }
      #expect([c.0.rawValue, c.1.rawValue, c.2.rawValue] == [v.classes.pre, v.classes.after, v.classes.later], "\(v.name)")
      #expect(latest?.rawValue == v.classes.latest, "\(v.name)")
      // the slow look is taken exactly when the 300 ms look still shows our line
      #expect((v.latest != nil) == (c.2 == .boxOurs), "\(v.name): latest taken when, and only when, later is box_ours")
      let why = EnterDetection.judge(pre: c.0, after: c.1, later: c.2, latest: latest)
      #expect((why != nil) == v.flagged && why?.rawValue == v.why, "\(v.name): \(String(describing: why))")
    }
  }

  /// Claude Code draws its input box from column 0: a frame drawn indented is never the box, whatever it holds.
  @Test func anIndentedFrameIsNeverTheBox() {
    let rule = Self.rule
    #expect(KeyGuard.allows(["⏺ Done.", rule, "❯\u{00A0}", rule], intent: .box(.empty)), "control")
    #expect(KeyGuard.refusal(["⏺ Done.", "  " + rule, "  ❯\u{00A0}", "  " + rule], intent: .box(.empty))?.why == "box_not_at_column_0")
    #expect(KeyGuard.refusal(["⏺ Done.", rule, "  ❯\u{00A0}", rule], intent: .box(.empty))?.why == "box_not_at_column_0")
    #expect(KeyGuard.refusal(["⏺ Done.", " " + rule, "❯\u{00A0}" + PointerTyper.text, rule], intent: .box(.ours))?.why == "box_not_at_column_0")
  }

  /// The guard for a box key reads the whole pane: a prompt or dialog anywhere on it, the box drawn below included, gets no key.
  @Test func aBoxKeyNeverGoesWhileASelectIsUpAnywhere() throws {
    #expect(KeyGuard.allows(Self.ours, intent: .box(.ours)), "control: our line in the box")
    #expect(KeyGuard.allows(Self.empty, intent: .box(.empty)), "control: the empty box")
    let bash = try KeyGuardTests.capture("real-2.1.318/bash-permission.txt")
    #expect(KeyGuard.refusal(bash, intent: .box(.ours)) != nil)
    let trust = try KeyGuardTests.capture("real-2.1.318/trust-dialog.txt")
    #expect(KeyGuard.refusal(trust, intent: .box(.ours)) != nil)
    #expect(KeyGuard.selectUp(trust.map(InputBoxAttributes.stripEscapes)) && KeyGuard.selectUp(bash.map(InputBoxAttributes.stripEscapes)))
    // the sign-in reminder under the box is a status row, not a select: our line still takes its Enter
    #expect(KeyGuard.allows(Self.ours + ["  Not logged in · Run /login"], intent: .box(.ours)))
    #expect(!KeyGuard.selectUp(Self.ours + ["  Not logged in · Run /login"]))
  }
}
