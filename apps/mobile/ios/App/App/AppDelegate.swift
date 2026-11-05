import Capacitor
import TalosPushCore
import UIKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        // Categories and the tap hand-off. This asks for nothing: permission is requested only from the Settings tap.
        TalosPushCenter.shared.install()
        // Crash and hang reports from the system wait for the page to send them (nothing leaves the phone from here).
        TalosCrashSubscriber.shared.start()
        return true
    }

    /// iOS handed us a token: tell the push plugin (it resolves the page's pending `register`).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .talosPushToken, object: PushCore.hex(deviceToken))
    }

    /// Without the push entitlement (a free Apple account) iOS lands here; the page then says "Needs setup".
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        let e = error as NSError
        NotificationCenter.default.post(name: .talosPushFailed, object: PushCore.registrationFailureCode(domain: e.domain, code: e.code))
    }

    /// Parked, mixing, never activated: opening Talos must not stop his music (IOS-SPEC E17). A voice reply activates
    /// the session through the TalosAudio plugin; the `audio` background mode keeps it playing when the screen locks.
    private func configureAudioSession() {
        do {
            try TalosAudioPlugin.policy.configureAtLaunch()
        } catch {
            NSLog("Talos: audio session category failed: \(error.localizedDescription)")
        }
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
