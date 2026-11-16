import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:mailgasto/core/api.dart';
import 'package:mailgasto/core/design.dart';
import 'package:mailgasto/features/expenses/finance.dart';
import 'package:mailgasto/features/expenses/movements_screen.dart';
import 'package:timezone/data/latest.dart' as tz;

// The real detail and correction screens, with an in-memory repository.
// Never writes to a real account or reads its secure storage.
Future<void> verifyReceivedDate(WidgetTester tester) async {
  await initializeDateFormatting('es_CO');
  tz.initializeTimeZones();
  final api = ApiClient(Uri.parse('http://localhost:3199'));
  final repository = _ReceiptFinance(api);
  final container = ProviderContainer(
    overrides: [financeRepositoryProvider.overrideWithValue(repository)],
  );
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, _) => const MovementScreen('receipt')),
      GoRoute(
        path: '/history/movement/receipt/correction',
        builder: (_, _) =>
            const MovementScreen('receipt', view: MovementView.correction),
      ),
    ],
  );
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    router.dispose();
    container.dispose();
    api.close();
  });
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: mailGastoTheme(),
        routerConfig: router,
        locale: const Locale('es', 'CO'),
        supportedLocales: const [Locale('es', 'CO')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
      ),
    ),
  );
  await tester.pumpAndSettle();
  expect(find.text('Fecha estimada (recepción)'), findsOneWidget);
  // UTC receipt is the following day; the UI must use Bogotá's date/time.
  expect(find.text('15/11/2026 23:40'), findsOneWidget);
  expect(find.text('Fecha tomada del correo'), findsOneWidget);
  expect(find.text('Hora indicada'), findsNothing);

  final correction = find.widgetWithText(OutlinedButton, 'Corregir datos');
  await tester.ensureVisible(correction);
  await tester.pumpAndSettle();
  await tester.tap(correction);
  await tester.pumpAndSettle();
  expect(find.text('Fecha original tomada del correo'), findsOneWidget);
  await tester.enterText(
    find.byKey(const ValueKey('movement-amount')),
    '51000',
  );
  final date = find.byKey(const ValueKey('movement-date'));
  await tester.ensureVisible(date);
  await tester.pumpAndSettle();
  await tester.tap(date);
  await tester.pumpAndSettle();
  await tester.tap(find.text('14').last);
  final accept = MaterialLocalizations.of(
    tester.element(find.byType(DatePickerDialog)),
  ).okButtonLabel;
  await tester.tap(find.text(accept));
  await tester.pumpAndSettle();
  final save = find.widgetWithText(FilledButton, 'Guardar cambios');
  await tester.ensureVisible(save);
  await tester.pumpAndSettle();
  await tester.tap(save);
  await tester.pumpAndSettle();

  expect(repository.saved, {
    'revision': 0,
    'amountMinor': '5100000',
    'date': '2026-11-14',
  });
  expect(find.text('Fecha estimada (recepción)'), findsNothing);
  expect(find.text('14 nov 2026'), findsOneWidget);
  expect(find.text('14 nov 2026 · 23:40'), findsNothing);
  expect(find.text('Recepción del correo'), findsOneWidget);
  expect(find.text('15/11/2026 23:40'), findsOneWidget);
}

class _ReceiptFinance extends FinanceRepository {
  _ReceiptFinance(super.api);

  Json? saved;

  @override
  Future<Movement> detail(String id) async => Movement.fromJson({
    'id': id,
    'source': 'email',
    'direction': 'expense',
    'amount_minor': saved?['amountMinor'] ?? '5000000',
    'transaction_date': saved?['date'] ?? '2026-11-15',
    'currency': 'COP',
    'category': 'otros',
    'description': 'Transferencia de prueba',
    'date_source': 'received_at',
    'received_at': '2026-11-16T04:40:00Z',
    'reported_transaction_date': null,
    'transaction_time': '23:40',
    'original_amount_minor': '5000000',
    'original_transaction_date': '2026-11-15',
    'correction_revision': saved == null ? 0 : 1,
  });

  @override
  Future<void> correct(String id, Json data) async {
    saved = data;
  }
}
