import AVFoundation
import TalosRelayCore
import UIKit

/// The native "Add your relay" sheet (BYOR 3.2): scan the setup QR, check the relay, confirm the HOST, save. The only way a link
/// gets in is `handle(link:)`, called by the camera scan here (or by the DEBUG hook, compiled out of Release). A saved relay becomes
/// the active one: Done puts a new web view controller in the window, built from it. This sheet does not pin or run device/verify.
final class AddRelayViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let flow: AddRelayFlow
    private let runtime: RelayRuntime
    private var pending: PendingRelay?
    private var handled = false

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "talos.addrelay.camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private let content = UIStackView()
    private let cameraHolder = UIView()

    init(flow: AddRelayFlow, runtime: RelayRuntime) {
        self.flow = flow
        self.runtime = runtime
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The real flow: https fetch, the Keychain list in the app's shared access group.
    static func present(from host: UIViewController) {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        var flow = AddRelayFlow(fetcher: URLSessionDescriptorFetcher(), appVersion: version)
        #if DEBUG
        if let stub = DebugAddRelay.stub() { flow = AddRelayFlow(fetcher: stub, appVersion: version) }
        #endif
        let vc = AddRelayViewController(flow: flow, runtime: TalosBridgeViewController.runtime())
        host.present(vc, animated: true)
        #if DEBUG
        if let link = DebugAddRelay.link, !link.isEmpty {DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { vc.handle(link: link) } }
        #endif
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        content.axis = .vertical
        content.spacing = 16
        content.alignment = .fill
        content.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            content.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
        ])
        showScanner()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = cameraHolder.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopCamera()
    }

    // MARK: Screens

    private func reset(title: String) {
        content.arrangedSubviews.forEach { $0.removeFromSuperview() }
        content.addArrangedSubview(label(title, style: .title2, weight: .semibold))
    }

    private func showScanner() {
        handled = false
        pending = nil
        reset(title: "Add your relay")
        content.addArrangedSubview(label("On your Mac, open Terminal and run talos-app enroll --label phone. Then scan the QR code it prints.", style: .body, color: .secondaryLabel))
        cameraHolder.backgroundColor = .secondarySystemBackground
        cameraHolder.layer.cornerRadius = 16
        cameraHolder.clipsToBounds = true
        if !cameraHolder.constraints.contains(where: { $0.firstAttribute == .height }) {
            cameraHolder.heightAnchor.constraint(equalToConstant: 320).isActive = true
        }
        content.addArrangedSubview(cameraHolder)
        content.addArrangedSubview(button("Cancel", primary: false) { [weak self] in self?.dismiss(animated: true) })
        startCamera()
    }

    private func showChecking() {
        stopCamera()
        reset(title: "Checking the relay")
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.startAnimating()
        content.addArrangedSubview(spinner)
    }

    private func showConfirm(_ p: PendingRelay) {
        pending = p
        reset(title: "Add this relay?")
        let host = label(p.host, style: .largeTitle, weight: .bold)
        host.accessibilityIdentifier = "addrelay.host"
        host.adjustsFontSizeToFitWidth = true
        host.minimumScaleFactor = 0.5
        host.numberOfLines = 2
        content.addArrangedSubview(host)
        content.addArrangedSubview(label("Check this address. It must be your own Mac or relay. If it looks even slightly different, cancel.", style: .callout, color: .secondaryLabel))
        let kind = p.profile.kind == .hosted ? "Hosted relay" : "Your own relay"
        content.addArrangedSubview(label("\(kind)\nRelay ID: \(p.profile.id)", style: .footnote, color: .secondaryLabel))
        if let note = p.note { content.addArrangedSubview(label(note, style: .callout, color: .systemOrange)) }
        content.addArrangedSubview(button("Add relay", primary: true) { [weak self] in self?.save() })
        content.addArrangedSubview(button("Cancel", primary: false) { [weak self] in self?.dismiss(animated: true) })
    }

    private func showSaved(_ p: PendingRelay) {
        reset(title: "Relay added")
        // Only Done closes it, so a saved relay is always followed by the switch to it.
        isModalInPresentation = true
        let host = label(p.host, style: .largeTitle, weight: .bold)
        host.accessibilityIdentifier = "addrelay.saved"
        host.adjustsFontSizeToFitWidth = true
        host.minimumScaleFactor = 0.5
        content.addArrangedSubview(host)
        content.addArrangedSubview(label("Saved on this phone. Talos will now connect to it.", style: .callout, color: .secondaryLabel))
        content.addArrangedSubview(button("Done", primary: true) { [weak self] in self?.finish() })
    }

    private func showError(_ message: String, settings: Bool = false) {
        stopCamera()
        reset(title: "Couldn't add the relay")
        let l = label(message, style: .body)
        l.accessibilityIdentifier = "addrelay.error"
        content.addArrangedSubview(l)
        if settings {
            content.addArrangedSubview(button("Open Settings", primary: true) {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            })
        } else {
            content.addArrangedSubview(button("Scan again", primary: true) { [weak self] in self?.showScanner() })
        }
        content.addArrangedSubview(button("Cancel", primary: false) { [weak self] in self?.dismiss(animated: true) })
    }

    // MARK: Pipeline

    /// The one entry for a link: the camera scan, or the DEBUG hook. Runs once per scan.
    func handle(link: String) {
        guard !handled else { return }
        handled = true
        showChecking()
        Task { @MainActor in
            switch await flow.prepare(link: link) {
            case let .success(p): showConfirm(p)
            case let .failure(e): showError(e.message)
            }
        }
    }

    private func save() {
        guard let p = pending else { return }
        do {
            guard runtime.store() != nil else { return showError("Talos can't save to this phone's Keychain in this build.") }
            try runtime.save(p)
            showSaved(p)
        } catch {
            showError("Couldn't save the relay on this phone. Nothing was added.")
        }
    }

    /// Closes the sheet and puts a new web view controller in the window, built from the relay that was just saved.
    /// The scanned code goes with it, in memory only, so the new page opens `/enroll#<code>` and continues pairing.
    private func finish() {
        let scene = presentingViewController?.view.window?.windowScene?.delegate as? SceneDelegate
        let enroll = pending.flatMap { RelayContext.enrollURL(origin: $0.profile.origin, code: $0.code) }
        pending = nil
        dismiss(animated: true) { scene?.switchRelay(enrollURL: enroll) }
    }

    // MARK: Camera

    private func startCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configureCamera()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in
                DispatchQueue.main.async {
                    // The sheet may have been closed while the prompt was up: then start nothing.
                    guard self.viewIfLoaded?.window != nil else { return }
                    ok ? self.configureCamera() : self.showDenied()
                }
            }
        default: showDenied()
        }
    }

    private func showDenied() {
        showError("Talos needs the camera to scan the setup code. Allow it in Settings, then come back.", settings: true)
    }

    private func configureCamera() {
        guard preview == nil else { return sessionQueue.async { self.session.startRunning() } }
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            let note = label("No camera is available on this device.", style: .callout, color: .secondaryLabel)
            note.textAlignment = .center
            note.translatesAutoresizingMaskIntoConstraints = false
            cameraHolder.addSubview(note)
            NSLayoutConstraint.activate([
                note.centerYAnchor.constraint(equalTo: cameraHolder.centerYAnchor),
                note.leadingAnchor.constraint(equalTo: cameraHolder.leadingAnchor, constant: 16),
                note.trailingAnchor.constraint(equalTo: cameraHolder.trailingAnchor, constant: -16),
            ])
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = cameraHolder.bounds
        cameraHolder.layer.addSublayer(layer)
        preview = layer
        sessionQueue.async { self.session.startRunning() }
    }

    private func stopCamera() {
        sessionQueue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let text = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        handle(link: text)
    }

    // MARK: Views

    private func label(_ text: String, style: UIFont.TextStyle, weight: UIFont.Weight = .regular, color: UIColor = .label) -> UILabel {
        let l = UILabel()
        l.text = text
        l.numberOfLines = 0
        l.textColor = color
        l.adjustsFontForContentSizeCategory = true
        l.font = UIFontMetrics(forTextStyle: style).scaledFont(for: .systemFont(ofSize: UIFont.preferredFont(forTextStyle: style).pointSize, weight: weight))
        return l
    }

    private func button(_ title: String, primary: Bool, action: @escaping () -> Void) -> UIButton {
        var config: UIButton.Configuration = primary ? .filled() : .gray()
        config.title = title
        config.cornerStyle = .large
        let b = UIButton(configuration: config, primaryAction: UIAction { _ in action() })
        b.accessibilityIdentifier = "addrelay." + title.lowercased().replacingOccurrences(of: " ", with: "-")
        return b
    }
}
