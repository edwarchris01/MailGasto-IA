import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mailgasto/main.dart' as app;

const _origin = String.fromEnvironment('API_BASE_URL');
const _email = String.fromEnvironment('TEST_GMAIL_E2E_EMAIL');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Android muestra el aviso procesado por n8n y PostgreSQL',
    (tester) async {
      const storage = FlutterSecureStorage();
      const key = 'mailgasto_session@$_origin';
      await storage.delete(key: key);
      addTearDown(() => storage.delete(key: key));

      Future<void> waitFor(Finder target, {int seconds = 20}) async {
        final deadline = DateTime.now().add(Duration(seconds: seconds));
        while (target.evaluate().isEmpty && DateTime.now().isBefore(deadline)) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(target, findsWidgets);
      }

      Future<void> tap(Finder target) async {
        await waitFor(target);
        await tester.ensureVisible(target.first);
        await tester.pumpAndSettle();
        await tester.tap(target.hitTestable().first);
        await tester.pump();
      }

      Finder tab(String label) => find.descendant(
        of: find.byType(NavigationBar),
        matching: find.text(label),
      );

      app.main();
      await waitFor(find.byKey(const ValueKey('email')));
      await tester.enterText(find.byKey(const ValueKey('email')), _email);
      await tester.enterText(
        find.byKey(const ValueKey('password')),
        'synthetic-gmail-e2e-password',
      );
      await tap(find.text('Iniciar sesión'));
      await waitFor(find.text('COP 50.025,00'));

      await tap(tab('Movimientos'));
      await tap(find.text('Categoría'));
      await tap(find.text('Compras'));
      final movement = find.text('− COP 50.000,00');
      await waitFor(movement);
      expect(movement, findsOneWidget);
      expect(find.text('− COP 25,00'), findsNothing);
      await tap(movement);
      await waitFor(find.text('Detalle del movimiento'));
      await waitFor(
        find.textContaining(RegExp('agaval', caseSensitive: false)),
      );
      await waitFor(find.text('Compras'));
      await waitFor(find.text('Sin especificar'));
      await tap(find.byType(BackButton));

      await tap(tab('Análisis'));
      await waitFor(find.text('Gastos por categoría'));
      await waitFor(find.text('Compras · COP 50.000,00'));

      await tap(tab('Asistente'));
      await tap(find.text('¿Cuánto gasté en alimentación este mes?'));
      await tap(find.byTooltip('Enviar'));
      await waitFor(find.textContaining('COP 25,00'), seconds: 40);
    },
    skip:
        _origin != 'http://localhost:3116' || !_email.endsWith('@example.test'),
  );
}
