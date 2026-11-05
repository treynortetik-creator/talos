import Foundation

/// What the page asks for. These are the strings the web adapter sends (`apps/web/src/lib/capacitorPlatform.ts`).
public enum AudioMode: String, Sendable, CaseIterable {
    /// A voice reply is playing (driving mode listening). Takes the audio route: other audio stops.
    case playback
    /// A voice note is being recorded: loudspeaker, mic, Bluetooth headset allowed.
    case record
    /// A clip is loaded and stopped (a pause, from the page or the lock screen). The session stays active and not mixing, so iOS
    /// keeps Talos as the Now Playing app: a mixing session is not eligible, and Play on the lock screen would reach Music instead.
    case paused
    /// Nothing is playing: give the route back and let other apps resume.
    case idle
}

/// The category the session is parked in. Mirrors AVAudioSession's, minus the framework.
public struct SessionConfig: Equatable, Sendable {
    public enum Category: Sendable { case playback, playAndRecord }
    public var category: Category
    /// Spoken-word mode: lets other apps' audio pause and resume around a reply.
    public var spokenAudio: Bool
    public var mixWithOthers: Bool
    public var defaultToSpeaker: Bool
    public var allowBluetooth: Bool

    public init(category: Category, spokenAudio: Bool, mixWithOthers: Bool, defaultToSpeaker: Bool = false, allowBluetooth: Bool = false) {
        self.category = category
        self.spokenAudio = spokenAudio
        self.mixWithOthers = mixWithOthers
        self.defaultToSpeaker = defaultToSpeaker
        self.allowBluetooth = allowBluetooth
    }

    /// Parked: set at launch and after every reply. Mixing, and never activated, so opening Talos does not stop his music.
    public static let parked = SessionConfig(category: .playback, spokenAudio: true, mixWithOthers: true)
    /// A reply is playing: not mixing, so it takes the route (and his podcast pauses for it).
    public static let playing = SessionConfig(category: .playback, spokenAudio: true, mixWithOthers: false)
    /// Recording a voice note.
    public static let recording = SessionConfig(
        category: .playAndRecord, spokenAudio: true, mixWithOthers: false, defaultToSpeaker: true, allowBluetooth: true)
}

/// The slice of AVAudioSession the policy needs. Every call can throw; the policy never lets that reach the page as a
/// crash, only as a rejected call.
public protocol AudioSessionDriving: AnyObject {
    func apply(_ config: SessionConfig) throws
    func setActive(_ active: Bool, notifyOthers: Bool) throws
}

/// Owns the rules: parked at launch and never active until a reply plays (E17).
///
/// Every entry point takes one lock, so the plugin's queue, the interruption observer and a page reload can call in from
/// different threads without racing on `mode`. The driver's calls (which can block) run under the lock too.
public final class AudioSessionPolicy: @unchecked Sendable {
    private let lock = NSLock()
    private let driver: AudioSessionDriving
    private var _mode: AudioMode = .idle
    private var interrupted = false
    /// A deactivate that iOS refused ("busy" while something was still playing or recording). Retried by the next call.
    private var releasePending = false
    /// Called with a short, secret-free description when a deactivate fails. The app logs it.
    public var onWarning: (@Sendable (String) -> Void)?

    public init(driver: AudioSessionDriving) { self.driver = driver }

    public var mode: AudioMode { lock.withLock { _mode } }

    /// Launch: the category only. Never activates (that is what would stop his music).
    public func configureAtLaunch() throws {
        try lock.withLock {
            try driver.apply(.parked)
            _mode = .idle
            interrupted = false
        }
    }

    public func set(_ new: AudioMode) throws {
        try lock.withLock { try setLocked(new) }
    }

    /// The page went away (reload, navigation, web process death): give the route back whatever it asked for last.
    public func reset() {
        lock.withLock { _ = try? setLocked(.idle) }
    }

    private func setLocked(_ new: AudioMode) throws {
        switch new {
        case .playback:
            try driver.apply(.playing)
            try driver.setActive(true, notifyOthers: false)
            releasePending = false
        case .paused:
            // Same category as playing; active stays on. Nothing is made to pause here: the page already stopped its audio.
            try driver.apply(.playing)
            try driver.setActive(true, notifyOthers: false)
            releasePending = false
        case .record:
            try driver.apply(.recording)
            try driver.setActive(true, notifyOthers: false)
            releasePending = false
        case .idle:
            // Idle always ends parked with mode idle, even when iOS refuses to deactivate right now: the page asked to let
            // go, so nothing here may re-take the route later. A refused deactivate is remembered and retried.
            if _mode != .idle || releasePending {
                do {
                    try driver.setActive(false, notifyOthers: true)
                    releasePending = false
                } catch {
                    releasePending = true
                    onWarning?("audio session release was refused; will retry")
                }
            }
            _mode = .idle
            interrupted = false
            try driver.apply(.parked)
            return
        }
        _mode = new
        interrupted = false
    }

    /// A phone call or Siri took the route. Web audio is paused by the system; remember that a reply was in progress.
    public func interruptionBegan() {
        lock.withLock { if _mode != .idle { interrupted = true } }
    }

    /// The interruption ended. Take the route back only when the system says to (`shouldResume`) and a reply or recording
    /// was in progress; otherwise leave the session alone so the user's music can resume.
    public func interruptionEnded(shouldResume: Bool) throws {
        try lock.withLock {
            defer { interrupted = false }
            // A paused clip does not take the route back on its own; Play does, through `set(.playback)`.
            guard interrupted, shouldResume, _mode == .playback || _mode == .record else { return }
            try setLocked(_mode)
        }
    }
}
