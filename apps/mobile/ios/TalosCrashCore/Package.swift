// swift-tools-version: 5.9
import PackageDescription

// What the crash plugin decides, with no MetricKit or UIKit import so `swift test` runs on any Mac: turning the JSON of an
// MXDiagnosticPayload into short, content-free summaries, and keeping the waiting list short. The app target supplies the
// real MetricKit subscriber behind it (docs/ERRORS.md).
let package = Package(
    name: "TalosCrashCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "TalosCrashCore", targets: ["TalosCrashCore"])
    ],
    targets: [
        .target(name: "TalosCrashCore"),
        .testTarget(
            name: "TalosCrashCoreTests",
            dependencies: ["TalosCrashCore"],
            resources: [.copy("Fixtures")])
    ]
)
