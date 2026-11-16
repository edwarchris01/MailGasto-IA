package co.com.styleplus.mailgasto.sms

import java.util.concurrent.TimeUnit

data class SmsScanPlan(val startsReview: Boolean, val fullScan: Boolean, val since: Long, val known: Set<String>)

object SmsReviewPolicy {
    fun plan(
        start: Long, scanAt: Long, fullScanAt: Long, reviewing: Boolean,
        savedVersion: Int, version: Int, now: Long,
        reviewed: Collection<String>, terminal: Collection<String>, queued: Collection<String>
    ): SmsScanPlan {
        val starts = !reviewing && (savedVersion != version || now - fullScanAt >= TimeUnit.DAYS.toMillis(1))
        val full = reviewing || starts
        val cursor = if (starts) start else scanAt
        val since = maxOf(start, if (full) cursor else cursor - TimeUnit.HOURS.toMillis(6))
        return SmsScanPlan(starts, full, since, ((if (starts) terminal else reviewed) + queued).toSet())
    }
}
