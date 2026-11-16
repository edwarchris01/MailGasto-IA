import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mailgasto/core/api.dart';
import 'package:mailgasto/core/sms_bridge.dart';
import 'package:mailgasto/features/auth/auth.dart';

// Real AuthViewModel; UI sessions, device credentials, permissions and storage
// are synthetic. This never accesses Android's SMS provider or a live account.
Future<void> verifySmsSessionIndependence(WidgetTester tester) async {
  const key = 'mailgasto_session@https://session.example.test';
  final expired = List.filled(43, 'e').join();
  FlutterSecureStorage.setMockInitialValues({key: expired});
  final bridge = _Consent();
  final api = _SessionApi();
  final container = ProviderContainer(
    overrides: [
      apiProvider.overrideWithValue(api),
      smsBridgeProvider.overrideWithValue(bridge),
    ],
  );
  var disposed = false;
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    if (!disposed) container.dispose();
    api.close();
    FlutterSecureStorage.setMockInitialValues({});
  });
  await tester.pumpWidget(
    const MaterialApp(
      home: Scaffold(
        body: Center(child: Text('Prueba de sesión SMS con datos sintéticos')),
      ),
    ),
  );

  expect(await container.read(authProvider.future), isNull);
  expect(api.session, isNull);
  expect(
    bridge.bound,
    true,
    reason: 'Expired UI session must not revoke independent SMS consent',
  );
  expect(bridge.clearCalls, 0);
  expect(bridge.queued, 2);
  final auth = container.read(authProvider.notifier);
  await auth.login('alpha@example.test', 'synthetic-password');
  expect(container.read(authProvider).requireValue?.id, 'alpha');
  expect(bridge.bound, true);
  expect(bridge.clearCalls, 0);

  api.onUnauthorized?.call(api.session!);
  await tester.pump();
  expect(container.read(authProvider).requireValue, isNull);
  expect(
    bridge.bound,
    true,
    reason: 'A foreground API 401 only expires the UI session',
  );
  expect(bridge.queued, 2);
  // A worker stopped by a revoked permission/token cannot be revived by login.
  bridge.enabled = false;
  await auth.login('alpha@example.test', 'synthetic-password');
  expect(bridge.enabled, false);
  expect(bridge.clearCalls, 0);

  bridge.enabled = true;
  bridge.failClear = true;
  await expectLater(auth.logout(), throwsStateError);
  expect(container.read(authProvider).requireValue?.id, 'alpha');
  expect(bridge.bound, true);
  expect(
    api.logouts,
    0,
    reason: 'Do not claim logout while local background access remains active',
  );
  bridge.failClear = false;
  await auth.logout();
  await tester.pump();
  expect(bridge.bound, false);
  expect(bridge.queued, 0);
  expect(bridge.clearCalls, 1);
  expect(api.deviceRevocations, 1);
  expect(api.logouts, 1);

  bridge.reset();
  api.nextAccount = 'beta';
  await auth.login('beta@example.test', 'synthetic-password');
  expect(container.read(authProvider).requireValue?.id, 'beta');
  expect(
    bridge.bound,
    false,
    reason: 'Another account cannot inherit the SMS token or queue',
  );
  expect(bridge.queued, 0);
  expect(bridge.clearCalls, 2);

  bridge.reset(missingServer: true);
  api.nextAccount = 'gamma';
  await auth.login('gamma@example.test', 'synthetic-password');
  expect(
    bridge.bound,
    false,
    reason: 'A partial binding without serverId cannot cross accounts',
  );
  expect(bridge.clearCalls, 3);

  // Missing UI storage on a later launch is also independent of consent.
  container.dispose();
  disposed = true;
  FlutterSecureStorage.setMockInitialValues({});
  bridge.reset();
  final fresh = ProviderContainer(
    overrides: [
      apiProvider.overrideWithValue(api),
      smsBridgeProvider.overrideWithValue(bridge),
    ],
  );
  addTearDown(fresh.dispose);
  expect(await fresh.read(authProvider.future), isNull);
  expect(bridge.bound, true);
  expect(bridge.clearCalls, 3);
}

class _Consent extends SmsBridge {
  bool bound = true, enabled = true;
  bool failClear = false, missingServer = false;
  int clearCalls = 0, queued = 2;
  @override
  bool get supported => true;
  void reset({bool missingServer = false}) {
    bound = true;
    enabled = true;
    queued = 2;
    this.missingServer = missingServer;
  }

  @override
  Future<SmsStatus> status() async => SmsStatus.fromJson({
    'serverId': bound && !missingServer ? 'synthetic-device' : null,
    'accountId': bound ? 'alpha' : null,
    'enabled': enabled,
    'queued': queued,
  });
  @override
  Future<void> clear() async {
    if (failClear) throw StateError('Synthetic local clear failure');
    clearCalls++;
    bound = false;
    enabled = false;
    queued = 0;
  }
}

class _SessionApi extends ApiClient {
  _SessionApi() : super(Uri.parse('https://session.example.test'));
  String nextAccount = 'alpha';
  int deviceRevocations = 0, logouts = 0;
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
    if (path == 'auth/me') {
      throw const ApiFailure('Sesión expirada de prueba.', status: 401);
    }
    if (path == 'sms/devices/synthetic-device') {
      deviceRevocations++;
    }
    if (path == 'auth/logout') {
      logouts++;
    }
    final token = List.filled(43, nextAccount == 'alpha' ? 'a' : 'b').join();
    return Response<dynamic>(
      requestOptions: RequestOptions(),
      statusCode: 200,
      data: {
        'id': nextAccount,
        'name': 'Cuenta sintética',
        'email': '$nextAccount@example.test',
      },
      headers: Headers.fromMap({
        'set-cookie': ['mailgasto_session=$token; Path=/; Secure; HttpOnly'],
      }),
    );
  }
}
