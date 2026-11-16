package co.com.styleplus.mailgasto.sms

import org.junit.Assert.*
import org.junit.Test

class SmsCandidateFilterTest {
    @Test fun detectsNequiWithoutConfiguredShortcodes() {
        val samples = listOf(
            "890001" to "Nequi: te enviaron COP 25.000.",
            "890001" to "Nequi: Ana te envió $300.000.",
            "890001" to "Nequi: Te llegó plata por $50.000.",
            "890001" to "Nequi: Has recibido $50.000.",
            "890001" to "Has recibido COP50.000 en tu Nequi.",
            "890001" to "Ana te envió $50.000 en tu Nequi.",
            "890001" to "Nequi: recibiste 25.000 de PERSONA SINTETICA.",
            "890001" to "Nequi te informa que recibiste COP 25.000.",
            "Nequi" to "Recibiste COP 25.000.",
            "NEQUI" to "Enviaste COP 25.000.",
            "890001" to "Recibiste COP 25.000 en tu Nequi.",
            "890001" to "Enviaste COP 25.000 desde tu Nequi.",
            "890001" to "Nequi: Recibiste COP 25.000 desde el banco Davivienda.",
            "890001" to "Nequi: Pagaste COP80000 mediante PSE. Código único de seguimiento:123456789012",
            "890001" to "Nequi: Pagaste COP80000 mediante PSE. Tu codigo unico de seguimiento:123456789012",
            "890001" to "Nequi: Te reembolsaron COP80000",
            "890001" to "NEQUI: Reversamos 300,00 de tu compra en COMERCIO SINTETICO a tu Tarjeta",
            "890001" to "Nequi: Tu compra por COP80000 fue cancelada. Te reembolsaron COP80000",
            "890001" to "Nequi: Enviaste de manera exitosa 80.000 a la llave sintética.",
            "890001" to "Nequi: Pagaste COP 80.000. Si tu pago fue rechazado, comunícate con nosotros.",
            "890001" to "Nequi: Pagaste COP 80.000. En caso de que tu pago sea rechazado, comunícate con nosotros."
        )
        for ((sender, body) in samples) assertTrue(body, SmsCandidateFilter.accepts(sender, body))
    }

    @Test fun excludesPrivateSecurityAndIneffectiveMessagesBeforeQueueing() {
        val samples = listOf(
            "890002" to "Recibiste COP 25.000.",
            "890002" to "Enviaste COP 25.000 a Nequi.",
            "890002" to "Bancolombia: Enviaste COP 25.000 a Nequi.",
            "Bancolombia" to "Recibiste COP 25.000 en tu Nequi.",
            "Davivienda" to "Nequi: Recibiste COP 25.000.",
            "890002" to "Banco de Bogota: Pagaste COP 25.000 desde tu Nequi.",
            "890002" to "Tu compra por COP 25.000 está disponible. Puedes pagar en Nequi.",
            "Nequi" to "Tu código es 123456. Pagaste COP 80.000.",
            "Nequi" to "Recibiste 123456, este es tu codigo.",
            "Nequi" to "Tu PIN 1234 autoriza una compra de COP 80.000.",
            "Nequi" to "Código para retirar 654321 por COP 80.000.",
            "Nequi" to "Compraste COP 80.000. Estado: Pendiente.",
            "Nequi" to "Tu pago por COP 80.000 fue rechazado.",
            "Nequi" to "Transferencia cancelada por COP 80.000.",
            "Nequi" to "Reembolso pendiente por COP 80.000.",
            "Nequi" to "No reversamos 300,00 de tu compra en COMERCIO SINTETICO.",
            "Nequi" to "Nunca reversamos 300,00 de tu compra en COMERCIO SINTETICO.",
            "Nequi" to "No te reversamos 300,00 de tu compra en COMERCIO SINTETICO.",
            "Nequi" to "Nunca te reversamos 300,00 de tu compra en COMERCIO SINTETICO.",
            "Nequi" to "Reversaremos 300,00 de tu compra en COMERCIO SINTETICO.",
            "Nequi" to "Si reversamos 300,00 de tu compra, te avisaremos.",
            "Nequi" to "Reversamos 300,00 de tu compra. Estado: pendiente.",
            "Nequi" to "No te alcanzo para pagar 19.900,00 en COMERCIO SINTETICO.",
            "Nequi" to "No recibiste COP 80.000.",
            "Nequi" to "No has recibido COP 80.000.",
            "Nequi" to "No te llegó COP 80.000.",
            "Nequi" to "No te reembolsaron COP 80.000.",
            "Nequi" to "No te enviaron COP 50.000.",
            "Nequi" to "No se te enviaron COP 50.000.",
            "Nequi" to "Si Ana te envió $50.000, revisa movimientos.",
            "Nequi" to "Tal vez Ana te envió $50.000.",
            "Nequi" to "Recibiste COP 0,00.",
            "Nequi" to "Recibiste 3001234567.",
            "Nequi" to "Tu saldo disponible es COP 80.000.",
            "Amigo" to "¿Puedes enviarme COP 25.000 para el almuerzo?"
        )
        for ((sender, body) in samples) assertFalse(body, SmsCandidateFilter.accepts(sender, body))
        assertFalse(SmsCandidateFilter.accepts("Nequi", "Recibiste COP25.000. " + "x".repeat(5000)))
    }

    @Test fun duplicateIdentityRetainsDistinctReceiptTimes() {
        val body = "Nequi: Recibiste COP25.000."
        val first = SmsCandidateFilter.fingerprint("Nequi", "2026-11-15T12:00:00.000Z", body)
        assertEquals(first, SmsCandidateFilter.fingerprint(" NEQUI ", "2026-11-15T12:00:00.000Z", body))
        assertNotEquals(first, SmsCandidateFilter.fingerprint("Nequi", "2026-11-15T12:01:00.000Z", body))
    }
}
