import BackgroundAssets
import ExtensionFoundation
import StoreKit

@main
struct BackgroundAssetsDownloader: StoreDownloaderExtension {
    func shouldDownload(_ assetPack: AssetPack) -> Bool {
        // Never auto-download the ~712 MB speech model on install or update;
        // the main app triggers on-demand downloads only after user confirmation.
        return false
    }
}
