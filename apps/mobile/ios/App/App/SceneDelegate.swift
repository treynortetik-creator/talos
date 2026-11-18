import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    /// What a relay switch clears (the share token and the notification grant). Tests replace it.
    var clearRelayBoundState: () -> Void = RelayRuntime.clearRelayBoundNativeState

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = TalosBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// A new web view for a page whose web process is stuck (TalosBridgeViewController.rebuildWebView). The old controller and its
    /// web process go with it (`retire` lets go of the old web view). A sheet over the old one (the in-app viewer, Safari) is closed first, without animation, and the swap
    /// follows in its completion: a presented sheet would keep the old controller on screen and alive.
    func replaceBridgeViewController() {
        guard let window else { return }
        let swap = {
            (window.rootViewController as? TalosBridgeViewController)?.retire()
            // The owner was looking at a stuck page: the new one says "Reconnecting…" until its first page is up.
            let next = TalosBridgeViewController()
            next.startsReconnecting = true
            window.rootViewController = next
        }
        if let root = window.rootViewController, root.presentedViewController != nil {
            root.dismiss(animated: false, completion: swap)
        } else {
            swap()
        }
    }

    /// The app moved to another relay (the Add-relay sheet's Done): a new web view built from the saved profile, without the
    /// "Reconnecting" notice, with the old relay's audio session and push taps dropped. `enrollURL` is loaded once, so the page
    /// continues pairing with the code that was just scanned.
    func switchRelay(enrollURL: URL?) {
        guard let window else { return }
        (window.rootViewController as? TalosBridgeViewController)?.retire()
        // The old relay's page stayed trusted from the save until now and may have stored a share token or grant meanwhile
        // (a grant renewal, setToken, a call in flight). It is retired, so nothing more can arrive: clear once more.
        clearRelayBoundState()
        TalosAudioPlugin.resetSession()
        TalosPushCenter.shared.resetForRelaySwitch()
        let next = TalosBridgeViewController()
        next.firstPage = enrollURL
        window.rootViewController = next
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
