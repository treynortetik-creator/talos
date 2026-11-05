import AppKit
import CoreAudio
import CoreGraphics
import Foundation
import TalosDesktopCore

/// The companion's view of the machine (spec 2.3): microphones, Reduce Motion, Low Power, sleep and wake, a clock that
/// jumped. Nothing here asks for a permission: `kAudioDevicePropertyDeviceIsRunningSomewhere` and the idle-time query both read
/// with no prompt (spec 14, PROBE). Every listener it adds it removes in `stop()`, and `listenerCount` proves it.
@MainActor
final class CompanionSystem {
  /// Something the reducer should hear about changed.
  var onChange: (() -> Void)?
  /// The Mac woke, or the clock jumped: re-arm every deadline.
  var onWake: (() -> Void)?
  var onScreensChanged: (() -> Void)?

  private(set) var mic = MicHold()
  private(set) var micUnavailable = false
  private(set) var animationsPaused = false
  private var screensAsleep = false
  private var sessionActive = true

  private var deviceListeners: [AudioObjectID: AudioObjectPropertyListenerBlock] = [:]
  private var deviceListListener: AudioObjectPropertyListenerBlock?
  private var observers: [(NotificationCenter, NSObjectProtocol)] = []
  private var processListListener: AudioObjectPropertyListenerBlock?
  private var processListeners: [AudioObjectID: AudioObjectPropertyListenerBlock] = [:]
  private var tailTimer: Timer?
  private(set) var started = false
  /// Tests: stands in for CoreAudio's device list (nil = the query failed).
  var inputDevicesProvider: () -> [AudioObjectID]? = { CompanionSystem.inputDevices() }
  /// Tests: whether a device reads as running (playback on a device that also has an input reads as running too).
  var deviceRunningProvider: (AudioObjectID) -> Bool = { CompanionSystem.isRunning($0) }
  /// Whether any process has an input stream running; nil when the Mac can't say (then the device alone decides). A headset
  /// or interface with an input stream reads as "running somewhere" while only playing music, and without this the bubbles and
  /// beats would be held for it.
  var processInputProvider: () -> Bool? = { CompanionSystem.anyProcessRunningInput() }

  /// Listeners and observers and timers alive. Zero after `stop()`.
  var listenerCount: Int {
    deviceListeners.count + (deviceListListener == nil ? 0 : 1) + observers.count + processListeners.count + (processListListener == nil ? 0 : 1)
  }
  var processListenerCount: Int { processListeners.count }
  var timerCount: Int { tailTimer == nil ? 0 : 1 }

  static var mono: TimeInterval { ProcessInfo.processInfo.systemUptime }

  // MARK: values the reducer reads

  var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
  var lowPower: Bool { ProcessInfo.processInfo.isLowPowerModeEnabled }
  var micHeld: Bool { mic.held(mono: Self.mono) }
  var micStuck: Bool { mic.stuck(mono: Self.mono) }

  /// Seconds since the owner last touched the keyboard or mouse. `CGEventType(rawValue: ~0)` is "any event"; no permission.
  var secondsSinceInput: Double {
    guard let any = CGEventType(rawValue: ~0) else { return .infinity }
    return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
  }

  // MARK: start and stop

  func start() {
    guard !started else { return }
    started = true
    let ws = NSWorkspace.shared.notificationCenter
    let dc = NotificationCenter.default
    // These post on the workspace center; on the default center they never arrive (spec 2.3, observer traps).
    observe(ws, NSWorkspace.screensDidSleepNotification) { $0.screensAsleep = true; $0.updatePaused() }
    observe(ws, NSWorkspace.screensDidWakeNotification) { $0.screensAsleep = false; $0.updatePaused() }
    observe(ws, NSWorkspace.sessionDidResignActiveNotification) { $0.sessionActive = false; $0.updatePaused() }
    observe(ws, NSWorkspace.sessionDidBecomeActiveNotification) { $0.sessionActive = true; $0.updatePaused() }
    observe(ws, NSWorkspace.didWakeNotification) { $0.onWake?() }
    observe(ws, NSWorkspace.accessibilityDisplayOptionsDidChangeNotification) { $0.onChange?() }
    observe(dc, NSNotification.Name.NSSystemClockDidChange) { $0.onWake?() }
    observe(dc, .NSProcessInfoPowerStateDidChange) { $0.onChange?() }
    observe(dc, NSApplication.didChangeScreenParametersNotification) { $0.onScreensChanged?() }
    startMicWatch()
  }

  func stop() {
    guard started else { return }
    started = false
    for (c, o) in observers { c.removeObserver(o) }
    observers.removeAll()
    stopMicWatch()
    tailTimer?.invalidate()
    tailTimer = nil
    mic = MicHold()
    animationsPaused = false
    screensAsleep = false
    sessionActive = true
  }

