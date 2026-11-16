import java.util.Base64

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "co.com.styleplus.mailgasto"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "co.com.styleplus.mailgasto"
        val auditBuild = providers.gradleProperty("dart-defines").orNull
            ?.split(",")?.any {
                runCatching { String(Base64.getDecoder().decode(it), Charsets.UTF_8) }
                    .getOrNull() == "MAILGASTO_ANDROID_AUDIT=true"
            } ?: false
        if (auditBuild) {
            applicationIdSuffix = ".audit"
        }
        manifestPlaceholders["mailgastoAppLinkHost"] =
            providers.gradleProperty("mailgastoAppLinkHost").getOrElse("mailgasto.styleplus.com.co")
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

}

dependencies {
    implementation("androidx.browser:browser:1.9.0")
    implementation("androidx.work:work-runtime:2.12.0")
    testImplementation("junit:junit:4.13.2")
}

flutter {
    source = "../.."
}
