// swift-tools-version: 5.9
import PackageDescription

// Pure-Foundation policy for the native bridge lock-down (IOS-SPEC rev 2, item I14). No WebKit or Capacitor import, so
// `swift test` runs on any Mac without Xcode project setup.
let package = Package(
    name: "BridgeGuard",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "BridgeGuard", targets: ["BridgeGuard"])
    ],
    targets: [
        .target(name: "BridgeGuard"),
        .testTarget(name: "BridgeGuardTests", dependencies: ["BridgeGuard"])
    ]
)
