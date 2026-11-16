package co.com.styleplus.mailgasto.sms

import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale

object SmsCandidateFilter {
    const val VERSION = 1
    fun normalize(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFD)
        .replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT)

    private val secret = Regex("\\b(?:otp|pin|nip|contrasena|token|clave(?: dinamica| temporal| de seguridad| de acceso)?|codigo (?:de (?:seguridad|verificacion|acceso|ingreso|autenticacion|confirmacion|retiro)|para (?:ingresar|entrar|retirar|verificar|confirmar)|dinamico|temporal|otp)|tu codigo(?! (?:unico de seguimiento|(?:de )?(?:transaccion|operacion|referencia))\\b)|no compartas (?:este|tu|el) codigo)\\b")
    private val unsuccessful = Regex(
        "\\b(rechaz\\w*|cancel\\w*|pendiente\\w*|fallid\\w*|fallo|solicitud|solicita|promocion|oferta)\\b|" +
            "\\bno (pudimos|pudo|se pudo|fue posible|se realizo)\\b|\\bpuedes (pagar|comprar|enviar)\\b"
    )
    private val settled = Regex(
        "\\b(recibiste|pagaste|compraste|enviaste|transferiste|retiraste|sacaste|realizaste|has recibido)\\b|" +
            "\\bte (llego|llegaron|envio|enviaron|mando|mandaron|transfirieron|abonaron|acreditaron|reembolsaron|devolvieron)\\b|" +
            "\\b(transferencia|pago|compra|retiro|reembolso) (exitosa?|realizad[oa]|aprobad[oa]|acreditad[oa]|aplicad[oa])\\b"
    )
    private val amount = Regex("(?:\\$\\s*|\\bcop\\s*|\\b(?:recibiste|pagaste|compraste|enviaste|transferiste|retiraste|sacaste|has recibido)\\s+(?:de manera exitosa\\s+)?)[0-9][0-9.,]*")

    fun accepts(sender: String, body: String): Boolean {
        if (body.isBlank() || body.length > 5000) return false
        val normalized = normalize(body)
        val from = normalize(sender.trim())
        val otherBank = Regex("^(?:bancolombia|davivienda|daviplata|bbva|(?:banco (?:de |del )?)?bogota|banco ?popular|banco (?:de )?occidente|banco caja social|av ?villas|scotiabank|colpatria|itau|lulo(?: bank)?|nu(?:bank)?|movii|rappipay|dale)(?=[\\s:：-]|$)")
        if (otherBank.containsMatchIn(from) || otherBank.containsMatchIn(normalized.trimStart())) return false
        val nequi = from == "nequi" || Regex("^\\s*nequi(?:\\s*[:：-]|\\s+te\\s+(?:informa|cuenta)\\b)").containsMatchIn(normalized) ||
            Regex("\\b(?:recibiste|has recibido|te envio|te llego|te enviaron|te transfirieron|te abonaron|te acreditaron)\\b(?:[^.!?\\n;]|\\.(?=\\d)){0,220}\\ben tu nequi\\b").containsMatchIn(normalized) ||
            Regex("\\b(?:enviaste|transferiste|pagaste|compraste|retiraste)\\b(?:[^.!?\\n;]|\\.(?=\\d)){0,220}\\bdesde tu nequi\\b").containsMatchIn(normalized)
        if (!nequi) return false
        val principal = normalized.split(Regex("(?:[.!?]\\s+|\\n)(?:si|en caso de que)\\s+"), limit = 2).first()
        val firstMovement = settled.find(principal)?.range?.first ?: return false
        if (Regex("\\b(?:si|cuando|en caso|quizas?|tal vez|podria|habria)\\b").containsMatchIn(principal.substring(0, firstMovement))) return false
        val refund = Regex("\\b(?:te (?:reembolsaron|devolvieron)|reembolso (?:acreditado|aplicado|realizado))\\b").find(principal)
            ?.takeUnless { Regex("\\bno\\s*$").containsMatchIn(principal.substring(0, it.range.first)) }
        val operation = refund?.let { principal.substring(it.range.first) } ?: principal
        val negated = Regex("\\bno (?:has recibido|te (?:llego|envio|reembolsaron|devolvieron|transfirieron|abonaron|acreditaron)|(?:se )?(?:recib\\w*|envi\\w*|pag\\w*|realiz\\w*|transfer\\w*|apro\\w*|complet\\w*|confirm\\w*|retir\\w*))")
        val hasAmount = amount.findAll(operation).any {
            val value = it.value
            value.any { char -> char in '1'..'9' } &&
                (value.startsWith("$") || value.startsWith("cop") || Regex("\\d[.,]\\d").containsMatchIn(value) || value.count(Char::isDigit) <= 8)
        }
        return !secret.containsMatchIn(normalized) && !unsuccessful.containsMatchIn(operation) && !negated.containsMatchIn(operation) &&
            settled.containsMatchIn(operation) && hasAmount
    }

    fun fingerprint(sender: String, receivedAt: String, body: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest("${sender.trim().lowercase(Locale.ROOT)}\n$receivedAt\n${body.trim()}".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
