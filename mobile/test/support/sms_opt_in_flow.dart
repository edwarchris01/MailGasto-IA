import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:mailgasto/core/api.dart';
import 'package:mailgasto/core/design.dart';
import 'package:mailgasto/core/sms_bridge.dart';
import 'package:mailgasto/features/auth/auth.dart';
import 'package:mailgasto/features/sms/sms.dart';

// Permission and platform calls are simulated. No real SMS permission, provider,
// credentials, background worker or financial API is accessed by this test.
Future<void> verifySmsOptIn(WidgetTester tester) async {
  await initializeDateFormatting('es_CO');
  final bridge = _Bridge();
  final api = _Api(bridge);
  final container = ProviderContainer(
    overrides: [
      smsBridgeProvider.overrideWithValue(bridge),
      apiProvider.overrideWithValue(api),
      authProvider.overrideWith(_Account.new),
    ],
  );
  await container.read(authProvider.future);
  final router = GoRouter(
    routes: [GoRoute(path: '/', builder: (_, _) => const SmsScreen())],
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
      child: MaterialApp.router(theme: mailGastoTheme(), routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
  expect(find.text('Identificación automática en el teléfono'), findsOneWidget);
  expect(find.byType(TextField), findsNothing);
  expect(bridge.permissionRequests, 0);
  expect(api.setupCalls, 0);

  Future<void> tap(String text) async {
    final button = find.widgetWithText(FilledButton, text);
    await tester.ensureVisible(button);
    await tester.pumpAndSettle();
    await tester.tap(button);
    await tester.pumpAndSettle();
  }

  await tap('Activar SMS de Nequi');
  expect(bridge.permissionRequests, 1);
  expect(
    api.setupCalls,
    0,
    reason: 'Denied permission cannot create an import credential',
  );
  expect(bridge.config, isNull);

  bridge.granted = true;
  await tap('Activar SMS de Nequi');
  expect(api.setupCalls, 1);
  expect(bridge.config?['accountId'], 'synthetic-sms');
  expect(find.text('Activo'), findsOneWidget);
  final disable = find.widgetWithText(OutlinedButton, 'Desactivar SMS');
  await tester.ensureVisible(disable);
  await tester.pumpAndSettle();
  await tester.tap(disable);
  await tester.pumpAndSettle();
  expect(bridge.config, isNull);
  expect(api.revoked, true);
  expect(find.text('Desactivado'), findsOneWidget);
}

class _Account extends AuthViewModel {
  @override
  Future<Account?> build() async =>
      (id: 'synthetic-sms', name: 'Prueba SMS', email: 'sms@example.test');
}

class _Bridge extends SmsBridge {
  bool granted = false;
  int permissionRequests = 0;
  Json? config;
  @override
  bool get supported => true;
  @override
  Future<SmsStatus> status() async => SmsStatus.fromJson({
    'deviceId': '11111111-1111-4111-8111-111111111111',
    'enabled': config != null,
    'permission': granted,
    'serverId': config == null ? null : 'synthetic-device',
  });
  @override
  Future<bool> requestPermissions() async {
    permissionRequests++;
    return granted;
  }

  @override
  Future<SmsStatus> configure(Json value) async {
    config = value;
    return status();
  }

  @override
  Future<void> clear() async {
    config = null;
  }
}

class _Api extends ApiClient {
  _Api(this.bridge) : super(Uri.parse('https://sms.example.test'));
  final _Bridge bridge;
  int setupCalls = 0;
  bool revoked = false;
  @override
  Future<Json> object(
    String path, {
    String method = 'GET',
    Json? body,
    Map<String, Object>? query,
  }) async {
    expect(bridge.granted, true);
    expect(path, 'sms/devices');
    expect(method, 'POST');
    expect(body?['autoDetect'], true);
    expect(body?.containsKey('senders'), false);
    setupCalls++;
    return {
      'id': 'synthetic-device',
      'ingestToken': 'synthetic-ingest-only',
      'senders': [],
      'autoDetect': true,
      'since': '2026-11-01',
    };
  }

  @override
  Future<Response<dynamic>> request(
    String path, {
    String method = 'GET',
    Json? body,
    Map<String, Object>? query,
    bool authenticated = true,
    bool expireOnUnauthorized = true,
    String? revokeSession,
  }) async {
    expect(
      bridge.config,
      isNull,
      reason:
          'Local credentials and queue are cleared before network revocation',
    );
    expect(method, 'DELETE');
    expect(path, 'sms/devices/synthetic-device');
    revoked = true;
    return Response<dynamic>(requestOptions: RequestOptions(), statusCode: 204);
  }
}
