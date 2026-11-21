import BridgeGuard
import Foundation
import UIKit

/// The plain words for each trust state (BYOR phase 4b, docs/specs/BYOR-phase4-frame.md section 5). Pure, so the wording is tested.
enum TrustWords {
    /// "3 hours ago", or "never" when no attest ever passed.
    static func lastConfirmed(_ date: Date?, now: Date) -> String {
        guard let date, date <= now else { return "never" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        f.locale = Locale(identifier: "en_US")
        return f.localizedString(for: date, relativeTo: now)
    }

    static func why(_ reason: UnverifiedReason, host: String) -> String {
        switch reason {
        case .checking: return "Checking…"
        case .network: return "\(host) did not answer."
        case .macOffline: return "Your Mac is not connected to the Talos server."
        case .unsupported: return "Your Mac's Talos is too old to be checked: update Talos on your Mac."
        case .macTimeout: return "Your Mac did not answer in time."
        case .rateLimited: return "The Talos server is busy."
        case .badAnswer: return "The Talos server gave an answer Talos does not understand."
        case .keyChanged: return "Your Mac's key changed and you have not accepted the new one."
        case .saveFailed: return "Talos could not save your Mac's new key on this phone."
        }
    }

    /// The banner over the read-only page.
    static func banner(lastVerified: Date?, reason: UnverifiedReason, host: String, now: Date) -> String {
        // Not "camera off": a file input that opens the system camera is not a WebKit permission the app is asked about.
        "Can't confirm this is your Mac. Sharing and some phone features are off until it answers. "
            + "\(why(reason, host: host)) Last confirmed \(lastConfirmed(lastVerified, now: now))."
    }

    static let failTitle = "This is not your Mac"
    static func failBody(host: String) -> String {
        "\(host) answered with a key that is not the one your Mac gave you when you paired. Talos loaded nothing from it. "
            + "Remove this Talos server and pair again, only if you trust the address."
    }

    static let blockTitle = "Can't confirm your Mac"
    static func blockBody(lastVerified: Date?, host: String, now: Date) -> String {
        "Your Mac has not answered through \(host) for over 24 hours (last confirmed \(lastConfirmed(lastVerified, now: now))), "
            + "so Talos is closed until it does. Try again, or remove this Talos server and pair again."
    }

    static func repinTitle(host: String) -> String { "Your Mac's key changed" }
    static func repinMessage(host: String) -> String {
        "The Mac behind \(host) is now using a new key. If you ran talos-app rotate, continue. If you did not, remove this Talos server."
    }
}

private let ink = UIColor(red: 0xF3 / 255, green: 0xE6 / 255, blue: 0xCF / 255, alpha: 1)
private let brand = UIColor(red: 0x14 / 255, green: 0x11 / 255, blue: 0x10 / 255, alpha: 1)

private func makeButton(_ title: String, id: String, primary: Bool, _ action: @escaping () -> Void) -> UIButton {
    var config: UIButton.Configuration = primary ? .filled() : .gray()
    config.title = title
    config.cornerStyle = .large
    if primary { config.baseBackgroundColor = ink; config.baseForegroundColor = brand }
    let b = UIButton(configuration: config, primaryAction: UIAction { _ in action() })
    b.accessibilityIdentifier = id
    return b
}

/// Over the top of the read-only page: what is off, why, and when the Mac was last confirmed, with Retry and Remove. Native, so the
/// page cannot touch it.
final class TrustBannerView: UIView {
    let message = UILabel()
    private(set) var retry: UIButton!
    private(set) var remove: UIButton!

    init(onRetry: @escaping () -> Void, onRemove: @escaping () -> Void) {
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 0x4A / 255, green: 0x2A / 255, blue: 0x12 / 255, alpha: 1)
        accessibilityIdentifier = "trust.banner"
        message.numberOfLines = 0
        message.textColor = ink
        message.adjustsFontForContentSizeCategory = true
        message.font = .preferredFont(forTextStyle: .footnote)
        message.accessibilityIdentifier = "trust.banner.text"
        retry = makeButton("Retry", id: "trust.retry", primary: true, onRetry)
        remove = makeButton("Remove", id: "trust.remove", primary: false, onRemove)
        let buttons = UIStackView(arrangedSubviews: [retry, remove])
        buttons.axis = .horizontal
        buttons.spacing = 12
        buttons.distribution = .fillEqually
        let stack = UIStackView(arrangedSubviews: [message, buttons])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not built from a storyboard") }
}

/// The full-screen native screen for `.failed` and `.hardBlock`: it loads no page. A fail offers only "Remove this Talos server and pair again";
/// a hard block also offers Retry.
final class TrustBlockView: UIView {
    let titleLabel = UILabel()
    let body = UILabel()

