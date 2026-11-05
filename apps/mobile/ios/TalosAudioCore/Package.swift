// swift-tools-version: 5.9
import PackageDescription

// The audio-session policy for the shell (IOS-SPEC 6.2, item E17), with no AVFoundation import so `swift test` runs on
// any Mac. The app target supplies the real AVAudioSession behind `AudioSessionDriving`.
let package = Package(
    name: "TalosAudioCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "TalosAudioCore", targets: ["TalosAudioCore"])
    ],
    targets: [
        .target(name: "TalosAudioCore"),
        .testTarget(name: "TalosAudioCoreTests", dependencies: ["TalosAudioCore"])
    ]
)
