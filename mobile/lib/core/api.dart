import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

typedef Json = Map<String, dynamic>;

final apiProvider = Provider((ref) {
  final api = ApiClient(
    Uri.parse(
      const String.fromEnvironment(
        'API_BASE_URL',
        defaultValue: 'https://mailgasto.styleplus.com.co',
      ),
    ),
  );
  ref.onDispose(api.close);
  return api;
});

final secureStorageProvider = Provider((ref) => const FlutterSecureStorage());

class ApiFailure implements Exception {
  const ApiFailure(this.message, {this.status});
  final String message;
  final int? status;
}

class ApiClient {
  ApiClient(this.origin) {
    final local =
        origin.scheme == 'http' &&
        (origin.host == 'localhost' || origin.host == '127.0.0.1');
    if ((!kDebugMode || !local) && origin.scheme != 'https' ||
        origin.host.isEmpty ||
        origin.userInfo.isNotEmpty ||
        origin.hasQuery ||
        origin.hasFragment ||
        (origin.path.isNotEmpty && origin.path != '/')) {
      throw ArgumentError('API_BASE_URL debe ser un origen HTTPS.');
    }
    _dio = Dio(
      BaseOptions(
        baseUrl: '${origin.origin}/v1/',
        connectTimeout: const Duration(seconds: 8),
        receiveTimeout: const Duration(seconds: 40),
        followRedirects: false,
        headers: {'Accept': 'application/json'},
      ),
    );
  }

  final Uri origin;
  late final Dio _dio;
  String? session;
  void Function(String)? onUnauthorized;

  Future<Response<dynamic>> request(
    String path, {
    String method = 'GET',
    Json? body,
    Map<String, Object>? query,
    bool authenticated = true,
    bool expireOnUnauthorized = true,
    String? revokeSession,
  }) async {
    if (path.startsWith('/') || Uri.parse(path).hasScheme) {
      throw ArgumentError('La ruta debe ser relativa a la API.');
    }
    final credential = revokeSession ?? (authenticated ? session : null);
    if (authenticated && credential == null) {
      throw const ApiFailure('Inicia sesión para continuar.', status: 401);
    }
    try {
      final response = await _dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query,
        options: Options(
          method: method,
          headers: {
            if (method != 'GET') 'Origin': origin.origin,
            if (credential != null) 'Cookie': 'mailgasto_session=$credential',
          },
        ),
      );
      if (authenticated && revokeSession == null && session != credential) {
        throw const ApiFailure('La sesión cambió.', status: 401);
      }
      return response;
    } on DioException catch (error) {
      final status = error.response?.statusCode;
      if (status == 401 &&
          expireOnUnauthorized &&
          credential != null &&
          session == credential) {
        onUnauthorized?.call(credential);
      }
      final response = error.response?.data;
      final message = response is Json ? response['message'] : null;
      throw ApiFailure(
        status == null
            ? 'No pudimos conectar con MailGasto. Intenta de nuevo.'
            : status == 429
            ? 'Hay demasiadas solicitudes. Intenta más tarde.'
            : message is String
            ? message
            : 'No pudimos completar la solicitud.',
        status: status,
      );
    }
  }

  Future<Json> object(
    String path, {
    String method = 'GET',
    Json? body,
    Map<String, Object>? query,
  }) async =>
      (await request(path, method: method, body: body, query: query)).data
          as Json;

  Future<List<Json>> list(String path) async =>
      ((await request(path)).data as List<dynamic>).cast<Json>();

  void close() => _dio.close(force: true);
}

String failureMessage(Object error) => error is ApiFailure
    ? error.message
    : 'No pudimos cargar la información. Intenta de nuevo.';

Uri googleAuthorizationUrl(Json result) {
  final uri = Uri.parse(result['url'] as String);
  if (uri.scheme != 'https' ||
      uri.host != 'accounts.google.com' ||
      uri.hasPort ||
      uri.userInfo.isNotEmpty ||
      uri.path != '/o/oauth2/v2/auth') {
    throw const ApiFailure('No pudimos abrir la autorización de Google.');
  }
  return uri;
}
