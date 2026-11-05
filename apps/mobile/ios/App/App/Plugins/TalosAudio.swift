import AVFoundation
import Capacitor
import MediaPlayer
import TalosAudioCore

/// Real AVAudioSession behind the policy's seam.
final class SystemAudioSession: AudioSessionDriving {
    private let session = AVAudioSession.sharedInstance()

    func apply(_ config: SessionConfig) throws {
        var options: AVAudioSession.CategoryOptions = []
        if config.mixWithOthers { options.insert(.mixWithOthers) }
        if config.defaultToSpeaker { options.insert(.defaultToSpeaker) }
        if config.allowBluetooth { options.insert(.allowBluetoothHFP) }
        try session.setCategory(
            config.category == .playAndRecord ? .playAndRecord : .playback,
            mode: config.spokenAudio ? .spokenAudio : .default,
            options: options)
    }

    func setActive(_ active: Bool, notifyOthers: Bool) throws {
        try session.setActive(active, options: notifyOthers ? [.notifyOthersOnDeactivation] : [])
    }
}

/// Real MPNowPlayingInfoCenter / MPRemoteCommandCenter behind the Now Playing seam (audit D37). All system calls run on the
/// main queue; the controller above it is lock-protected, so a late call from the page's queue cannot interleave.
final class SystemNowPlaying: NowPlayingDriving {
    private var tokens: [RemoteAction: Any] = [:]
    /// Set once by the plugin: routes a system command to `NowPlayingController.handle`.
    var onCommand: ((RemoteAction, Double?) -> Bool)?

    func publish(_ info: NowPlayingInfo) {
        var dict: [String: Any] = [
            MPMediaItemPropertyTitle: info.title,
            MPMediaItemPropertyArtist: info.artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: info.position,
            MPNowPlayingInfoPropertyPlaybackRate: info.rate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let d = info.duration { dict[MPMediaItemPropertyPlaybackDuration] = d }
        DispatchQueue.main.async {
            let center = MPNowPlayingInfoCenter.default()
            center.nowPlayingInfo = dict
            center.playbackState = info.rate > 0 ? .playing : .paused
        }
    }

    func withdraw() {
        DispatchQueue.main.async {
            let center = MPNowPlayingInfoCenter.default()
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
        }
    }

    func enable(_ actions: Set<RemoteAction>) {
        DispatchQueue.main.async { [self] in
            let center = MPRemoteCommandCenter.shared()
            for action in RemoteAction.allCases {
                let command = self.command(for: action, in: center)
                if actions.contains(action) {
                    if tokens[action] == nil {
                        if action == .seekbackward || action == .seekforward {
                            (command as? MPSkipIntervalCommand)?.preferredIntervals = [10]
                        }
                        tokens[action] = command.addTarget { [weak self] event in
                            let position = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
                            return (self?.onCommand?(action, position) ?? false) ? .success : .noActionableNowPlayingItem
                        }
                    }
                    command.isEnabled = true
                } else {
                    if let token = tokens.removeValue(forKey: action) { command.removeTarget(token) }
                    command.isEnabled = false
                }
            }
        }
    }

    private func command(for action: RemoteAction, in center: MPRemoteCommandCenter) -> MPRemoteCommand {
        switch action {
        case .play: return center.playCommand
        case .pause: return center.pauseCommand
        case .seekbackward: return center.skipBackwardCommand
        case .seekforward: return center.skipForwardCommand
        case .nexttrack: return center.nextTrackCommand
        case .previoustrack: return center.previousTrackCommand
        case .seekto: return center.changePlaybackPositionCommand
        }
    }
}

/// `TalosAudio.setMode({mode})`: the web adapter's `audioSession.set(...)` (IOS-SPEC 6.2). The session is parked at launch
/// (category only, mixing, inactive) and activated only while a voice reply plays or a note is recorded.
/// `setNowPlaying` / `updateNowPlaying` / `clearNowPlaying` drive the lock screen and Control Center (audit D37); the system's
/// play, pause, skip and scrub commands come back to the page as `remoteCommand` events.
@objc(TalosAudioPlugin)
public class TalosAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TalosAudioPlugin"
    public let jsName = "TalosAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNowPlaying", returnType: CAPPluginReturnPromise),
    ]

    /// Shared with AppDelegate so launch configuration and later calls go through one policy. The policy has its own lock,
    /// and every call from here runs on `queue`, so ordering follows arrival.
    static let policy: AudioSessionPolicy = {
        let p = AudioSessionPolicy(driver: SystemAudioSession())
        p.onWarning = { NSLog("Talos: \($0)") }
        return p
    }()
    private static let queue = DispatchQueue(label: "app.talos.audio-session")
    private static let systemNowPlaying = SystemNowPlaying()
    /// One controller for the process, like `policy`: the page that set the info and the reset that clears it share it.
    static let nowPlaying: NowPlayingController = {
        let c = NowPlayingController(driver: systemNowPlaying)
        systemNowPlaying.onCommand = { action, position in c.handle(action, position: position) }
        return c
    }()
    private var observer: NSObjectProtocol?

    /// The page went away (reload, navigation, web content process death): give the audio route back.
    static func resetSession() {
        queue.async { policy.reset() }
        // The page that owned the lock-screen controls is gone: its controls must not outlive it.
        nowPlaying.clear()
    }

    override public func load() {
        TalosAudioPlugin.nowPlaying.emit = { [weak self] action, position in
            var data: [String: Any] = ["action": action]
            if let position { data["position"] = position }
            self?.notifyListeners("remoteCommand", data: data)
        }
        observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
        ) { note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            TalosAudioPlugin.queue.async {
                switch type {
                case .began:
                    TalosAudioPlugin.policy.interruptionBegan()
                case .ended:
                    // Take the route back only when the system says to; otherwise his music resumes on its own.
                    try? TalosAudioPlugin.policy.interruptionEnded(shouldResume: options.contains(.shouldResume))
                @unknown default:
                    break
                }
            }
        }
    }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

    @objc func setMode(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        guard let raw = call.getString("mode"), let mode = AudioMode(rawValue: raw) else {
            return call.reject("mode must be playback, paused, record or idle")
        }
        TalosAudioPlugin.queue.async {
            do {
                try TalosAudioPlugin.policy.set(mode)
                call.resolve()
            } catch {
                call.reject("audio session: \(error.localizedDescription)")
            }
        }
    }

    @objc func setNowPlaying(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        TalosAudioPlugin.nowPlaying.set(
            title: call.getString("title"), artist: call.getString("artist"),
            duration: call.getDouble("duration"), position: call.getDouble("position"), rate: call.getDouble("rate"),
            actions: (call.getArray("actions") as? [String]) ?? [])
        call.resolve()
    }

    @objc func updateNowPlaying(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        TalosAudioPlugin.nowPlaying.update(
            duration: call.getDouble("duration"), position: call.getDouble("position"), rate: call.getDouble("rate"))
        call.resolve()
    }

    @objc func clearNowPlaying(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed from this page") }
        TalosAudioPlugin.nowPlaying.clear()
        call.resolve()
    }
}
