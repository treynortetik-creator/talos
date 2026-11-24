import Foundation

/// Claude Code's usage-limit menu: when the session hits a limit, Claude Code shows a select titled "What do you want to do?" whose options
/// include ways to wait ("Stop and wait for limit to reset", "Wait here, then continue automatically ...") and ways that cost money or change
/// the plan ("Add funds to continue with usage credits", "Switch to usage ...", "Adjust monthly spend limit", "Upgrade your plan ...", "Ask your
/// admin for more usage"). Talos never presses a row of this menu (no Enter, no digit, no arrow) and, failing safe, no key goes to ANY select
/// Talos cannot name (`KeyGuard`). The ONE exception is an owner's tap on its card (`PaneSelect.Kind.usageLimit`): `Stop and wait` is Escape
/// (the menu's own `Esc to cancel`), `Switch model` is Escape, then `/model` and Enter on the idle prompt, each key checked by its own
/// intent (`KeyGuard.Intent.usageLimit`). The card says which limit and when it resets, in Talos's own words.
///
/// Recognised by its STRUCTURE, not its headline (which varies: a model's limit, the weekly or 5-hour limit, a team's shared budget, a trial
/// that ended), the same rule as the Linux supervisor's reader (apps/bridge/src/supervisor/usage-limit.ts): in the bottom rows, the title row
/// (or, when the menu is drawn without one, the last headline row: "hit your" or "reached your", and a limit or a budget), below it numbered
/// options from 1 with the one `❯` cursor on one of them, at least one option of a known waiting or paying form (`optionForms`, wrapped rows
/// joined), and the menu not sitting above Claude's own input-box frame (a conversation that quotes the menu ends in that box; the rows
/// under the box never decide it, `inputBoxFrameBelow`). Rows under the options (a footer, a hint, a status row) do not matter. The headline above the title, when there is one, gives the model and the reset.
///
/// No real capture of it is in the fixtures yet (Tests/Fixtures/synthetic/usage-limit*.txt are built from the CLI's own strings, read from
/// the 2.1.323 binary, and say SYNTHETIC).
public enum UsageLimitScreen {
  /// What the screen says, in Talos's own words: both are rebuilt from a fixed list (`models`) and from numbers, never copied from the
  /// screen, so a line built from them may be posted as the Mac's own row.
  public struct Info: Equatable, Sendable {
    /// The model family (and version, digits only) the headline names, e.g. "Fable" or "Opus 5.5"; nil when it names none ("session").
    public var model: String?
    /// When the limit resets, as the screen says it (a day, a clock time, a time zone the system knows), e.g. "Aug 8, 4pm"; nil if none.
    public var resets: String?
    public init(model: String? = nil, resets: String? = nil) {
      self.model = model
      self.resets = resets
    }
  }

  /// The needs-you name of the screen (`needs_you.kind` in workers.json and main-restart-check.json).
  public static let kind = "usage limit"
  /// The model families a headline may name. Anything else in that place ("session", "weekly", "monthly spend") is no model.
  static let models = ["Opus", "Sonnet", "Haiku", "Fable", "Mythos"]
  static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  /// The menu's title, lower-cased.
  static let title = "what do you want to do"
  /// The option forms that wait, pay or change the plan (the CLI's own words, lower-cased, matched as parts of an option's text). The same
  /// list as the Linux reader's OPTION_FORMS.
  static let optionForms = [
    "wait for limit to reset", "stop and wait", "wait here", "usage credits", "add funds", "switch to usage", "continue with usage",
    "spend limit", "upgrade your plan", "upgrade to", "ask your admin",
  ]

  /// The menu as the card needs it: what it says (`info`), its numbered rows as drawn, the row of the cursor, and whether it says `Esc to cancel`.
  public struct Menu: Equatable, Sendable {
    public var info: Info
    /// Each option as drawn (`1. Stop and wait for limit to reset`), the cursor mark dropped and a wrapped option's rows joined with a space.
    public var rows: [String]
    public var cursor: Int
    /// The menu's own footer says Esc cancels it: the one key a card may press on it.
    public var escCancels: Bool
  }

