import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
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
      expect(_loginButton, findsOneWidget);
      await _tap(tester, 'Continuar con Google');
      final googleUnavailable = find.textContaining(
        'todavía no está disponible en este servidor',
      );
      await _waitFor(tester, googleUnavailable);
      expect(googleUnavailable, findsOneWidget);

      await _tap(tester, 'Crear cuenta');
      final newEmail =
          'movil-nuevo-${DateTime.now().millisecondsSinceEpoch}@example.test';
      await _enter(tester, 'name', 'Usuario ficticio');
      await _enter(tester, 'email', newEmail);
      await _enter(tester, 'password', _password);
      await _tapFinder(
        tester,
        find.widgetWithText(FilledButton, 'Crear cuenta'),
      );
      await _waitFor(tester, find.text('Verifica tu correo'));
      expect(find.text('Verifica tu correo'), findsOneWidget);
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
      await _tapFinder(tester, _loginButton);
      await _waitFor(tester, find.text(r'$0'));
      expect(find.text(r'$0'), findsWidgets);
      expect(find.text('Vincular Gmail'), findsOneWidget);

      await _tap(tester, 'Registrar movimiento');
      await _tap(tester, 'Ingreso');
      await _enter(tester, 'movement-amount', '1.650.000');
      await _enter(tester, 'movement-description', 'Ingreso QA');
      await _tap(tester, 'Guardar ingreso');
      await _waitFor(tester, find.text('Ingreso QA'));
      expect(find.text('Ingreso QA'), findsOneWidget);
      await _tap(tester, 'Registrar movimiento');
      await _tap(tester, 'Gasto');
      await _enter(tester, 'movement-amount', '486.000');
      await _tapFinder(tester, find.byKey(const ValueKey('movement-category')));
      await _tap(tester, 'Alimentación');
      await _enter(tester, 'movement-description', 'Gasto QA');
      await _tap(tester, 'Guardar gasto');
      await _waitFor(tester, find.text('Gasto QA'));
      expect(find.text('Gasto QA'), findsOneWidget);

      await _tab(tester, 'Análisis');
      await _waitFor(tester, find.text('Ingresos vs. gastos'));
      await _tap(tester, 'Ver tabla');
      await _show(tester, find.text(r'+ $1.164.000'));
      expect(find.text(r'+ $1.164.000'), findsOneWidget);

      await _tap(tester, 'Volver a la gráfica');
      await _tap(tester, 'Ver desgloses');
      expect(find.text('Ingresos por origen de registro'), findsOneWidget);
      await _tap(tester, 'Alimentación');
      await _waitFor(tester, find.text('Gasto QA'));
      expect(find.text('Gasto QA'), findsOneWidget);

      await _tab(tester, 'Asistente');
      await _tap(tester, 'Compara mis ingresos y gastos');
      await tester.tap(find.byTooltip('Enviar'));
      await _settle(tester);
      await _waitFor(tester, find.text(r'+ $1.164.000'));
      expect(find.text(r'+ $1.164.000'), findsOneWidget);

      await _tab(tester, 'Movimientos');
      await _tap(tester, 'Ingresos');
      await _tap(tester, 'Ingreso QA');
      await _tap(tester, 'Editar');
      await _enter(tester, 'movement-amount', '1.600.000');
      await _tap(tester, 'Guardar cambios');
      await _waitFor(tester, find.text('+ COP 1.600.000,00'));
      expect(find.text('+ COP 1.600.000,00'), findsWidgets);
      await tester.tap(find.byType(BackButton).hitTestable());
      await _settle(tester);
      await _tap(tester, 'Gastos');
      await _tap(tester, 'Gasto QA');
      await _tap(tester, 'Editar');
      await _enter(tester, 'movement-amount', '480.000');
      await _tap(tester, 'Guardar cambios');
      await _waitFor(tester, find.text('− COP 480.000,00'));
      expect(find.text('− COP 480.000,00'), findsWidgets);
      await _tap(tester, 'Eliminar');
      await _tap(tester, 'Eliminar');
      await _waitFor(
        tester,
        find.text('No hay movimientos que coincidan con los filtros.'),
      );
      expect(find.text('Gasto QA'), findsNothing);

      await _tab(tester, 'Perfil');
      await _tap(tester, 'Editar nombre');
      await _enter(tester, 'profile-name', 'Nombre actualizado');
      await _tap(tester, 'Guardar');
      expect(find.text('Nombre actualizado'), findsOneWidget);
      await _tap(tester, 'Seguridad y privacidad');
      await _tap(tester, 'Cambiar contraseña');
      await _enter(tester, 'current-password', _password);
      await _enter(tester, 'new-password', 'synthetic-mobile-changed');
      await _enter(tester, 'confirm-password', 'synthetic-mobile-changed');
      await _tap(tester, 'Guardar cambios');
      expect(find.text('Contraseña actualizada.'), findsOneWidget);
      await _logout(tester);

      await _tap(tester, 'Olvidé mi contraseña');
      await _enter(tester, 'recovery-email', newEmail);
      await _tap(tester, 'Enviar enlace');
      final reset = await _mailToken(newEmail, 'reset');
      final recovery = tester.element(find.text('Solicitud recibida'));
      GoRouter.of(recovery).go('/reset', extra: reset);
      await _settle(tester);
      await _enter(tester, 'new-password', _password);
      await _enter(tester, 'confirm-password', _password);
      await _tap(tester, 'Guardar contraseña');
      await _login(tester, newEmail);
      await _waitFor(tester, find.text('Hola, Nombre'));
      expect(find.text('Hola, Nombre'), findsOneWidget);
      await _tab(tester, 'Perfil');
      await _tap(tester, 'Seguridad y privacidad');
      await _tap(tester, 'Solicitar eliminación');
      await _tap(tester, 'Enviar confirmación');
      final deletion = await _mailToken(newEmail, 'delete');
      final security = tester.element(
        find.text('Seguridad y privacidad').hitTestable(),
      );
      GoRouter.of(security).go('/settings/security/delete', extra: deletion);
      await _settle(tester);
      await _tap(tester, 'Eliminar definitivamente');
      await _waitFor(tester, _loginButton);

      await _login(tester, _email);
      await _waitFor(tester, find.text(r'$25.000'));
      expect(find.text(r'$25.000'), findsWidgets);
      await tester.pumpWidget(const SizedBox.shrink());
      await _settle(tester);
      app.main();
      await _settle(tester);
      expect(find.text(r'$25.000'), findsWidgets);

      await tester.tap(find.byKey(const ValueKey('home-period')));
      await _settle(tester);
      await _tap(tester, 'Mes anterior');
      expect(find.text(r'$5.000'), findsWidgets);
      await tester.tap(find.byKey(const ValueKey('home-period')));
      await _settle(tester);
      await _tap(tester, 'Este mes');
      await _tap(tester, '2 avisos pendientes');
      expect(find.text(r'$25.000'), findsNothing);
      await _tap(tester, 'Aviso de Nequi');
      expect(find.text('Datos por confirmar: monto.'), findsOneWidget);
      await tester.tap(find.byType(BackButton).hitTestable());
      await _settle(tester);
      await _tap(tester, 'Todos');
      await tester.tap(find.byTooltip('Moneda').hitTestable());
      await _settle(tester);
      await _tap(tester, 'USD');
      expect(find.text(r'− $12,50'), findsOneWidget);

      await _tab(tester, 'Asistente');
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

      await _tab(tester, 'Perfil');
      await _tap(tester, 'Buzones');
      expect(find.text('Última sincronización'), findsOneWidget);
      await _tap(tester, 'Vincular Gmail');
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.textContaining('solo lectura'),
        ),
        findsOneWidget,
      );
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
      expect(_loginButton, findsOneWidget);
    },
    skip:
        _origin != 'http://localhost:3105' ||
        _mailpit != 'http://localhost:8026',
  );

  testWidgets(
    'Resuelve avisos pendientes en Android',
    (tester) async {
      const storage = FlutterSecureStorage();
      await storage.delete(key: 'mailgasto_session@$_origin');
      addTearDown(() => storage.delete(key: 'mailgasto_session@$_origin'));
      app.main();
      await _settle(tester);
      await _login(tester, _email);
      await _waitFor(tester, find.text(r'$25.000'));
      expect(find.text(r'$25.000'), findsWidgets);
      await _waitFor(tester, find.text('2 avisos pendientes'));
      await _tap(tester, '2 avisos pendientes');

      await _waitFor(tester, find.text('Aviso de Nequi'));
      await _tap(tester, 'Aviso de Nequi');
      await _tap(tester, 'Descartar aviso');
      await _tap(tester, 'Cancelar');
      expect(find.text('Detalle del aviso'), findsOneWidget);
      expect(find.text('Descartar aviso').hitTestable(), findsOneWidget);
      await _tap(tester, 'Descartar aviso');
      await _tap(tester, 'Descartar');
      await _waitFor(tester, find.text('Otro remitente'));
      await tester.drag(
        find.byType(CustomScrollView).hitTestable(),
        const Offset(0, 350),
      );
      await _settle(tester);
      expect(find.text('Aviso de Nequi'), findsNothing);

      await _tap(tester, 'Otro remitente');
      expect(find.text('Monto por confirmar'), findsOneWidget);
      expect(find.text('Confirmar movimiento').hitTestable(), findsOneWidget);
      await _tap(tester, 'Confirmar movimiento');
      final amount = tester.widget<TextFormField>(
        find.byKey(const ValueKey('movement-amount')),
      );
      expect(amount.controller!.text, isEmpty);
      await _tap(tester, 'Gasto');
      await _enter(tester, 'movement-amount', '3.500');
      await _tapFinder(tester, find.byKey(const ValueKey('movement-currency')));
      await _tap(tester, 'COP');
      await _tap(tester, 'Seleccionar fecha');
      final picker = tester.element(find.byType(DatePickerDialog));
      await _tap(tester, MaterialLocalizations.of(picker).okButtonLabel);
      await _tapFinder(tester, find.byKey(const ValueKey('movement-category')));
      await _tap(tester, 'Compras');
      await _enter(tester, 'movement-description', 'Compra confirmada QA');
      await _tap(tester, 'Confirmar y registrar');
      await _waitFor(tester, find.text('Detalle del movimiento'));
      expect(find.text('− COP 3.500,00'), findsOneWidget);
      expect(find.text('Correo').hitTestable(), findsOneWidget);
      await tester.tap(find.byType(BackButton).hitTestable());
      await _settle(tester);
      final empty = find.text('No hay avisos que coincidan con los filtros.');
      await _waitFor(tester, empty);
      expect(empty, findsOneWidget);
      await _tab(tester, 'Inicio');
      await _waitFor(tester, find.text(r'$28.500'));
      expect(find.text(r'$28.500'), findsWidgets);
    },
    skip: _origin != 'http://localhost:3105',
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

final _loginButton = find.widgetWithText(FilledButton, 'Iniciar sesión');

Future<void> _tab(WidgetTester tester, String label) => _tapFinder(
  tester,
  find.descendant(of: find.byType(NavigationBar), matching: find.text(label)),
);

Future<void> _tap(WidgetTester tester, String text) =>
    _tapFinder(tester, find.text(text));

Future<void> _tapFinder(WidgetTester tester, Finder matches) async {
  await _show(tester, matches, last: true);
  await tester.tap(matches.last);
  await _settle(tester);
}

Future<void> _show(
  WidgetTester tester,
  Finder target, {
  bool last = false,
}) async {
  if (target.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target,
      160,
      scrollable: find
          .byWidgetPredicate(
            (widget) =>
                widget is Scrollable &&
                widget.axisDirection == AxisDirection.down,
          )
          .hitTestable()
          .first,
    );
  }
  await tester.ensureVisible(last ? target.last : target);
}

