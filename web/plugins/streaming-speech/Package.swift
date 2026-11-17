// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ImcodesStreamingSpeech",
    platforms: [.iOS(.v17)],
    products: [.library(name: "ImcodesStreamingSpeech", targets: ["StreamingSpeechPlugin"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.2.0"),
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.33.0")
    ],
    targets: [
        .target(
            name: "AudioCommon",
            path: "ios/Sources/AudioCommon"
        ),
        .target(
            name: "MLXCommon",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
                .product(name: "MLXFFT", package: "mlx-swift")
            ],
            path: "ios/Sources/MLXCommon"
        ),
        .target(
            name: "Qwen3ASR",
            dependencies: [
                "AudioCommon",
                "MLXCommon",
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift")
            ],
            path: "ios/Sources/Qwen3ASR"
        ),
        .target(
            name: "StreamingSpeechPlugin",
            dependencies: [
                "AudioCommon",
                "MLXCommon",
                "Qwen3ASR",
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: ".",
            exclude: [
                "android",
                "models",
                "package.json",
                "README.md",
                "ios/Sources/AudioCommon",
                "ios/Sources/MLXCommon",
                "ios/Sources/Qwen3ASR",
                "ios/Tests"
            ],
            sources: ["ios/Sources/StreamingSpeechPlugin"],
            resources: [.copy("ios-models")]
        ),
        .testTarget(
            name: "StreamingSpeechPluginTests",
            dependencies: ["StreamingSpeechPlugin"],
            path: "ios/Tests/StreamingSpeechPluginTests"
        )
    ]
)