  /// The words on a usage-limit card's two buttons. `Stop and wait` is Escape; `Switch model` is Escape, then `/model`. Neither is a row of the
  /// menu that spends anything.
  public static let waitLabel = "Stop and wait"
  public static let switchLabel = "Switch model"
  /// How far a Switch model got when it stopped before Enter: Escape went, so it is never "nothing pressed". The words are the card's own
  /// (`DIALOG_WORDING.usageStopped` in the protocol).
  public enum Stop: String, Sendable, Equatable {
    /// The menu is closed; `/model` was not typed (or could not be seen typed).
    case closed
    /// `/model` was typed and is still in the box.
    case typed
    /// `/model` was typed and Backspaces took it out again.
    case cleared
    public var text: String {
      switch self {
      case .closed: return "Closed the limit menu. Switch model at the Mac."
      case .typed: return "Closed the limit menu; /model was typed but not sent. Finish at the Mac or clear it."
      case .cleared: return "Closed the limit menu; /model was typed and cleared again. Switch model at the Mac."
      }
    }
  }

  /// What `/model` is typed as, and the only text a usage-limit answer ever types.
  public static let modelCommand = "/model"

  /// The buttons the screen really offers: Escape cancels the menu only when its footer says so; switching a model is offered only when the
  /// headline names a model (a session, weekly or shared-budget limit is not lifted by another model). Empty: no card.
  public static func offered(_ m: Menu) -> [String] {
    guard m.escCancels else { return [] }
    return buttons(model: m.info.model)
  }

  /// The two buttons, by whether the headline names a model (the one place that says which a card has).
  public static func buttons(model: String?) -> [String] { model == nil ? [waitLabel] : [waitLabel, switchLabel] }

  /// What the card says the limit is, in plain words, from Talos's own rebuilt values: never screen text.
  public static func subject(_ i: Info) -> String {
    let what = i.model.map { "\($0) limit reached." } ?? "Usage limit reached."
    let when = i.resets.map { "It resets \($0)." } ?? "The screen doesn't say when it resets."
    return "\(what) \(when)"
  }

  /// The screen, or nil. `region`: the bottom rows looked at (a narrow pane wraps the menu over more rows).
  public static func read(_ rows: [String], region: Int = 40) -> Info? { readMenu(rows, region: region)?.info }

  public static func readMenu(_ rows: [String], region: Int = 40) -> Menu? {
    var raw = rows
    while let l = raw.last, l.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { raw.removeLast() }
    let tail = Array(raw.suffix(region))
    let bottom = tail.map(DialogMatcher.clean)
    guard !bottom.isEmpty else { return nil }
    // the anchor: the last title row, else (a menu drawn without its title) the last headline row; the numbered options are below it (a
    // numbered list in the conversation above is not one of them)
    let titled = bottom.lastIndex { $0.lowercased().contains(title) }
    guard let anchor = titled ?? bottom.lastIndex(where: isHeadline) else { return nil }
    // the options run from the anchor to the end, or to the next solid rule (a frame drawn below the menu is not part of it)
    let end = ((anchor + 1)..<bottom.count).first { DialogMatcher.isFrameRule(tail[$0]) } ?? bottom.count
    let options = ((anchor + 1)..<end).filter { optionNumber(bottom[$0]) != nil }
    guard options.count >= 2, let last = options.last, options.compactMap({ optionNumber(bottom[$0]) }) == Array(1...options.count) else {
      return nil
    }
    // the one cursor from the anchor to the last option, on an option (an input box drawn under the menu has its own cursor row, below the
    // options: it neither hides the menu nor counts; the owner's messages above are drawn with `❯` too)
    let cursors = (anchor...last).filter { DialogMatcher.isHighlighted(bottom[$0]) }
    guard cursors.count == 1, options.contains(cursors[0]) else { return nil }
    // each option's text with its wrapped rows (the rows up to the next option, or a blank row)
    let drawn = options.enumerated().map { k, r -> String in
      let stop = k + 1 < options.count ? options[k + 1] : bottom.count
      var parts: [String] = []
      var i = r
      while i < stop, i == r || !bottom[i].isEmpty {
        parts.append(bottom[i])
        i += 1
      }
      return parts.joined(separator: " ")
    }
    let texts = drawn.map { $0.lowercased() }
    guard texts.contains(where: { t in optionForms.contains { t.contains($0) } }) else { return nil }
    // a menu quoted in the conversation: Claude's own input-box frame is BELOW it, the menu's rows above that frame's top rule. Decided
    // from the menu and that frame alone, never from the rows under the box (they decide whether a key goes, `KeyGuard`, not whether the
    // menu is live: Main runs the owner's own status line)
    if inputBoxFrameBelow(tail, after: last) { return nil }
    // and a prompt or dialog live in a frame of its own below the menu (a tool's permission prompt, a select, the trust dialog) is what is
    // live: the menu above it is quoted and must not mask it. Read on the rows from the last solid rule, which hold no menu (the Linux
    // reader's Fable R5-2).
    if end < bottom.count, let rule = tail.lastIndex(where: DialogMatcher.isFrameRule) {
      let below = Array(tail[rule...])
      if PromptDetector.detect(below) != nil || DialogMatcher.liveDialog(below) != .none { return nil }
    }
    // the headline: the text rows above the title (or the headline row itself when there is no title), back to a blank row or a rule (a
    // line quoted above is not part of it)
    var h = titled != nil ? anchor - 1 : anchor
    while h >= 0, bottom[h].isEmpty { h -= 1 }
    var lines: [String] = []
    while h >= 0, !bottom[h].isEmpty, !isRule(tail[h], bottom[h]) {
      lines.insert(bottom[h], at: 0)
      h -= 1
    }
    let headline = lines.joined(separator: " ")
    let labels = drawn.map { $0.drop { $0 == DialogMatcher.Strings.pointer || $0 == " " } }.map(String.init)
    let footer = bottom[(last + 1)...].joined(separator: " ").lowercased()
    return Menu(
      info: Info(model: model(in: headline), resets: resets(in: headline)), rows: labels, cursor: options.firstIndex(of: cursors[0]) ?? 0,
      escCancels: footer.contains("esc to cancel"))
  }

