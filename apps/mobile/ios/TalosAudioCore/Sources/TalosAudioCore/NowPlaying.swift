import Foundation

/// Lock-screen / Control Center "Now Playing" (audit D37), with no MediaPlayer import so `swift test` runs on any Mac.
/// The app target supplies the real MPNowPlayingInfoCenter and MPRemoteCommandCenter behind `NowPlayingDriving`.

/// What the system shows. `rate` 0 is "paused" (the lock screen draws its play/pause button from it), anything above is the
/// playback speed.
public struct NowPlayingInfo: Equatable, Sendable {
    public var title: String
    public var artist: String
    /// Seconds; nil when the length is not known (Drive's spoken replies).
    public var duration: Double?
    /// Seconds; always within 0...duration when the duration is known.
    public var position: Double
    public var rate: Double

    public init(title: String, artist: String, duration: Double?, position: Double, rate: Double) {
        self.title = title
        self.artist = artist
        self.duration = duration
        self.position = position
        self.rate = rate
    }
}

/// The transport commands the page can ask to receive. Raw values are the page's MediaSession action names.
public enum RemoteAction: String, CaseIterable, Sendable {
    case play
    case pause
    case seekbackward
    case seekforward
    case nexttrack
    case previoustrack
    case seekto
}

public protocol NowPlayingDriving: AnyObject {
    func publish(_ info: NowPlayingInfo)
    /// Removes the info. After this the lock screen shows nothing of ours.
    func withdraw()
    /// Turns exactly these commands on and every other one off (an empty set turns them all off).
    func enable(_ actions: Set<RemoteAction>)
}

/// Sanitises what the page sends, keeps what is published, and turns system commands into events for the page.
/// The page is untrusted input: every number is clamped, the strings are bounded, unknown actions are dropped.
public final class NowPlayingController: @unchecked Sendable {
    public static let maxTextLength = 200
    public static let maxRate = 4.0

    private let driver: NowPlayingDriving
    private let lock = NSLock()
    private var current: NowPlayingInfo?
    private var held: Set<RemoteAction> = []

    /// Called with (action name, seekto position or nil) for each system command.
    public var emit: (String, Double?) -> Void = { _, _ in }

    public init(driver: NowPlayingDriving) { self.driver = driver }

    public var info: NowPlayingInfo? { lock.withLock { current } }
    public var enabledActions: Set<RemoteAction> { lock.withLock { held } }

    static func finite(_ v: Double?) -> Double? {
        guard let v, v.isFinite else { return nil }
        return v
    }

    static func bounded(_ s: String?) -> String {
        guard let s else { return "" }
        let trimmed = s.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
            .map(String.init).joined().trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count > maxTextLength ? String(trimmed.prefix(maxTextLength)) : trimmed
    }

    /// Publishes the info and registers the commands. A call with a title of nothing but spaces still publishes (the lock
    /// screen needs some title) under a placeholder, so a bad title never leaves the previous clip's info up.
    public func set(
        title: String?, artist: String?, duration: Double?, position: Double?, rate: Double?, actions: [String]
    ) {
        let dur = Self.finite(duration).flatMap { $0 > 0 ? $0 : nil }
        var pos = max(0, Self.finite(position) ?? 0)
        if let dur { pos = min(pos, dur) }
        let r = min(Self.maxRate, max(0, Self.finite(rate) ?? 0))
        let t = Self.bounded(title)
        let info = NowPlayingInfo(
            title: t.isEmpty ? "Talos" : t, artist: Self.bounded(artist), duration: dur, position: pos, rate: r)
        let wanted = Set(actions.compactMap(RemoteAction.init(rawValue:)))
        let changedActions: Bool = lock.withLock {
            current = info
            let changed = held != wanted
            held = wanted
            return changed
        }
        driver.publish(info)
        if changedActions { driver.enable(wanted) }
    }

    /// Moves the position and speed only (the 5 s tick, a seek, pause, a speed change). Ignored when nothing is published,
    /// so a late tick after `clear()` can never bring the lock screen back.
    public func update(duration: Double?, position: Double?, rate: Double?) {
        let next: NowPlayingInfo? = lock.withLock {
            guard var info = current else { return nil }
            if let d = Self.finite(duration), d > 0 { info.duration = d }
            var pos = max(0, Self.finite(position) ?? info.position)
            if let d = info.duration { pos = min(pos, d) }
            info.position = pos
            if let r = Self.finite(rate) { info.rate = min(Self.maxRate, max(0, r)) }
            current = info
            return info
        }
        if let next { driver.publish(next) }
    }

    public func clear() {
        let had: Bool = lock.withLock {
            let had = current != nil || !held.isEmpty
            current = nil
            held = []
            return had
        }
        if had {
            driver.withdraw()
            driver.enable([])
        }
    }

    /// A system command (lock screen, Control Center, headphones). Returns false when that action is not one the page
    /// asked for, or when nothing is published: a command arriving after `clear()` goes nowhere.
    @discardableResult
    public func handle(_ action: RemoteAction, position: Double? = nil) -> Bool {
        let ok = lock.withLock { current != nil && held.contains(action) }
        guard ok else { return false }
        if action == .seekto {
            guard let p = Self.finite(position), p >= 0 else { return false }
            emit(action.rawValue, p)
        } else {
            emit(action.rawValue, nil)
        }
        return true
    }
}
