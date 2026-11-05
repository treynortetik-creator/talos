// swift-tools-version: 6.0
// TalosShareCore: the share sheet's logic, Foundation only, so it tests on the Mac without Xcode or a device.
// WP-I1 of docs/IOS-SPEC.md. The share extension target (WP-I3b) depends on this package; nothing here imports UIKit.
import PackageDescription

let package = Package(
    name: "TalosShareCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "TalosShareCore", targets: ["TalosShareCore"])],
    targets: [
        .target(name: "TalosShareCore"),
        .testTarget(
            name: "TalosShareCoreTests",
            dependencies: ["TalosShareCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