  /// The limit the idle prompt still shows once the menu is gone (the headline stays above the input box): the model and the reset of the LAST
  /// headline, as `limitKey`, or nil when none is on the pane. A key that follows Escape is tied to this being the same limit the card was about.
  public static func lastLimit(_ rows: [String]) -> String? {
    let cleaned = rows.map(DialogMatcher.clean)
    guard let at = cleaned.lastIndex(where: { let l = $0.lowercased(); return l.contains("hit your") || l.contains("reached your") }) else { return nil }
    var parts: [String] = []
    var i = at
    while i < cleaned.count, parts.count < 3, !cleaned[i].isEmpty, !isRule(rows[i], cleaned[i]) {
      parts.append(cleaned[i])
      i += 1
    }
    let text = parts.joined(separator: " ")
    return limitKey(Info(model: model(in: text), resets: resets(in: text)))
  }

  /// A limit as one comparable text (the card's own model and reset words).
  public static func limitKey(_ i: Info) -> String { "\(i.model ?? "")|\(i.resets ?? "")" }

  /// Claude's own input box below row `after`: a solid rule that starts at column 0 with a row starting at column 0 with the pointer under
  /// it (a column-0 rule without one is skipped), then another solid rule at column 0. Claude Code draws its box from column 0 and every status row indented
  /// (real-2.1.323-statusline: the recorder's row and the owner's own line alike), so rules and a `❯` a status line prints never make
  /// one. The Linux reader's twin is `realBoxBelow` in apps/bridge/src/supervisor/usage-limit.ts, the same steps.
  static func inputBoxFrameBelow(_ rows: [String], after: Int) -> Bool {
    let atZero = { (i: Int) in i < rows.count && rows[i].first.map { $0 != " " } == true && DialogMatcher.isFrameRule(rows[i]) }
    var i = after + 1
    while i < rows.count {
      // a column-0 rule with no pointer row under it (a rule in the conversation) is not the box: the scan goes on below it
      if atZero(i), i + 1 < rows.count, rows[i + 1].first == DialogMatcher.Strings.pointer {
        return ((i + 2)..<max(i + 2, rows.count)).contains(where: atZero)
      }
      i += 1
    }
    return false
  }

  /// A solid frame rule, or a row of dashes alone (`╌╌╌`, `---`).
  static func isRule(_ raw: String, _ cleaned: String) -> Bool {
    DialogMatcher.isFrameRule(raw) || (cleaned.count >= 3 && cleaned.allSatisfy { "─━═╌┄┈-".contains($0) })
  }

  /// `❯ 2. Wait…` or `2. Wait…`: the option's number, or nil.
  static func optionNumber(_ cleaned: String) -> Int? {
    var s = Substring(cleaned)
    if s.first == DialogMatcher.Strings.pointer { s = s.dropFirst() }
    s = s.drop { $0 == " " }
    let digits = s.prefix { $0.isASCII && $0.isNumber }
    guard (1...2).contains(digits.count), let n = Int(digits) else { return nil }
    let rest = s.dropFirst(digits.count)
    guard rest.hasPrefix(". "), rest.count > 2 else { return nil }
    return n
  }

