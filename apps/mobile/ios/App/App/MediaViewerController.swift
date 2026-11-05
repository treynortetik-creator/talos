import BridgeGuard
import QuickLook
import UIKit
import WebKit

/// Shows relay /media/ pages (agent HTML, downloads) in a second web view that shares the shell's cookie store, so the
/// session cookie rides along, but has a fresh WKUserContentController: no Capacitor scripts, no "bridge" handler.
/// Main-frame navigation stays on relay /media/; any other http(s) target goes to Safari. Popups, prompts, camera and
/// mic are refused. The relay's sandbox CSP still makes the page an opaque origin.
///
/// Files (audit D6): a response WebKit cannot show, or one marked attachment, is downloaded to a temp file and shown in
/// the system preview with Share. A failure status shows a plain message with Retry instead of the relay's raw JSON.
/// The decision is `MediaPolicy.classify` (unit-tested in BridgeGuard).
final class MediaViewerController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, QLPreviewControllerDataSource {
    private let url: URL
    private let dataStore: WKWebsiteDataStore
    private let guardian: BridgeGuard
    private let openExternal: (URL) -> Void

    private var web: WKWebView { view.subviews.compactMap { $0 as? WKWebView }.first! }
    private let spinner = UIActivityIndicatorView(style: .large)
    private let statusLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let statusStack = UIStackView()
    private var downloadedFile: URL?
    private var tempDir: URL?
    private var preview: QLPreviewController?
    private var activeDownload: WKDownload?

    init(url: URL, dataStore: WKWebsiteDataStore, guardian: BridgeGuard, openExternal: @escaping (URL) -> Void) {
        self.url = url
        self.dataStore = dataStore
        self.guardian = guardian
        self.openExternal = openExternal
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        activeDownload?.cancel(nil)
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        config.userContentController = WKUserContentController()  // fresh: nothing from Capacitor
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        let root = UIView()
        root.backgroundColor = .systemBackground
        web.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: root.topAnchor), web.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: root.leadingAnchor), web.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        ])
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.font = .preferredFont(forTextStyle: .body)
        statusLabel.adjustsFontForContentSizeCategory = true
        retryButton.setTitle("Try again", for: .normal)
        retryButton.addAction(UIAction { [weak self] _ in self?.load() }, for: .touchUpInside)
        statusStack.axis = .vertical
        statusStack.alignment = .center
        statusStack.spacing = 16
        statusStack.translatesAutoresizingMaskIntoConstraints = false
        statusStack.addArrangedSubview(spinner)
        statusStack.addArrangedSubview(statusLabel)
        statusStack.addArrangedSubview(retryButton)
        root.addSubview(statusStack)
        NSLayoutConstraint.activate([
            statusStack.centerYAnchor.constraint(equalTo: root.safeAreaLayoutGuide.centerYAnchor),
            statusStack.leadingAnchor.constraint(equalTo: root.layoutMarginsGuide.leadingAnchor),
            statusStack.trailingAnchor.constraint(equalTo: root.layoutMarginsGuide.trailingAnchor),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        load()
    }

    private func load() {
        showLoading()
        web.load(URLRequest(url: url))
    }

    // MARK: Status states

    private func showLoading() {
        statusLabel.text = nil
        retryButton.isHidden = true
        spinner.startAnimating()
        statusStack.isHidden = false
    }

    private func showFailed(_ message: String) {
        spinner.stopAnimating()
        statusLabel.text = message
        retryButton.isHidden = false
        statusStack.isHidden = false
        web.isHidden = true
    }

    private func hideStatus() {
        spinner.stopAnimating()
        statusStack.isHidden = true
        web.isHidden = false
    }

    // MARK: Navigation

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let target = navigationAction.request.url else { return decisionHandler(.cancel) }
        if !(navigationAction.targetFrame?.isMainFrame ?? true) { return decisionHandler(.allow) }
        let scheme = target.scheme?.lowercased() ?? ""
        if guardian.isRelayMedia(target) || ["about", "blob", "data"].contains(scheme) { return decisionHandler(.allow) }
        if scheme == "http" || scheme == "https" { openExternal(target) }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        guard navigationResponse.isForMainFrame else { return decisionHandler(.allow) }
        let http = navigationResponse.response as? HTTPURLResponse
        let outcome = MediaPolicy.classify(
            statusCode: http?.statusCode,
            contentDisposition: http?.value(forHTTPHeaderField: "Content-Disposition"),
            canShowMIMEType: navigationResponse.canShowMIMEType,
            mimeType: navigationResponse.response.mimeType)
        switch outcome {
        case .show: decisionHandler(.allow)
        case .download: showLoading(); decisionHandler(.download)
        case .failed(let message): showFailed(message); decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { hideStatus() }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    /// 204 (plug-in handled load, e.g. video/mp4) means the media is playing: keep the web view. A cancelled load is not
    /// a new failure. Anything else shows the failure panel.
    private func handleLoadError(_ error: Error) {
        let e = error as NSError
        if MediaPolicy.isPluginHandledLoad(domain: e.domain, code: e.code) { return hideStatus() }
        if MediaPolicy.isCancelledLoad(domain: e.domain, code: e.code) || activeDownload != nil { return }
        showFailed("Talos could not load this file. Check your connection and try again.")
    }

    // MARK: Downloads

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
        activeDownload = download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
        activeDownload = download
    }

    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("talos-media-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            return completionHandler(nil)
        }
        tempDir = dir
        completionHandler(dir.appendingPathComponent(MediaPolicy.safeFileName(suggestedFilename)))
        downloadedFile = dir.appendingPathComponent(MediaPolicy.safeFileName(suggestedFilename))
    }

    func downloadDidFinish(_ download: WKDownload) {
        activeDownload = nil
        guard let file = downloadedFile, FileManager.default.fileExists(atPath: file.path) else {
            return showFailed("Talos could not save this file. Try again.")
        }
        hideStatus()
        web.isHidden = true
        let ql = QLPreviewController()
        ql.dataSource = self
        addChild(ql)
        ql.view.frame = view.bounds
        ql.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(ql.view)
        ql.didMove(toParent: self)
        preview = ql
        let share = UIBarButtonItem(systemItem: .action, primaryAction: UIAction { [weak self] _ in self?.share() })
        navigationItem.leftBarButtonItem = share
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        activeDownload = nil
        showFailed("Talos could not download this file. Check your connection and try again.")
    }

    private func share() {
        guard let file = downloadedFile else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.barButtonItem = navigationItem.leftBarButtonItem
        present(sheet, animated: true)
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { downloadedFile == nil ? 0 : 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        (downloadedFile ?? url) as NSURL
    }

    // MARK: Refusals

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let u = navigationAction.request.url, ["http", "https"].contains(u.scheme?.lowercased() ?? "") { openExternal(u) }
        return nil
    }

    func webView(
        _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void
    ) { completionHandler(nil) }

    func webView(
        _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) { decisionHandler(.deny) }

    func webView(
        _ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) { decisionHandler(.deny) }
}
