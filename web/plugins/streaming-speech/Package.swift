// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ImcodesStreamingSpeech",
    platforms: [.iOS(.v15)],
    products: [.library(name: "ImcodesStreamingSpeech", targets: ["StreamingSpeechPlugin"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.2.0"),
        .package(url: "https://github.com/k2-fsa/sherpa-onnx.git", exact: "2.0.1")
    ],
    targets: [.target(
        name: "StreamingSpeechPlugin",
        dependencies: [
            .product(name: "Capacitor", package: "capacitor-swift-pm"),
            .product(name: "sherpa-onnx", package: "sherpa-onnx")
        ],
        path: ".",
        exclude: ["android", "package.json", "README.md"],
        sources: ["ios/Sources/StreamingSpeechPlugin"],
        resources: [.copy("models")]
    )]
)
