import AVFoundation
import TalosRelayCore
import UIKit
import XCTest

@testable import App

/// The scan sheet's camera box: the video layer is part of the visible box, fills it after layout whenever the session is attached
/// (even after layout has settled, as when the camera permission answer arrives late), and nothing opaque covers it.
/// A simulator has no camera, so this attaches the session directly; the real-device picture is not covered here.
@MainActor
final class AddRelayCameraPreviewTests: XCTestCase {
    private struct NoFetch: DescriptorFetching {
        func fetch(origin: URL) async throws -> RelayDescriptor { throw DescriptorFetchError.network }
    }

    private struct NoStores: RelayDataStoreAccess {
        func identifiers() async -> [UUID] { [] }
        func remove(_ id: UUID) async -> Bool { true }
        func clearDefault() async {}
    }

    private func host(status: AVAuthorizationStatus = .authorized) throws -> (AddRelayViewController, UIWindow) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "no window scene")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let flow = AddRelayFlow(fetcher: NoFetch(), attester: AddRelayFlowTests.StubAttestRunner(.verdict(.pass)), appVersion: "1.0")
        let vc = AddRelayViewController(flow: flow, runtime: RelayRuntime(store: { nil }, dataStores: NoStores(), allowBuildTime: false))
        vc.cameraStatus = { status }
        vc.requestCameraAccess = { $0(status == .authorized) }
        window.rootViewController = vc
        window.makeKeyAndVisible()
        return (vc, window)
    }

    private func videoLayer(in box: UIView) -> AVCaptureVideoPreviewLayer? {
        if let own = box.layer as? AVCaptureVideoPreviewLayer { return own }
        return box.layer.sublayers?.compactMap { $0 as? AVCaptureVideoPreviewLayer }.first
    }

    func testThePreviewFillsTheCameraBoxAfterLayoutHasSettled() throws {
        let (vc, window) = try host()
        defer { window.isHidden = true }
        vc.view.layoutIfNeeded()
        let box = vc.cameraBox
        XCTAssertEqual(box.bounds.height, 320)
        XCTAssertGreaterThan(box.bounds.width, 0)

        vc.attachSession()
        vc.view.layoutIfNeeded()

        XCTAssertNotNil(vc.cameraBox.previewLayer.session, "the capture session is not attached to the preview")
        let video = try XCTUnwrap(videoLayer(in: box), "the video layer is not part of the camera box")
        XCTAssertEqual(video.bounds.size, box.bounds.size, "the video layer does not fill the box")
        XCTAssertGreaterThan(video.bounds.width, 0)
        XCTAssertEqual(video.bounds.height, 320)
        XCTAssertEqual(video.videoGravity, .resizeAspectFill)
        XCTAssertFalse(box.isHidden)
        XCTAssertEqual(box.alpha, 1)
    }

    func testThePreviewFillsTheCameraBoxWhenTheSessionIsAttachedBeforeFirstLayout() throws {
        let (vc, window) = try host()
        defer { window.isHidden = true }
        vc.loadViewIfNeeded()
        XCTAssertEqual(vc.cameraBox.bounds.size, .zero, "the box has no size before layout")
        vc.attachSession()
        window.layoutIfNeeded()
        vc.view.layoutIfNeeded()

        let box = vc.cameraBox
        let video = try XCTUnwrap(videoLayer(in: box))
        XCTAssertEqual(video.bounds.size, box.bounds.size, "the video layer does not fill the box")
        XCTAssertGreaterThan(video.bounds.width, 0)
        XCTAssertEqual(video.bounds.height, 320)
    }

    func testTurningThePhoneWithNoCameraConnectionChangesNothing() throws {
        let (vc, window) = try host()
        defer { window.isHidden = true }
        vc.view.layoutIfNeeded()
        // A simulator has no camera, so the preview has no connection: the angle is refused, not applied. The real rotation is not covered.
        XCTAssertNil(vc.cameraBox.previewLayer.connection)
        XCTAssertFalse(vc.cameraBox.applyRotation(90))
    }

    func testAttachingTheSessionTwiceKeepsTheSameSession() throws {
        let (vc, window) = try host()
        defer { window.isHidden = true }
        vc.view.layoutIfNeeded()
        vc.attachSession()
        let first = vc.cameraBox.previewLayer.session
        vc.attachSession()
        XCTAssertTrue(vc.cameraBox.previewLayer.session === first)
    }

    func testNoCameraNoteIsAddedOnceHoweverOftenTheScannerShows() throws {
        let (vc, window) = try host()
        defer { window.isHidden = true }
        vc.view.layoutIfNeeded()
        try XCTSkipIf(AVCaptureDevice.default(for: .video) != nil, "this device has a camera")
        for _ in 0..<3 { vc.showScanner() }
        XCTAssertEqual(vc.cameraBox.subviews.count, 1, "the no-camera note was added more than once")
    }

    func testADeniedCameraShowsTheDeniedScreenAndNoCameraBox() throws {
        let (vc, window) = try host(status: .denied)
        defer { window.isHidden = true }
        vc.view.layoutIfNeeded()
        XCTAssertNil(vc.cameraBox.superview, "the camera box is gone from the denied screen")
        XCTAssertNil(vc.cameraBox.previewLayer.session)
    }

    func testNothingOpaqueSitsAboveTheVideoInsideTheBox() throws {
        let (vc, window) = try host()
        defer { window.isHidden = true }
        vc.view.layoutIfNeeded()
        vc.attachSession()
        vc.view.layoutIfNeeded()
        let box = vc.cameraBox
        let video = try XCTUnwrap(videoLayer(in: box))
        if video !== box.layer {
            let above = (box.layer.sublayers ?? []).drop { $0 !== video }.dropFirst()
            XCTAssertTrue(above.isEmpty, "a layer is drawn above the video")
        }
        // Only the "no camera" note may sit in the box, and it has no visible background.
        XCTAssertTrue(box.subviews.allSatisfy { $0 is UILabel && ($0.backgroundColor?.cgColor.alpha ?? 0) == 0 }, "a view covers the video: \(box.subviews.map { "\(type(of: $0)) \(String(describing: $0.backgroundColor))" })")
        XCTAssertEqual(box.clipsToBounds, true)
        XCTAssertEqual(box.layer.cornerRadius, 16)
    }
}
