import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard scene is UIWindowScene else { return }
        AppDelegate.shared?.attachSceneWindow(window)

        for context in connectionOptions.urlContexts {
            _ = AppDelegate.shared?.handleOpenURL(context.url)
        }
        for userActivity in connectionOptions.userActivities {
            _ = AppDelegate.shared?.handleContinueUserActivity(userActivity, restorationHandler: { _ in })
        }
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        // Single-scene configuration retains shared AppDelegate until process termination.
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        AppDelegate.shared?.handleSceneDidBecomeActive(window: window)
    }

    func sceneWillResignActive(_ scene: UIScene) {
        AppDelegate.shared?.handleSceneWillResignActive()
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        AppDelegate.shared?.handleSceneWillEnterForeground(window: window)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            _ = AppDelegate.shared?.handleOpenURL(context.url)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = AppDelegate.shared?.handleContinueUserActivity(userActivity, restorationHandler: { _ in })
    }

    func windowScene(
        _ windowScene: UIWindowScene,
        didUpdate previousCoordinateSpace: UICoordinateSpace,
        interfaceOrientation previousInterfaceOrientation: UIInterfaceOrientation,
        traitCollection previousTraitCollection: UITraitCollection
    ) {
        AppDelegate.shared?.handleSceneGeometryDidUpdate(window: window)
    }
}
