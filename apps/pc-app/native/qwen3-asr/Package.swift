// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ImcodesSpeechMlx",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "imcodes-speech-mlx", targets: ["ImcodesSpeechMlx"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.33.0"),
    ],
    targets: [
        .target(
            name: "AudioCommon",
            path: "Sources/AudioCommon"
        ),
        .target(
            name: "MLXCommon",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
                .product(name: "MLXFFT", package: "mlx-swift"),
            ],
            path: "Sources/MLXCommon"
        ),
        .target(
            name: "Qwen3ASR",
            dependencies: [
                "AudioCommon",
                "MLXCommon",
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
            ],
            path: "Sources/Qwen3ASR"
        ),
        .executableTarget(
            name: "ImcodesSpeechMlx",
            dependencies: [
                "AudioCommon",
                "MLXCommon",
                "Qwen3ASR",
            ],
            path: "Sources/ImcodesSpeechMlx"
        ),
    ]
)
