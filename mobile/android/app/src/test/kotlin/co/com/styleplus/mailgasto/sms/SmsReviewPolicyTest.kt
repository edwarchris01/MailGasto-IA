package co.com.styleplus.mailgasto.sms

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class SmsReviewPolicyTest {
    private val day = TimeUnit.DAYS.toMillis(1)
    private val start = day * 10

    @Test fun ruleUpgradeRecoversUnsupportedButKeepsRegisteredTerminal() {
        val same = SmsReviewPolicy.plan(start, start + 1000, start + 1000, false,
            1, 1, start + 2000, listOf("registered", "unsupported"), listOf("registered"), emptyList())
        assertFalse(same.startsReview)
        assertTrue("unsupported" in same.known)
        val upgraded = SmsReviewPolicy.plan(start, start + 1000, start + 1000, false,
            1, 2, start + 2000, listOf("registered", "unsupported"), listOf("registered"), emptyList())
        assertTrue(upgraded.startsReview)
        assertEquals(start, upgraded.since)
        assertEquals(setOf("registered"), upgraded.known)
        val daily = SmsReviewPolicy.plan(start, start + 1000, start + 1000, false,
            1, 1, start + day + 1001, listOf("registered", "unsupported"), listOf("registered"), emptyList())
        assertTrue(daily.startsReview)
        assertFalse("unsupported" in daily.known)
    }

    @Test fun offlineQueueSurvivesCursorProgressAndDoesNotRepeatTheSamePage() {
        val cursor = start + TimeUnit.HOURS.toMillis(12)
        val continuing = SmsReviewPolicy.plan(start, cursor, 0, true,
            2, 2, cursor + 1000, listOf("pending-result"), emptyList(), listOf("offline-item"))
        assertFalse(continuing.startsReview)
        assertTrue(continuing.fullScan)
        assertEquals(cursor, continuing.since)
        assertEquals(setOf("pending-result", "offline-item"), continuing.known)
        val dailyOffline = SmsReviewPolicy.plan(start, cursor, cursor, false,
            2, 2, cursor + day + 1, listOf("pending-result"), emptyList(), listOf("offline-item"))
        assertTrue(dailyOffline.startsReview)
        assertEquals(setOf("offline-item"), dailyOffline.known)
        assertEquals(start, dailyOffline.since)
    }
}