Future<void> _enter(WidgetTester tester, String key, String text) async {
  final target = find.byKey(ValueKey(key));
  await _show(tester, target);
  await tester.enterText(target, text);
  await tester.pump();
}

Future<void> _login(WidgetTester tester, String email) async {
  await _enter(tester, 'email', email);
  await _enter(tester, 'password', _password);
  await _tapFinder(tester, _loginButton);
}

Future<void> _logout(WidgetTester tester) async {
  await _tab(tester, 'Perfil');
  await _tap(tester, 'Cerrar sesión');
}

Future<void> _verifyEmail(String email) async {
  final client = Dio(BaseOptions(connectTimeout: const Duration(seconds: 5)));
  try {
    final verified = await client.post<void>(
      '$_origin/v1/auth/verify',
      data: {'token': await _mailToken(email, 'verify'), 'password': _password},
      options: Options(headers: {'Origin': _origin}),
    );
    expect(verified.statusCode, 204);
  } finally {
    client.close();
  }
}

Future<String> _mailToken(String email, String purpose) async {
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
          '#$purpose=([A-Za-z0-9_-]{43})',
        ).firstMatch(mail.data?['Text'] as String? ?? '')?.group(1);
      }
      if (code == null) {
        await Future<void>.delayed(const Duration(milliseconds: 300));
      }
    }
    expect(code, isNotNull);
    return code!;
  } finally {
    client.close();
  }
}
