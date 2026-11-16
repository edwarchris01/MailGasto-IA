import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/support/import_refresh_flow.dart';
import '../test/support/received_date_flow.dart';
import '../test/support/sms_opt_in_flow.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Android actualiza las importaciones sin refresco manual',
    verifyImportRefresh,
  );
  testWidgets(
    'Android identifica la recepción y permite corregir el movimiento',
    (tester) => verifyReceivedDate(tester),
  );
  testWidgets(
    'Android prueba opt-in SMS con permisos simulados',
    verifySmsOptIn,
  );
  testWidgets(
    'Android permite corregir un SMS sintético',
    (tester) => verifyReceivedDate(tester, source: 'sms'),
  );
}