    init(title: String, text: String, onRetry: (() -> Void)?, onRemove: @escaping () -> Void) {
        super.init(frame: .zero)
        backgroundColor = brand
        accessibilityIdentifier = onRetry == nil ? "trust.fail" : "trust.block"
        titleLabel.text = title
        titleLabel.textColor = onRetry == nil ? UIColor(red: 1, green: 0.45, blue: 0.4, alpha: 1) : ink
        titleLabel.font = .preferredFont(forTextStyle: .title1)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.numberOfLines = 0
        titleLabel.textAlignment = .center
        body.text = text
        body.textColor = ink
        body.font = .preferredFont(forTextStyle: .body)
        body.adjustsFontForContentSizeCategory = true
        body.numberOfLines = 0
        body.textAlignment = .center
        var views: [UIView] = [titleLabel, body]
        if let onRetry { views.append(makeButton("Retry", id: "trust.retry", primary: true, onRetry)) }
        views.append(makeButton("Remove this Talos server and pair again", id: "trust.remove", primary: onRetry == nil, onRemove))
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not built from a storyboard") }
}

/// The blocking native confirm for a changed Mac key. It shows the host prominently and cannot be dismissed by a tap outside.
@MainActor
final class RepinPrompt {
    private var answer: ((RepinChoice) -> Void)?
    private weak var alert: UIAlertController?
    private(set) var isShowing = false
    /// How long after presenting the alert must be on screen before the ask is called a decline (UIKit presents nothing, with only a
    /// log line, when the presenter is not in a window or is busy).
    private let presentCheckDelay: TimeInterval

    init(presentCheckDelay: TimeInterval = 2) { self.presentCheckDelay = presentCheckDelay }

    func ask(host: String, from presenter: @MainActor () -> UIViewController) async -> RepinChoice {
        await withCheckedContinuation { (c: CheckedContinuation<RepinChoice, Never>) in
            ask(host: host, from: presenter) { c.resume(returning: $0) }
        }
    }

    /// The question, with its answer given to `answer` exactly once. Never two at once: a second ask while one is up is a decline.
    func ask(host: String, from presenter: @MainActor () -> UIViewController, answer: @escaping (RepinChoice) -> Void) {
        guard self.answer == nil else { return answer(.decline) }
        self.answer = answer
        isShowing = true
        let alert = UIAlertController(
            title: "Your Mac's key changed: \(host)", message: TrustWords.repinMessage(host: host), preferredStyle: .alert)
        alert.view.accessibilityIdentifier = "trust.repin"
        alert.addAction(UIAlertAction(title: "Continue", style: .default) { [weak self] _ in self?.finish(.accept) })
        alert.addAction(UIAlertAction(title: "Not now", style: .cancel) { [weak self] _ in self?.finish(.decline) })
        alert.addAction(UIAlertAction(title: "Remove this Talos server", style: .destructive) { [weak self] _ in self?.finish(.remove) })
        self.alert = alert
        presenter().present(alert, animated: true)
        // An alert that never reached the screen is answered "no", so the question cannot hang for ever (or block the next one).
        // The closure holds the alert, so a presenter that showed nothing cannot let it vanish before this look.
        DispatchQueue.main.asyncAfter(deadline: .now() + presentCheckDelay) { [weak self] in
            guard let self, self.alert === alert, self.answer != nil, alert.viewIfLoaded?.window == nil else { return }
            self.finish(.decline)
        }
    }

    /// The controller is going away: the question is answered "no" and taken down.
    func cancel() {
        alert?.dismiss(animated: false)
        finish(.decline)
    }

    /// For tests: answers the question as a tap on one of the three buttons would.
    func choose(_ choice: RepinChoice) {
        alert?.dismiss(animated: false)
        finish(choice)
    }

    private func finish(_ choice: RepinChoice) {
        isShowing = false
        let a = answer
        answer = nil
        a?(choice)
    }
}
