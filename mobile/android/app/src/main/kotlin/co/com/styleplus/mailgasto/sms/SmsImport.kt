package co.com.styleplus.mailgasto.sms

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Telephony
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import androidx.core.content.ContextCompat
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

fun smsPermissions(context: Context): Boolean =
    listOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS).all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }
private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
private fun isoTime(time: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
    .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(time))

// Only configured financial candidates and a restricted ingest credential are persisted.
// Everything is encrypted with a non-exportable Android Keystore key; backups are disabled.
class SmsStore(private val context: Context) {
    private val file = AtomicFile(File(context.filesDir, "sms-import.enc"))
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("mailgasto_sms", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("mailgasto_sms", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    private fun read(): JSONObject {
        if (!file.baseFile.exists()) return JSONObject()
        val bytes = file.readFully()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }

    private fun write(value: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val stream = file.startWrite()
        try {
            stream.write(cipher.iv + cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8)))
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    fun snapshot(): JSONObject = synchronized(lock) { read() }
    fun update(change: (JSONObject) -> Unit): JSONObject = synchronized(lock) {
        val data = read()
        change(data)
        write(data)
        data
    }

    fun status(): Map<String, Any?> {
        val data = update { if (!it.has("deviceId")) it.put("deviceId", UUID.randomUUID().toString()) }
        return mapOf(
            "deviceId" to data.getString("deviceId"), "serverId" to data.optString("serverId").ifEmpty { null },
            "accountId" to data.optString("accountId").ifEmpty { null },
            "enabled" to data.optBoolean("enabled"), "permission" to smsPermissions(context),
            "senders" to (data.optJSONArray("senders")?.strings() ?: emptyList<String>()),
            "since" to data.optString("since", "2026-11-01"),
            "queued" to (data.optJSONArray("queue")?.length() ?: 0),
            "imported" to data.optInt("imported"), "duplicates" to data.optInt("duplicates"),
            "ignored" to data.optInt("ignored"), "pending" to data.optInt("pending"),
            "lastSync" to data.optString("lastSync").ifEmpty { null },
            "error" to data.optString("error").ifEmpty { null }
        )
    }

    fun clear() {
        SmsJobs.cancel(context)
        synchronized(lock) {
            file.delete()
        }
    }

    fun configure(args: Map<*, *>) {
        require(smsPermissions(context)) { "permission_required" }
        val origin = args["origin"] as? String ?: error("invalid_origin")
        val url = URL(origin)
        require(url.protocol == "https" && url.userInfo == null && url.query == null && url.ref == null &&
            (url.path.isEmpty() || url.path == "/")) { "invalid_origin" }
        val senders = (args["senders"] as? List<*>)?.filterIsInstance<String>()?.map(String::trim)?.distinct().orEmpty()
        require(senders.size <= 20 && senders.all { it.length in 1..40 }) { "invalid_senders" }
        val token = args["ingestToken"] as? String ?: error("invalid_token")
        require(token.length in 32..512 && !token.contains(Regex("[\\r\\n]"))) { "invalid_token" }
        val since = args["since"] as? String ?: "2026-11-01"
        val parser = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply { isLenient = false; timeZone = TimeZone.getTimeZone("America/Bogota") }
        val sinceMillis = requireNotNull(parser.parse(since)).time
        update {
            if (it.optString("accountId") != args["accountId"]) {
                it.remove("queue"); it.remove("done"); it.remove("terminal"); it.remove("scanAt")
                it.remove("lastId"); it.remove("fullScanAt"); it.remove("fullScanInProgress")
                for (counter in listOf("imported", "duplicates", "ignored", "pending")) it.remove(counter)
            }
            it.put("enabled", true).put("accountId", args["accountId"]).put("origin", origin.trimEnd('/'))
                .put("token", token).put("serverId", args["serverId"]).put("senders", JSONArray(senders))
                .put("since", since).put("sinceMillis", sinceMillis).put("error", "")
            // Reconfiguration also recovers historical candidates under the current parser.
            it.remove("scanAt")
        }
        SmsJobs.schedule(context)
    }

    companion object { private val lock = Any() }
}

object SmsJobs {
    private const val SCAN = "mailgasto-sms-scan"
    private const val PERIODIC = "mailgasto-sms-periodic"
    private const val UPLOAD = "mailgasto-sms-upload"
    fun schedule(context: Context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SmsScanWorker>(15, TimeUnit.MINUTES).build())
        scan(context)
    }
    fun scan(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(SCAN, ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<SmsScanWorker>().setInitialDelay(5, TimeUnit.SECONDS).build())
    }
    fun upload(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(UPLOAD, ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<SmsUploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
    }
    fun cancel(context: Context) {
        val manager = WorkManager.getInstance(context)
        for (name in listOf(SCAN, PERIODIC, UPLOAD)) manager.cancelUniqueWork(name)
    }
}

class NequiSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION || !smsPermissions(context)) return
        runCatching {
            val config = SmsStore(context).snapshot()
            if (!config.optBoolean("enabled")) return
            // No body is read by the receiver. Identification happens locally in the scan.
            SmsJobs.scan(context)
        }
    }
}

class SmsScanWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val store = SmsStore(applicationContext)
        return try {
            var config = store.snapshot()
            if (!config.optBoolean("enabled")) return Result.success()
            if (!smsPermissions(applicationContext)) {
                store.update { it.put("error", "permission_required") }
                return Result.success()
            }
            val cutoff = System.currentTimeMillis()
            val expectedToken = config.optString("token")
            fun plan(data: JSONObject) = SmsReviewPolicy.plan(data.optLong("sinceMillis"), data.optLong("scanAt"),
                data.optLong("fullScanAt"), data.optBoolean("fullScanInProgress"), data.optInt("parserVersion"),
                SmsCandidateFilter.VERSION, cutoff, data.optJSONArray("done")?.strings().orEmpty(),
                data.optJSONArray("terminal")?.strings().orEmpty(), data.optJSONArray("queue")?.objects().orEmpty().map { it.getString("externalId") })
            if (plan(config).startsReview) {
                config = store.update {
                    if (it.optBoolean("enabled") && it.optString("token") == expectedToken && !it.optBoolean("fullScanInProgress")) {
                        it.put("done", it.optJSONArray("terminal") ?: JSONArray()).put("fullScanInProgress", true)
                            .put("scanAt", it.optLong("sinceMillis")).put("lastId", 0).put("parserVersion", SmsCandidateFilter.VERSION)
                    }
                }
            }
            if (!config.optBoolean("enabled") || config.optString("token") != expectedToken || isStopped) return Result.success()
            val scan = plan(config)
            val fullScan = scan.fullScan
            val since = scan.since
            val known = scan.known.toMutableSet()
            val candidates = mutableListOf<JSONObject>()
            // The user opted into local identification across this date-bounded inbox.
            // Only detector-approved financial Nequi messages may enter the encrypted queue.
            val selection = "type=1 AND date>=? AND date<=? AND (date>=? OR _id>?)"
            var complete = true
            var lastDate = since
            var lastId = config.optLong("lastId")
            val current = store.snapshot()
            if (!current.optBoolean("enabled") || current.optString("token") != expectedToken || isStopped) return Result.success()
            requireNotNull(applicationContext.contentResolver.query(Telephony.Sms.Inbox.CONTENT_URI,
                arrayOf("address", "date", "body", "_id"), selection,
                listOf(config.optLong("sinceMillis").toString(), cutoff.toString(), since.toString(), lastId.toString()).toTypedArray(), "date ASC, _id ASC")).use { cursor ->
                while (cursor.moveToNext() && !isStopped) {
                    if (candidates.size + (config.optJSONArray("queue")?.length() ?: 0) >= 1000) { complete = false; break }
                    val sender = cursor.getString(0)
                    lastDate = cursor.getLong(1)
                    lastId = maxOf(lastId, cursor.getLong(3))
                    val body = cursor.getString(2) ?: continue
                    if (!SmsCandidateFilter.accepts(sender, body)) continue
                    val receivedAt = isoTime(lastDate)
                    val id = SmsCandidateFilter.fingerprint(sender, receivedAt, body)
                    if (!known.add(id)) continue
                    candidates.add(JSONObject().put("externalId", id).put("sender", sender).put("receivedAt", receivedAt)
                        .put("body", body).put("provider", "nequi"))
                }
            }
            store.update {
                if (it.optBoolean("enabled") && it.optString("token") == config.optString("token")) {
                    val queue = it.optJSONArray("queue") ?: JSONArray()
                    val existing = (queue.objects().map { row -> row.getString("externalId") } +
                        it.optJSONArray("done")?.strings().orEmpty()).toSet()
                    for (row in candidates) if (row.getString("externalId") !in existing) queue.put(row)
                    it.put("queue", queue).put("scanAt", if (complete && !isStopped) cutoff else lastDate).put("lastId", lastId)
                    if (fullScan && complete && !isStopped) it.put("fullScanAt", cutoff).put("fullScanInProgress", false)
                }
            }
            SmsJobs.upload(applicationContext)
            Result.success()
        } catch (_: SecurityException) {
            store.update { it.put("error", "permission_required") }; Result.success()
        } catch (_: Exception) {
            runCatching { store.update { it.put("error", "scan_failed") } }; Result.retry()
        }
    }
}

class SmsUploadWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val store = SmsStore(applicationContext)
        return try {
            while (!isStopped) {
                val config = store.snapshot()
                if (!config.optBoolean("enabled") || !smsPermissions(applicationContext)) return Result.success()
                val batch = config.optJSONArray("queue")?.objects().orEmpty().take(50)
                if (batch.isEmpty()) return Result.success()
                val token = config.optString("token")
                val connection = URL(config.getString("origin") + "/v1/sms/import").openConnection() as HttpURLConnection
                val response: JSONObject
                try {
                    connection.requestMethod = "POST"; connection.instanceFollowRedirects = false
                    connection.connectTimeout = 10000; connection.readTimeout = 45000; connection.doOutput = true
                    connection.setRequestProperty("Authorization", "Bearer $token")
                    connection.setRequestProperty("Origin", config.getString("origin"))
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { it.write(JSONObject().put("items", JSONArray(batch)).toString().toByteArray(Charsets.UTF_8)) }
                    val code = connection.responseCode
                    if (code == 401 || code == 403) {
                        store.update { if (it.optString("token") == token) it.put("enabled", false).put("error", "auth_required") }
                        return Result.success()
                    }
                    if (code == 429 || code >= 500) {
                        store.update { it.put("error", "retrying") }; return Result.retry()
                    }
                    if (code !in 200..299) {
                        store.update { it.put("enabled", false).put("error", "import_rejected") }; return Result.failure()
                    }
                    response = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                } finally { connection.disconnect() }
                val results = response.getJSONArray("results").objects()
                val ids = batch.map { it.getString("externalId") }.toSet()
                require(results.size == batch.size && results.map { it.getString("externalId") }.toSet() == ids && results.all { it.getString("externalId") in ids &&
                    it.getString("status") in setOf("registered", "duplicate", "ignored", "pending") })
                store.update {
                    if (it.optString("token") == token && it.optBoolean("enabled")) {
                        it.put("queue", JSONArray(it.optJSONArray("queue")?.objects().orEmpty().filter { row -> row.getString("externalId") !in ids }))
                        it.put("done", JSONArray((it.optJSONArray("done")?.strings().orEmpty() + ids).takeLast(10000)))
                        val terminal = results.filter { row -> row.getString("status") in setOf("registered", "duplicate") }
                            .map { row -> row.getString("externalId") }
                        it.put("terminal", JSONArray((it.optJSONArray("terminal")?.strings().orEmpty() + terminal).distinct().takeLast(10000)))
                        for (counter in listOf("imported", "duplicates", "ignored", "pending")) it.put(counter, 0)
                        for (result in results) {
                            val counter = when (result.getString("status")) { "registered" -> "imported"; "duplicate" -> "duplicates"; "pending" -> "pending"; else -> "ignored" }
                            it.put(counter, it.optInt(counter) + 1)
                        }
                        it.put("lastSync", isoTime(System.currentTimeMillis())).put("error", "")
                    }
                }
            }
            Result.retry()
        } catch (_: Exception) {
            runCatching { store.update { it.put("error", "retrying") } }; Result.retry()
        }
    }
}
