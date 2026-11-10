package co.com.styleplus.mailgasto

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterFragmentActivity() {
    private var pendingReturn: Uri? = null
    private var browserChannel: MethodChannel? = null
    private val authLauncher = AuthTabIntent.registerActivityResultLauncher(this, ::onGoogleResult)

    override fun onCreate(savedInstanceState: Bundle?) {
        pendingReturn = savedInstanceState?.getString(RETURN_KEY)?.let(Uri::parse)
        super.onCreate(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(RETURN_KEY, pendingReturn?.toString())
        super.onSaveInstanceState(outState)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        browserChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, BROWSER_CHANNEL)
        browserChannel?.setMethodCallHandler { call, result ->
            if (call.method != "open") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            val url = call.argument<String>("url")?.let(Uri::parse)
            val returnUrl = call.argument<String>("returnUrl")?.let(Uri::parse)
            if (url == null || returnUrl == null || !isGoogleAuthorization(url, returnUrl)) {
                result.error("INVALID_GOOGLE_AUTH", null, null)
                return@setMethodCallHandler
            }
            if (pendingReturn != null) {
                result.error("GOOGLE_AUTH_IN_PROGRESS", null, null)
                return@setMethodCallHandler
            }
            try {
                openBrowser(url, returnUrl)
                result.success(null)
            } catch (_: ActivityNotFoundException) {
                pendingReturn = null
                result.error("BROWSER_UNAVAILABLE", null, null)
            } catch (_: SecurityException) {
                pendingReturn = null
                result.error("BROWSER_UNAVAILABLE", null, null)
            }
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        browserChannel?.setMethodCallHandler(null)
        browserChannel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    private fun openBrowser(url: Uri, returnUrl: Uri) {
        val chrome = "com.android.chrome"
        val customTabsBrowser = CustomTabsClient.getPackageName(this, listOf(chrome))
        val authBrowser = listOfNotNull(customTabsBrowser, chrome).distinct()
            .firstOrNull { CustomTabsClient.isAuthTabSupported(this, it) }
        if (authBrowser == null) {
            // Browsers without Auth Tab can still return through the verified App Link.
            CustomTabsIntent.Builder().build().apply { intent.setPackage(customTabsBrowser) }
                .launchUrl(this, url)
            return
        }
        pendingReturn = returnUrl
        AuthTabIntent.Builder().build().apply { intent.setPackage(authBrowser) }
            .launch(authLauncher, url, requireNotNull(returnUrl.host), requireNotNull(returnUrl.path))
    }

    private fun onGoogleResult(result: AuthTabIntent.AuthResult) {
        val expected = pendingReturn ?: return
        pendingReturn = null
        val uri = result.resultUri
        val link = when {
            result.resultCode == AuthTabIntent.RESULT_OK && uri != null &&
                uri.buildUpon().encodedFragment(null).build() == expected -> uri
            result.resultCode == AuthTabIntent.RESULT_CANCELED ->
                expected.buildUpon().encodedFragment("status=cancelled").build()
            else -> expected.buildUpon().encodedFragment("status=failed").build()
        }
        // Send Auth Tab results to the same Flutter handler as Android App Links.
        super.onNewIntent(Intent(Intent.ACTION_VIEW, link))
    }

    private fun isGoogleAuthorization(url: Uri, returnUrl: Uri): Boolean {
        val callbackPath = when (returnUrl.path) {
            "/mobile/auth/google/return" -> "/v1/mobile/auth/google/callback"
            "/mobile/gmail/return" -> "/v1/mobile/mailboxes/gmail/callback"
            else -> return false
        }
        if (url.scheme != "https" || url.authority != "accounts.google.com" ||
            url.path != "/o/oauth2/v2/auth" || returnUrl.scheme != "https" ||
            returnUrl.host.isNullOrBlank() || returnUrl.userInfo != null ||
            returnUrl.encodedQuery != null || returnUrl.encodedFragment != null
        ) return false
        val callback = url.getQueryParameter("redirect_uri")?.let(Uri::parse) ?: return false
        return callback.scheme == "https" && callback.authority == returnUrl.authority &&
            callback.path == callbackPath && callback.encodedQuery == null && callback.encodedFragment == null
    }

    private companion object {
        const val BROWSER_CHANNEL = "co.com.styleplus.mailgasto/google_browser"
        const val RETURN_KEY = "google_browser_return"
    }
}