  static func isHeadline(_ row: String) -> Bool {
    let l = row.lowercased()
    return (l.contains("hit your") || l.contains("reached your")) && (l.contains("limit") || l.contains("budget"))
  }

  /// The model the headline names, between "your" and "limit": a family from `models`, with a version of digits after it if there is one.
  static func model(in headline: String) -> String? {
    let l = headline.lowercased()
    guard let your = l.range(of: "your ") else { return nil }
    let after = l[your.upperBound...]
    guard let limit = after.range(of: "limit") else { return nil }
    let words = after[..<limit.lowerBound].split(whereSeparator: { $0 == " " || $0 == "'" || $0 == "’" })
    for (i, w) in words.enumerated() {
      guard let family = models.first(where: { $0.lowercased() == w }) else { continue }
      if i + 1 < words.count, isVersion(words[i + 1]) { return "\(family) \(words[i + 1])" }
      return family
    }
    return nil
  }

  static func isVersion(_ w: Substring) -> Bool {
    let parts = w.split(separator: ".", omittingEmptySubsequences: false)
    return (1...3).contains(parts.count) && parts.allSatisfy { (1...3).contains($0.count) && $0.allSatisfy { $0.isASCII && $0.isNumber } }
  }

  /// When it resets: the words after "resets", read as a day ("Aug 8"), a clock time ("4pm", "3:10 PM", "15:10") and a time zone in
  /// brackets that the system knows, each optional, at least a day or a time. Rebuilt in Talos's own spelling, nothing copied.
  static func resets(in text: String) -> String? {
    guard let group = resetGroups(in: text) else { return nil }
    var parts: [String] = []
    if let mon = group(1), let day = group(2).flatMap(Int.init), (1...31).contains(day),
      let name = months.first(where: { $0.lowercased() == mon.lowercased() })
    {
      parts.append("\(name) \(day)")
    }
    if let h = group(3).flatMap(Int.init), (1...12).contains(h), let ampm = group(5)?.lowercased() {
      if let mm = group(4) {
        guard let mi = Int(mm), (0...59).contains(mi) else { return nil }
        parts.append("\(h):\(mm)\(ampm)")
      } else {
        parts.append("\(h)\(ampm)")
      }
    } else if let h = group(6).flatMap(Int.init), let mi = group(7).flatMap(Int.init), (0...23).contains(h), (0...59).contains(mi) {
      parts.append(String(format: "%02d:%02d", h, mi))
    }
    guard !parts.isEmpty else { return nil }
    var out = parts.joined(separator: ", ")
    // the system's own name for a zone it knows, never the screen's spelling
    if let zone = group(8).flatMap(TimeZone.init(identifier:)) { out += " (\(zone.identifier))" }
    return out
  }

  /// The pattern's groups for the words after "resets" (1-based, as `resetsPattern` numbers them), or nil when there is no match.
  static func resetGroups(in text: String) -> ((Int) -> String?)? {
    guard let r = text.range(of: "resets", options: .caseInsensitive) else { return nil }
    let after = String(text[r.upperBound...].prefix(120))
    let ns = after as NSString
    guard let m = resetsPattern.firstMatch(in: after, range: NSRange(location: 0, length: ns.length)) else { return nil }
    return { i in
      let g = m.range(at: i)
      return g.location == NSNotFound ? nil : ns.substring(with: g)
    }
  }

  /// The most days each month can have (February: 29, so a leap day is still a day).
  static let monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

