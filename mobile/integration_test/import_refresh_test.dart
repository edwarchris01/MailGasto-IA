import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/support/import_refresh_flow.dart';
import '../test/support/received_date_flow.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Android actualiza las importaciones sin refresco manual',
    verifyImportRefresh,
  );
  testWidgets(
    'Android identifica la recepción y permite corregir el movimiento',
    verifyReceivedDate,
  );
}
