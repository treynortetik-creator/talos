import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

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
            window.rootViewController = TalosBridgeViewController()
        }
        if let root = window.rootViewController, root.presentedViewController != nil {
            root.dismiss(animated: false, completion: swap)
        } else {
            swap()
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