  private func observe(_ center: NotificationCenter, _ name: Notification.Name, _ f: @escaping @MainActor (CompanionSystem) -> Void) {
    let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { if let self { f(self) } }
    }
    observers.append((center, token))
  }

  private func updatePaused() {
    let paused = screensAsleep || !sessionActive
    guard paused != animationsPaused else { return }
    animationsPaused = paused
    onChange?()
  }

  // MARK: microphones

  private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  }

  /// Every audio device that has an input stream, not only the default: a meeting can pick another mic.
  static func inputDevices() -> [AudioObjectID]? {
    var addr = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
    return ids.filter { id in
      var a = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
      var s: UInt32 = 0
      return AudioObjectGetPropertyDataSize(id, &a, 0, nil, &s) == noErr && s > 0
    }
  }

  /// Every audio process object (macOS 14.2 and later). nil if the query fails.
  static func processObjects() -> [AudioObjectID]? {
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
    return ids
  }

  static func processIsRunningInput(_ id: AudioObjectID) -> Bool? {
    var addr = address(kAudioProcessPropertyIsRunningInput)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return nil }
    return value != 0
  }

  static func anyProcessRunningInput() -> Bool? {
    guard let ids = processObjects() else { return nil }
    return ids.contains { processIsRunningInput($0) == true }
  }

  private static func isRunning(_ id: AudioObjectID) -> Bool {
    var addr = address(kAudioDevicePropertyDeviceIsRunningSomewhere)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr && value != 0
  }

  private func startMicWatch() {
    micUnavailable = false
    let sys = AudioObjectID(kAudioObjectSystemObject)
    // The list of devices changes when a USB mic comes and goes: re-enumerate then.
    let listBlock: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
      MainActor.assumeIsolated { self?.syncDevices() }
    }
    var addr = Self.address(kAudioHardwarePropertyDevices)
    if AudioObjectAddPropertyListenerBlock(sys, &addr, DispatchQueue.main, listBlock) == noErr {
      deviceListListener = listBlock
    } else {
      micUnavailable = true
    }
    syncDevices()
    startProcessWatch()
  }

  /// A process starting or stopping its input changes the answer even when the device was already running for playback.
  private func startProcessWatch() {
    let sys = AudioObjectID(kAudioObjectSystemObject)
    let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
      MainActor.assumeIsolated { self?.syncProcesses() }
    }
    var addr = Self.address(kAudioHardwarePropertyProcessObjectList)
    if AudioObjectAddPropertyListenerBlock(sys, &addr, DispatchQueue.main, block) == noErr { processListListener = block }
    syncProcesses()
  }

  private func syncProcesses() {
    guard started, processListListener != nil, let ids = Self.processObjects() else { return }
    for gone in processListeners.keys where !ids.contains(gone) { removeProcessListener(gone) }
    for id in ids where processListeners[id] == nil {
      let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
        MainActor.assumeIsolated { self?.micChanged() }
      }
      var addr = Self.address(kAudioProcessPropertyIsRunningInput)
      if AudioObjectAddPropertyListenerBlock(id, &addr, DispatchQueue.main, block) == noErr { processListeners[id] = block }
    }
    micChanged()
  }

  private func removeProcessListener(_ id: AudioObjectID) {
    guard let block = processListeners.removeValue(forKey: id) else { return }
    var addr = Self.address(kAudioProcessPropertyIsRunningInput)
    AudioObjectRemovePropertyListenerBlock(id, &addr, DispatchQueue.main, block)
  }

  /// Adds a listener to each input device not yet watched and drops those that went away.
  private func syncDevices() {
    guard started else { return }
    guard let devices = inputDevicesProvider() else {
      micUnavailable = true
      onChange?()
      return
    }
    for gone in deviceListeners.keys where !devices.contains(gone) { removeListener(gone) }
    for id in devices where deviceListeners[id] == nil {
      let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
        MainActor.assumeIsolated { self?.micChanged() }
      }
      var addr = Self.address(kAudioDevicePropertyDeviceIsRunningSomewhere)
      if AudioObjectAddPropertyListenerBlock(id, &addr, DispatchQueue.main, block) == noErr {
        deviceListeners[id] = block
      } else {
        micUnavailable = true
      }
    }
    micChanged()
  }

  private func removeListener(_ id: AudioObjectID) {
    guard let block = deviceListeners.removeValue(forKey: id) else { return }
    var addr = Self.address(kAudioDevicePropertyDeviceIsRunningSomewhere)
    AudioObjectRemovePropertyListenerBlock(id, &addr, DispatchQueue.main, block)  // the same block object that was added
  }

  private func stopMicWatch() {
    for id in Array(deviceListeners.keys) { removeListener(id) }
    for id in Array(processListeners.keys) { removeProcessListener(id) }
    if let b = processListListener {
      var addr = Self.address(kAudioHardwarePropertyProcessObjectList)
      AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, b)
      processListListener = nil
    }
    if let b = deviceListListener {
      var addr = Self.address(kAudioHardwarePropertyDevices)
      AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, b)
      deviceListListener = nil
    }
  }

  private func micChanged() {
    recheckMic()
  }

  /// Tests and the listeners: the answer is a device that is running AND a process that has input open (when the Mac can say).
  func recheckMic() {
    let deviceRunning = deviceListeners.keys.contains { deviceRunningProvider($0) }
    let running = deviceRunning && (processInputProvider() ?? true)
    mic.update(anyRunning: running, mono: Self.mono)
    armTail()
    onChange?()
  }

  /// One one-shot for the end of the 30 s tail (and the 3 h line); never a poll.
  private func armTail() {
    tailTimer?.invalidate()
    tailTimer = nil
    guard let d = mic.deadline(mono: Self.mono) else { return }
    let t = Timer(timeInterval: max(0.05, d - Self.mono), repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.tailTimer = nil
        self?.armTail()
        self?.onChange?()
      }
    }
    RunLoop.main.add(t, forMode: .common)
    tailTimer = t
  }

  /// Tests: feed the hold as if a device started or stopped.
  func simulateMic(running: Bool) {
    mic.update(anyRunning: running, mono: Self.mono)
    armTail()
    onChange?()
  }
}
