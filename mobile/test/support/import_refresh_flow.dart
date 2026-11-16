import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:mailgasto/core/api.dart';
import 'package:mailgasto/core/format.dart';
import 'package:mailgasto/features/auth/auth.dart';
import 'package:mailgasto/features/expenses/expenses.dart';
import 'package:mailgasto/features/expenses/finance.dart';
import 'package:mailgasto/features/mailboxes/mailboxes.dart';
import 'package:mailgasto/main.dart';
import 'package:timezone/data/latest.dart' as tz;

// Exercise the real navigation and retained screen state without accessing
// Gmail, a live account, secure storage, or any financial mutation endpoint.
Future<void> verifyImportRefresh(WidgetTester tester) async {
  await initializeDateFormatting('es_CO');
  tz.initializeTimeZones();
  final api = ApiClient(Uri.parse('http://localhost:3199'));
  final fixture = _Imports();
  final finance = _Finance(api, fixture);
  final mailboxes = _Mailboxes(api, fixture);
  final container = ProviderContainer(
    overrides: [
      authProvider.overrideWith(_SignedIn.new),
      apiProvider.overrideWithValue(api),
      financeRepositoryProvider.overrideWithValue(finance),
      mailboxRepositoryProvider.overrideWithValue(mailboxes),
      expenseRepositoryProvider.overrideWithValue(_Notices(api, fixture)),
    ],
  );
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    container.dispose();
    api.close();
  });
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const MailGastoApp(links: Stream.empty()),
    ),
  );
  await tester.pumpAndSettle();

  Future<void> tab(String label) async {
    await tester.tap(
      find.descendant(
        of: find.byType(NavigationBar),
        matching: find.text(label),
      ),
    );
    await tester.pumpAndSettle();
  }

  await tab('Movimientos');
  expect(find.text('Importación 1'), findsOneWidget);
  await tab('Perfil');
  fixture.revision = 2;
  await tab('Movimientos');
  expect(find.text('Importación 2'), findsOneWidget);
  expect(find.text('Importación 1'), findsNothing);

  fixture.revision = 3;
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  await tester.pumpAndSettle();
  expect(find.text('Importación 3'), findsOneWidget);

  // Keep the notices provider observed, as the Avisos tab does, to verify
  // reconciliation invalidates notices as well as movements and totals.
  final range = currentRange();
  final history = historyProvider((
    from: range.from,
    to: range.to,
    category: null,
    status: null,
  ));
  final historySubscription = container.listen(history, (_, _) {});
  addTearDown(historySubscription.close);
  await container.read(history.future);
  final movementFilter = (
    from: range.from,
    to: range.to,
    currency: 'COP',
    category: null,
    source: null,
    direction: null,
  );
  final movements = movementsProvider(movementFilter);
  expect(
    container.read(movements).requireValue.items.single.title,
    'Importación 3',
  );

  container.read(routerProvider).go('/settings/mailboxes');
  await tester.pumpAndSettle();
  expect(
    find.textContaining('2 por procesar (1 en reintento) · 1 con error'),
    findsOneWidget,
  );
  expect(
    find.textContaining('El servicio de procesamiento no respondió.'),
    findsOneWidget,
  );
  final reprocess = find.text('Reprocesar este mes');
  await tester.ensureVisible(reprocess);
  await tester.tap(reprocess);
  await tester.pumpAndSettle();
  expect(find.text('Revisando correos del mes'), findsOneWidget);

  fixture.revision = 4;
  fixture.finished = true;
  final movementReads = finance.movementReads;
  final analyticsReads = finance.analyticsReads;
  await tester.pump(const Duration(seconds: 4));
  await tester.pumpAndSettle();
  expect(find.text('Revisión del mes completada'), findsOneWidget);
  // Riverpod pauses offstage consumers; reading their futures resumes the
  // invalidated queries without a navigation event masking the refresh.
  await container.read(movements.future);
  await container.read(analyticsProvider(range).future);
  expect(finance.movementReads, greaterThan(movementReads));
  expect(finance.analyticsReads, greaterThan(analyticsReads));
  expect(
    container.read(movements).requireValue.items.single.title,
    'Importación 4',
  );
  expect(container.read(history).requireValue.items.single.id, 'notice-4');

  final mailboxReads = mailboxes.reads;
  await tester.pump(const Duration(seconds: 12));
  await tester.pumpAndSettle();
  expect(
    mailboxes.reads,
    mailboxReads,
    reason: 'Polling stops after completion',
  );
  await tab('Movimientos');
  expect(find.text('Importación 4'), findsOneWidget);
}

class _SignedIn extends AuthViewModel {
  @override
  Future<Account?> build() async => (
    id: 'synthetic-import-refresh',
    name: 'Prueba de actualización',
    email: 'refresh@example.test',
  );
}

class _Imports {
  int revision = 1;
  bool started = false;
  bool finished = false;
}

class _Finance extends FinanceRepository {
  _Finance(super.api, this.fixture);
  final _Imports fixture;
  int movementReads = 0;
  int analyticsReads = 0;

  @override
  Future<MovementPage> list(MovementFilter filter, {int page = 1}) async {
    movementReads++;
    return (
      items: [
        Movement.fromJson({
          'id': 'movement-${fixture.revision}',
          'source': 'email',
          'direction': 'expense',
          'amount_minor': '${fixture.revision * 10000}',
          'transaction_date': isoDay(bogotaNow()),
          'currency': 'COP',
          'category': 'compras',
          'description': 'Importación ${fixture.revision}',
        }),
      ],
      page: page,
      hasMore: false,
    );
  }

  @override
  Future<Analytics> analytics(FinanceRange range) async {
    analyticsReads++;
    return Analytics.fromJson({
      'incomeMinor': '0',
      'expenseMinor': '${fixture.revision * 10000}',
      'balanceMinor': '-${fixture.revision * 10000}',
      'series': <Json>[],
      'expenseCategories': <Json>[],
      'incomeSources': <Json>[],
    });
  }
}

class _Notices extends ExpenseRepository {
  _Notices(super.api, this.fixture);
  final _Imports fixture;

  @override
  Future<HistoryPage> history(HistoryFilters filters, {int page = 1}) async => (
    items: [
      Notice.fromJson({
        'id': 'notice-${fixture.revision}',
        'provider': 'nequi',
        'status': 'pending',
        'received_at': DateTime.now().toUtc().toIso8601String(),
      }),
    ],
    page: page,
    hasMore: false,
  );
}

class _Mailboxes extends MailboxRepository {
  _Mailboxes(super.api, this.fixture);
  final _Imports fixture;
  int reads = 0;

  @override
  Future<List<Mailbox>> list() async {
    reads++;
    return [
      (
        id: 'synthetic-mailbox',
        email: 'refresh@example.test',
        state: 'active',
        source: 'oauth',
        syncedAt: null,
        openAiAvailable: false,
        openAiEnabled: false,
        delivery: DeliveryStatus({
          'queued': 2,
          'retrying': 1,
          'failed': 1,
          'lastError': 'callback_timeout',
        }),
        reprocess: fixture.started
            ? ReprocessStatus({
                'finishedAt': fixture.finished
                    ? DateTime.now().toIso8601String()
                    : null,
                'scanning': false,
                'queued': fixture.finished ? 0 : 1,
                'summary': {'registered': fixture.finished ? 1 : 0},
              })
            : null,
      ),
    ];
  }

  @override
  Future<void> reprocessMonth(String id) async {
    fixture.started = true;
  }
}
