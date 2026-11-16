import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api.dart';

final smsBridgeProvider = Provider((_) => SmsBridge());

class SmsStatus {
  SmsStatus.fromJson(Json value)
    : deviceId = value['deviceId'] as String? ?? '',
      serverId = value['serverId'] as String?,
      accountId = value['accountId'] as String?,
      enabled = value['enabled'] == true,
      permission = value['permission'] == true,
      senders = (value['senders'] as List?)?.cast<String>() ?? const [],
      since = value['since'] as String? ?? '2026-11-01',
      queued = value['queued'] as int? ?? 0,
      imported = value['imported'] as int? ?? 0,
      duplicates = value['duplicates'] as int? ?? 0,
      ignored = value['ignored'] as int? ?? 0,
      pending = value['pending'] as int? ?? 0,
      lastSync = value['lastSync'] as String?,
      error = value['error'] as String?;

  final String deviceId, since;
  final String? serverId, accountId, lastSync, error;
  final bool enabled, permission;
  final List<String> senders;
  final int queued, imported, duplicates, ignored, pending;

  String? get explanation => switch (error) {
    'permission_required' => 'El permiso de SMS está desactivado en Android.',
    'auth_required' =>
      'Vuelve a activar SMS para renovar el acceso de este teléfono.',
    'import_rejected' =>
      'No se pudo importar el lote. Los SMS siguen guardados en el teléfono.',
    'retrying' =>
      'El envío se reintentará automáticamente cuando el servicio esté disponible.',
    'scan_failed' =>
      'No pudimos revisar los SMS. La revisión se reintentará automáticamente.',
    _ => null,
  };
}

class SmsBridge {
  static const _channel = MethodChannel('co.com.styleplus.mailgasto/sms');
  bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  Future<SmsStatus> status() async {
    if (!supported) return SmsStatus.fromJson({});
    final value = await _channel.invokeMapMethod<String, dynamic>('status');
    return SmsStatus.fromJson(value ?? {});
  }

  Future<bool> requestPermissions() async =>
      supported &&
      await _channel.invokeMethod<bool>('requestPermissions') == true;

  Future<SmsStatus> configure(Json config) async => SmsStatus.fromJson(
    await _channel.invokeMapMethod<String, dynamic>('configure', config) ?? {},
  );

  Future<void> clear() async {
    if (supported) await _channel.invokeMethod<void>('clear');
  }

  Future<void> settings() => _channel.invokeMethod<void>('settings');
}
