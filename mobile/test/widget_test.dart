import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mailgasto/core/format.dart';
import 'package:mailgasto/features/auth/auth.dart';
import 'package:mailgasto/features/expenses/expenses.dart';
import 'package:mailgasto/main.dart';

class _Guest extends AuthViewModel {
  @override
  Future<Account?> build() async => null;
}

void main() {
  testWidgets('El registro se abre antes del menú principal', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [authProvider.overrideWith(_Guest.new)],
        child: const MailGastoApp(links: Stream.empty()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Iniciar sesión'), findsOneWidget);
    expect(find.text('Historial'), findsNothing);
    await tester.tap(find.text('Crear cuenta'));
    await tester.pumpAndSettle();
    expect(find.text('Registrarme'), findsOneWidget);
  });

  test('Formatea centavos exactos sin convertir a double', () {
    expect(
      money(BigInt.parse('9999999999999999999'), 'COP'),
      'COP 99.999.999.999.999.999,99',
    );
  });

  test('El mes anterior funciona en un cambio de año', () {
    expect(dateFilter(monthRange(DateTime(2026, 1, 3), previous: true)), (
      from: '2025-12-01',
      to: '2025-12-31',
    ));
  });

  test('El aviso nuevo muestra campos y el histórico conserva el motivo', () {
    final pending = <String, dynamic>{
      'id': 'pending',
      'provider': 'nequi',
      'status': 'pending',
      'reason': 'missing_or_ambiguous_fields',
      'received_at': '2026-11-10T15:00:00Z',
    };
    expect(
      Notice.fromJson(pending).pendingExplanation,
      contains('incompletos o ambiguos'),
    );
    expect(
      Notice.fromJson({
        ...pending,
        'unconfirmed_fields': ['amount'],
      }).pendingExplanation,
      'Datos por confirmar: monto.',
    );
  });
}
