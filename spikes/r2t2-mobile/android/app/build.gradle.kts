import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Pins shared with the scripts (spikes/r2t2-mobile/PINS.env).
val pins = Properties().apply {
    rootProject.file("../PINS.env").readLines()
        .filter { it.isNotBlank() && !it.startsWith("#") && it.contains("=") }
        .forEach { line -> setProperty(line.substringBefore("="), line.substringAfter("=")) }
}
val spikeDir = rootProject.projectDir.parentFile
val llamaDir = File(spikeDir, ".cache/llama.cpp")
val kleidiaiDir = File(spikeDir, ".cache/kleidiai")  // scripts/fetch-deps.sh
val nativeJobs = (Runtime.getRuntime().availableProcessors() / 2).coerceAtLeast(1)

android {
    namespace = "com.im.codes.spike.r2t2"
    compileSdk = 35
    ndkVersion = pins.getProperty("ANDROID_NDK_VERSION")

    defaultConfig {
        applicationId = "com.im.codes.spike.r2t2harness"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
        ndk { abiFilters += listOf("arm64-v8a") }
        buildConfigField("String", "MODEL_FILE", "\"${pins.getProperty("R2T2_MODEL_FILE")}\"")
        buildConfigField("String", "MODEL_SHA256", "\"${pins.getProperty("R2T2_MODEL_SHA256")}\"")
        buildConfigField("long", "MODEL_SIZE", "${pins.getProperty("R2T2_MODEL_SIZE")}L")
        buildConfigField("String", "MMPROJ_FILE", "\"${pins.getProperty("R2T2_MMPROJ_FILE")}\"")
        buildConfigField("String", "MMPROJ_SHA256", "\"${pins.getProperty("R2T2_MMPROJ_SHA256")}\"")
        buildConfigField("long", "MMPROJ_SIZE", "${pins.getProperty("R2T2_MMPROJ_SIZE")}L")
        buildConfigField("String", "GGUF_REPO", "\"${pins.getProperty("R2T2_GGUF_REPO")}\"")
        buildConfigField("String", "GGUF_REVISION", "\"${pins.getProperty("R2T2_GGUF_REVISION")}\"")
        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DLLAMA_CPP_DIR=${llamaDir.absolutePath}",
                    "-DFETCHCONTENT_SOURCE_DIR_KLEIDIAI=${kleidiaiDir.absolutePath}",
                    "-DR2T2_CORE_DIR=${File(spikeDir, "core").absolutePath}",
                    "-DR2T2_VULKAN=${if (project.hasProperty("r2t2.vulkan")) "ON" else "OFF"}",
                    "-DCMAKE_BUILD_TYPE=Release",
                    "-DCMAKE_JOB_POOLS=compile=$nativeJobs",
                    "-DCMAKE_JOB_POOL_COMPILE=compile",
                )
            }
        }
    }

    buildTypes {
        // The harness is always built optimized; a debug-signed "release-like" APK
        // installs with plain `adb install` and needs no keystore.
        getByName("debug") {
            isDebuggable = true
            isJniDebuggable = false
            externalNativeBuild { cmake { arguments += "-DCMAKE_BUILD_TYPE=Release" } }
        }
    }
    buildFeatures { buildConfig = true }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = pins.getProperty("ANDROID_CMAKE_VERSION")
        }
    }
    sourceSets["main"].assets.srcDir(File(spikeDir, "samples"))
    androidResources { noCompress += listOf("wav") }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { jniLibs { useLegacyPackaging = false } }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}
