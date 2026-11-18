import UIKit

/// The screen a release build shows when no relay is paired (BYOR 3.1): no web page is loaded behind it. Its button opens the
/// native Add-relay sheet, the only place a relay origin can be set.
final class FirstRunView: UIView {
    private let onScan: () -> Void

    init(onScan: @escaping () -> Void) {
        self.onScan = onScan
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 0x14 / 255, green: 0x11 / 255, blue: 0x10 / 255, alpha: 1)
        let cream = UIColor(red: 0xF3 / 255, green: 0xE6 / 255, blue: 0xCF / 255, alpha: 1)

        let title = UILabel()
        title.text = "Connect your Mac"
        title.font = UIFontMetrics(forTextStyle: .title1).scaledFont(for: .systemFont(ofSize: 28, weight: .semibold))
        title.textColor = cream
        title.numberOfLines = 0
        title.textAlignment = .center
        title.accessibilityTraits = .header

        let body = UILabel()
        body.text = "On your Mac, open Terminal and run:\n\ntalos-app enroll --label phone\n\nThen scan the QR code it prints."
        body.font = UIFont.preferredFont(forTextStyle: .body)
        body.adjustsFontForContentSizeCategory = true
        body.textColor = cream.withAlphaComponent(0.75)
        body.numberOfLines = 0
        body.textAlignment = .center

        var config = UIButton.Configuration.filled()
        config.title = "Scan setup code"
        config.cornerStyle = .large
        let button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.onScan() })
        button.accessibilityIdentifier = "firstrun.scan"

        let stack = UIStackView(arrangedSubviews: [title, body, button])
        stack.axis = .vertical
        stack.spacing = 16
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor, constant: -8),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        accessibilityIdentifier = "firstrun"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}
