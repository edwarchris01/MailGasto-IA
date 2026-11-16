import 'package:flutter_test/flutter_test.dart';

import 'support/import_refresh_flow.dart';
import 'support/received_date_flow.dart';
import 'support/sms_opt_in_flow.dart';

void main() {
  testWidgets(
    'Actualiza importaciones al navegar, reanudar y terminar la revisión',
    verifyImportRefresh,
  );
  testWidgets(
    'La fecha de recepción se identifica y puede corregirse',
    (tester) => verifyReceivedDate(tester),
  );
  testWidgets(
    'SMS requiere permiso y limpia el acceso al desactivar',
    verifySmsOptIn,
  );
  testWidgets(
    'Un movimiento SMS conserva su origen y puede corregirse',
    (tester) => verifyReceivedDate(tester, source: 'sms'),
  );
}
