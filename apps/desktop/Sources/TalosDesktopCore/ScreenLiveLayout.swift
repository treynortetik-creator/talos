import Carbon
import Foundation

/// The current keyboard layout, read from macOS (Text Input Sources, then `UCKeyTranslate` for each key), as a `ScreenKeyLayout`.
/// Kept for a second, since typing asks for it once per piece and the input source rarely changes.
public final class LiveKeyLayout: @unchecked Sendable {
  public static let shared = LiveKeyLayout()

  /// How long a read layout is reused.
  static let keepSeconds = 1.0
  /// How long a read waits for the main thread before typing falls back to Unicode strings.
  static let mainWaitSeconds = 1.0

  private let lock = NSLock()
  private var cached: (at: Date, layout: ScreenKeyLayout)?
  private var loggedTimeout = false

  public init() {}

  public func current() -> ScreenKeyLayout {
    lock.withLock {
      if let c = cached, Date().timeIntervalSince(c.at) < Self.keepSeconds { return c.layout }
      guard let layout = Self.onMain({ Self.read() }) else {
        // the main thread did not answer: type as Unicode strings this time, and ask again next time (nothing cached)
        if !loggedTimeout {
          loggedTimeout = true
          FileHandle.standardError.write(Data("screen_type: the keyboard layout could not be read in time; typing as Unicode strings\n".utf8))
        }
        return .empty
      }
      cached = (Date(), layout)
      return layout
    }
  }

  /// Text Input Sources must be asked on the main thread. Waits a bounded time, so a busy main thread cannot hold typing up:
  /// nil then, and typing uses Unicode strings.
  static func onMain<T: Sendable>(_ work: @escaping @Sendable () -> T) -> T? {
    if Thread.isMainThread { return work() }
    let box = LockedValue<T?>(nil)
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      box.value = work()
      done.signal()
    }
    return done.wait(timeout: .now() + mainWaitSeconds) == .success ? box.value : nil
  }

  /// The layout of the current input source, or `.empty` when that is an input method (its keys would become its own
  /// characters) or no layout data can be had.
  static func read() -> ScreenKeyLayout {
    guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
      let typeRaw = TISGetInputSourceProperty(source, kTISPropertyInputSourceType),
      Unmanaged<CFString>.fromOpaque(typeRaw).takeUnretainedValue() as String == kTISTypeKeyboardLayout as String,
      let dataRaw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return .empty }
    let data = Unmanaged<CFData>.fromOpaque(dataRaw).takeUnretainedValue()
    guard let bytes = CFDataGetBytePtr(data) else { return .empty }
    let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
    let keyboardType = UInt32(LMGetKbdType())
    return ScreenKeyLayout.build { code, shifted in
      var dead: UInt32 = 0
      var length = 0
      var chars = [UniChar](repeating: 0, count: 4)
      // no "no dead keys" option: a dead key then leaves a state, and the layout drops it (it would type an accent mark, or wait
      // for the next key)
      let status = UCKeyTranslate(
        layout, code, UInt16(kUCKeyActionDown), shifted ? UInt32(shiftKey >> 8) & 0xFF : 0, keyboardType, 0, &dead, chars.count,
        &length, &chars)
      guard status == noErr else { return nil }
      return ScreenKeyLayout.KeyOutput(text: String(utf16CodeUnits: chars, count: length), deadKeyState: dead)
    }
  }
}
