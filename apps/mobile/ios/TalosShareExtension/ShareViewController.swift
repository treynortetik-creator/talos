import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The system share sheet's "Talos" entry (IOS-SPEC 6.1, WP-I3b). A thin UIKit host for the SwiftUI view; every rule
/// (limits, scopes, https, the Bearer token, what the relay answered) lives in TalosShareCore.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        model.onClose = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
        model.load(from: extensionContext?.inputItems as? [NSExtensionItem] ?? [])
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
    }
}
