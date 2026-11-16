import 'package:flutter_test/flutter_test.dart';

import 'support/import_refresh_flow.dart';
import 'support/received_date_flow.dart';

void main() {
  testWidgets(
    'Actualiza importaciones al navegar, reanudar y terminar la revisión',
    verifyImportRefresh,
  );
  testWidgets(
    'La fecha de recepción se identifica y puede corregirse',
    verifyReceivedDate,
  );
}
