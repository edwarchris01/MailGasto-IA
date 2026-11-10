import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mailgasto/main.dart' as app;

const _origin = String.fromEnvironment('API_BASE_URL');
const _mailpit = String.fromEnvironment('TEST_MAILPIT_URL');
const _email = 'movil-qa@example.test';
const _password = 'synthetic-mobile-password';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Flujo Android con NestJS y Mailpit locales',
    (tester) async {
      const storage = FlutterSecureStorage();
      await storage.delete(key: 'mailgasto_session@$_origin');
      addTearDown(() => storage.delete(key: 'mailgasto_session@$_origin'));
      app.main();
      await _settle(tester);
      expect(find.text('Iniciar sesión'), findsOneWidget);

      await _tap(tester, 'Crear cuenta');
      final newEmail =
          'movil-nuevo-${DateTime.now().millisecondsSinceEpoch}@example.test';
      await _enter(tester, 'name', 'Usuario ficticio');
      await _enter(tester, 'email', newEmail);
      await _enter(tester, 'password', _password);
      await _tap(tester, 'Registrarme');
      await _waitFor(tester, find.textContaining('Revisa tu correo'));
      expect(find.textContaining('Revisa tu correo'), findsOneWidget);
      await _tap(tester, 'Volver a iniciar sesión');

      await _login(tester, newEmail);
      await _waitFor(
        tester,
        find.text('Verifica tu correo antes de iniciar sesión.'),
      );
      expect(
        find.text('Verifica tu correo antes de iniciar sesión.'),
        findsOneWidget,
      );
      await _verifyEmail(newEmail);
      await _tap(tester, 'Iniciar sesión');
      await _waitFor(tester, find.text('COP 0,00'));
      expect(find.text('COP 0,00'), findsOneWidget);
      await _logout(tester);

      await _login(tester, _email);
      await _waitFor(tester, find.text('COP 25.000,00'));
      expect(find.text('COP 25.000,00'), findsWidgets);
      await tester.pumpWidget(const SizedBox.shrink());
      await _settle(tester);
      app.main();
      await _settle(tester);
      expect(find.text('COP 25.000,00'), findsWidgets);

      await tester.tap(find.byKey(const ValueKey('home-period')));
      await _settle(tester);
      await _tap(tester, 'Mes anterior');
      expect(find.text('COP 5.000,00'), findsWidgets);
      await tester.tap(find.byKey(const ValueKey('home-period')));
      await _settle(tester);
      await _tap(tester, 'Este mes');
      await _tap(tester, 'Ver avisos pendientes');
      expect(find.text('COP 25.000,00'), findsNothing);
      await _tap(tester, 'Nequi');
      expect(find.text('Datos por confirmar: monto.'), findsOneWidget);
      await tester.tap(find.byType(BackButton).hitTestable());
      await _settle(tester);
      await _tap(tester, 'Limpiar filtros');
      expect(find.text('USD 12,50'), findsOneWidget);

      await _tap(tester, 'Asistente');
      await _tap(tester, '¿Cuánto gasté en alimentación este mes?');
      await tester.tap(find.byTooltip('Enviar'));
      await _settle(tester);
      expect(find.textContaining('COP 25.000,00'), findsOneWidget);
      await _enter(tester, 'chat-question', 'Total de ocio este mes');
      await tester.tap(find.byTooltip('Enviar'));
      await _settle(tester);
      expect(
        find.textContaining(
          RegExp(
            r'\d{4}-\d{2}-\d{2} a \d{4}-\d{2}-\d{2}.*No hay gastos registrados',
          ),
        ),
        findsOneWidget,
      );

      await _tap(tester, 'Configuración');
      await _tap(tester, 'Buzones');
      expect(find.textContaining('Última sincronización:'), findsOneWidget);
      await _tap(tester, 'Vincular cuenta');
      expect(find.textContaining('solo lectura'), findsOneWidget);
      await _tap(tester, 'Cancelar');
      await _tap(tester, 'Desvincular');
      await _tap(tester, 'Desvincular');
      await _waitFor(tester, find.text('Desvinculado'));
      expect(find.text('Desvinculado'), findsOneWidget);
      await _tap(tester, 'Reconectar');
      await _waitFor(tester, find.text('Vinculado'));
      expect(find.text('Vinculado'), findsOneWidget);
      await tester.tap(find.byType(BackButton).hitTestable());
      await _settle(tester);
      await _tap(tester, 'Cerrar sesión');
      expect(find.text('Iniciar sesión'), findsOneWidget);
    },
    skip:
        _origin != 'http://localhost:3105' ||
        _mailpit != 'http://localhost:8026',
  );
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pumpAndSettle(
    const Duration(milliseconds: 100),
    EnginePhase.sendSemanticsUpdate,
    const Duration(seconds: 25),
  );
}

Future<void> _waitFor(WidgetTester tester, Finder target) async {
  final until = DateTime.now().add(const Duration(seconds: 15));
  while (target.evaluate().isEmpty && DateTime.now().isBefore(until)) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _tap(WidgetTester tester, String text) async {
  final target = find.text(text).last;
  await tester.ensureVisible(target);
  await tester.tap(target);
  await _settle(tester);
}

Future<void> _enter(WidgetTester tester, String key, String text) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await tester.enterText(target, text);
  await tester.pump();
}

Future<void> _login(WidgetTester tester, String email) async {
  await _enter(tester, 'email', email);
  await _enter(tester, 'password', _password);
  await _tap(tester, 'Iniciar sesión');
}

Future<void> _logout(WidgetTester tester) async {
  await _tap(tester, 'Configuración');
  await _tap(tester, 'Cerrar sesión');
}

Future<void> _verifyEmail(String email) async {
  final client = Dio(BaseOptions(connectTimeout: const Duration(seconds: 5)));
  try {
    String? code;
    for (var i = 0; i < 20 && code == null; i++) {
      final response = await client.get<Map<String, dynamic>>(
        '$_mailpit/api/v1/search',
        queryParameters: {'query': 'to:$email'},
      );
      final messages = response.data?['messages'] as List? ?? [];
      if (messages.isNotEmpty) {
        final id = (messages.first as Map)['ID'];
        final mail = await client.get<Map<String, dynamic>>(
          '$_mailpit/api/v1/message/$id',
        );
        code = RegExp(
          r'#verify=([A-Za-z0-9_-]{43})',
        ).firstMatch(mail.data?['Text'] as String? ?? '')?.group(1);
      } else {
        await Future<void>.delayed(const Duration(milliseconds: 300));
      }
    }
    expect(code, isNotNull);
    final verified = await client.post<void>(
      '$_origin/v1/auth/verify',
      data: {'token': code, 'password': _password},
      options: Options(headers: {'Origin': _origin}),
    );
    expect(verified.statusCode, 204);
  } finally {
    client.close();
  }
}