  /// `needs_you.resets_at`: the reset `resets` names (`Info.resets`, Talos's own spelling of it), as the next such moment strictly after
  /// `read` (when the screen was read), in the zone it names, else in `zone` (the Mac's own). A day with no clock time names no moment,
  /// so it is nil, as is anything that does not parse.
  public static func resetsAt(_ resets: String?, after read: Date, zone: TimeZone) -> Date? {
    guard let resets, let group = resetGroups(in: "resets " + resets) else { return nil }
    var want = DateComponents()
    if let mon = group(1), let day = group(2).flatMap(Int.init),
      let i = months.firstIndex(where: { $0.lowercased() == mon.prefix(3).lowercased() })
    {
      guard (1...monthDays[i]).contains(day) else { return nil }
      want.month = i + 1
      want.day = day
    }
    if let h = group(3).flatMap(Int.init), (1...12).contains(h), let ampm = group(5)?.lowercased() {
      let mi = group(4).flatMap(Int.init) ?? 0
      guard (0...59).contains(mi) else { return nil }
      want.hour = h % 12 + (ampm == "pm" ? 12 : 0)
      want.minute = mi
    } else if let h = group(6).flatMap(Int.init), let mi = group(7).flatMap(Int.init), (0...23).contains(h), (0...59).contains(mi) {
      want.hour = h
      want.minute = mi
    } else {
      return nil
    }
    want.second = 0
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = group(8).flatMap(TimeZone.init(identifier:)) ?? zone
    return cal.nextDate(after: read, matching: want, matchingPolicy: .nextTime, direction: .forward)
  }

  /// After "resets": an optional "at"/"on", an optional day (a month's name or its first three letters, a day of 1 or 2 digits), an
  /// optional clock time (12-hour with am/pm, or 24-hour with minutes), an optional `(Area/City)`.
  static let resetsPattern = try! NSRegularExpression(
    pattern:
      #"^\s*(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\.?\s+(\d{1,2})(?!\d),?\s*(?:at\s+)?)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|(\d{1,2}):(\d{2})\b)?\s*(?:\(([A-Za-z_]+(?:/[A-Za-z0-9_+\-]+){1,2})\))?"#,
    options: [.caseInsensitive])

  // MARK: the lines

  static func modelWords(_ i: Info) -> String { i.model ?? "this session's model" }
  static func resetWords(_ i: Info) -> String { i.resets.map { " It resets \($0)." } ?? " The screen doesn't say when it resets." }
  /// What every line says about the keys: true whether or not a card could be made (a screen that cannot be read whole gets none).
  static let pressedNothing = "Talos pressed nothing on that screen. Its choices come as a card when Talos can read them."

  /// The thread's line (posted into the thread it is about, only when no card came for it).
  public static func threadLine(_ i: Info) -> String {
    "This thread's session hit the usage limit for \(modelWords(i)).\(resetWords(i)) \(pressedNothing)"
  }

  /// Main's line (to the default thread, posted as the Mac's own row: nothing in it is screen text).
  public static func mainLine(_ i: Info) -> String {
    "Main hit the usage limit for \(modelWords(i)).\(resetWords(i)) \(pressedNothing)"
  }

  /// The menu's needs-you line for Main (it has the label only, no model).
  public static let menuLine = "Main hit a usage limit. Talos pressed nothing on that screen; its choices come as a card when Talos can read them."

  /// The restart-stall phone line for it.
  public static let stallLine =
    "Main restarted on request and is at the usage limit. Talos pressed nothing on that screen; its choices come as a card when Talos can read them."
}

/// The usage-limit screen on one session's pane, Main's or a thread's (`UsageLimitScreen`): when an appearance starts and ends, and whether
/// the owner's line may go. One line per appearance, at most one an hour per session. An appearance ends only when the looks have missed it
/// for `goneAfter` (one torn frame is not the screen gone). Pure: the supervisor reads the pane; it never sends this screen a key.
public struct UsageLimitWatch: Equatable, Sendable {
  public static let window: Double = 3600
  public static let goneAfter: Double = 2

  public enum Change: Equatable, Sendable {
    /// Not on screen, and nothing was (or the appearance is not over yet: `fading`).
    case none
    /// A new appearance.
    case appeared
    /// The same appearance, still on screen.
    case still
    /// Missed by this look; not yet for `goneAfter`.
    case fading
    /// The appearance is over.
    case gone
  }

  public private(set) var showing = false
  private var absentSince: Double?
  public private(set) var toldAt: Double?

  public init() {}

  public mutating func look(onScreen: Bool, now: Double) -> Change {
    if onScreen {
      absentSince = nil
      if showing { return .still }
      showing = true
      return .appeared
    }
    guard showing else { return .none }
    guard let since = absentSince, now >= since else {
      absentSince = now
      return .fading
    }
    if now - since < Self.goneAfter { return .fading }
    showing = false
    absentSince = nil
    return .gone
  }

  /// Whether the owner's line may go for this appearance; when it may, it counts as told.
  public mutating func mayTellOwner(now: Double) -> Bool {
    if let t = toldAt, now - t < Self.window, t <= now + 60 { return false }
    toldAt = now
    return true
  }
}
