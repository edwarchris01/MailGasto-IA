import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/google_browser.dart';

typedef Account = ({String id, String name, String email});

final authProvider = AsyncNotifierProvider<AuthViewModel, Account?>(
  AuthViewModel.new,
);

class AuthRepository {
  AuthRepository(this.api);
  final ApiClient api;

  Account _account(Json json) => (
    id: json['id'] as String,
    name: json['name'] as String,
    email: json['email'] as String,
  );

  Future<Account> restore() async => _account(
    (await api.request('auth/me', expireOnUnauthorized: false)).data as Json,
  );

  Future<({Account account, String token})> login(
    String email,
    String password,
  ) async {
    final result = await api.request(
      'auth/login',
      method: 'POST',
      body: {'email': email, 'password': password},
      authenticated: false,
    );
    return _session(result);
  }

  ({Account account, String token}) _session(Response<dynamic> result) {
    final cookie = result.headers['set-cookie']?.join('\n') ?? '';
    final token = RegExp(
      r'(?:^|\n)mailgasto_session=([A-Za-z0-9_-]{43})(?:;|$)',
    ).firstMatch(cookie)?.group(1);
    if (token == null) {
      throw const ApiFailure('MailGasto no entregó una sesión válida.');
    }
    return (account: _account(result.data as Json), token: token);
  }

  Future<Uri> google(String challenge) async => googleAuthorizationUrl(
    (await api.request(
          'mobile/auth/google/authorize',
          method: 'POST',
          body: {'challenge': challenge},
          authenticated: false,
        )).data
        as Json,
  );

  Future<({Account account, String token})> finishGoogle(
    String receipt,
    String verifier,
  ) async => _session(
    await api.request(
      'mobile/auth/google/complete',
      method: 'POST',
      body: {'receipt': receipt, 'verifier': verifier},
      authenticated: false,
    ),
  );

  Future<Account> rename(String name) async => _account(
    await api.object('account/profile', method: 'PATCH', body: {'name': name}),
  );

  Future<void> changePassword(String current, String password) => api.request(
    'account/password',
    method: 'POST',
    body: {'current': current, 'password': password},
  );

  Future<void> requestReset(String email) => api.request(
    'auth/password/reset',
    method: 'POST',
    body: {'email': email},
    authenticated: false,
  );

  Future<void> resetPassword(String token, String password) => api.request(
    'auth/password/reset/confirm',
    method: 'POST',
    body: {'token': token, 'password': password},
    authenticated: false,
  );

  Future<void> register(String name, String email, String password) =>
      api.request(
        'auth/register',
        method: 'POST',
        body: {'name': name, 'email': email, 'password': password},
        authenticated: false,
      );

  Future<void> revoke(String token) => api.request(
    'auth/logout',
    method: 'POST',
    revokeSession: token,
    expireOnUnauthorized: false,
  );
}

class AuthViewModel extends AsyncNotifier<Account?> {
  static const _storageKey = 'mailgasto_session';
  ApiClient get _api => ref.read(apiProvider);
  AuthRepository get _repository => AuthRepository(_api);
  String get _key => '$_storageKey@${_api.origin.origin}';
  String get _googleKey => 'google_signin@${_api.origin.origin}';

  @override
  Future<Account?> build() async {
    final api = _api;
    api.onUnauthorized = (token) => unawaited(_expire(token));
    final storage = ref.read(secureStorageProvider);
    api.session = await storage.read(key: _key);
    if (api.session == null) return null;
    try {
      return await _repository.restore();
    } on ApiFailure catch (error) {
      if (error.status != 401) rethrow;
      api.session = null;
      await storage.delete(key: _key);
      return null;
    }
  }

  Future<void> login(String email, String password) async {
    final result = await _repository.login(email, password);
    await _save(result);
  }

  Future<void> _save(({Account account, String token}) result) async {
    await ref.read(secureStorageProvider).write(key: _key, value: result.token);
    _api.session = result.token;
    state = AsyncData(result.account);
  }

  Future<void> openGoogle() async {
    final random = Random.secure();
    final verifier = base64Url
        .encode(List.generate(32, (_) => random.nextInt(256)))
        .replaceAll('=', '');
    final challenge = base64Url
        .encode(sha256.convert(utf8.encode(verifier)).bytes)
        .replaceAll('=', '');
    final uri = await _repository.google(challenge);
    final storage = ref.read(secureStorageProvider);
    await storage.write(key: _googleKey, value: verifier);
    try {
      await openGoogleAuthorization(uri, _api.origin, GoogleFlow.signIn);
    } catch (_) {
      await storage.delete(key: _googleKey);
      rethrow;
    }
  }

  Future<void> finishGoogle(String receipt) async {
    final storage = ref.read(secureStorageProvider);
    final verifier = await storage.read(key: _googleKey);
    if (verifier == null) {
      throw const ApiFailure(
        'Vuelve a iniciar sesión con Google desde la app.',
      );
    }
    final result = await _repository.finishGoogle(receipt, verifier);
    await storage.delete(key: _googleKey);
    if (_api.session == null) {
      await _save(result);
    } else {
      unawaited(_repository.revoke(result.token).catchError((Object _) {}));
    }
  }

  Future<void> cancelGoogle() =>
      ref.read(secureStorageProvider).delete(key: _googleKey);

  Future<void> rename(String name) async {
    final account = await _repository.rename(name);
    state = AsyncData(account);
  }

  Future<void> changePassword(String current, String password) =>
      _repository.changePassword(current, password);

  Future<void> requestReset(String email) => _repository.requestReset(email);

  Future<void> resetPassword(String token, String password) async {
    final session = _api.session;
    await _repository.resetPassword(token, password);
    if (session != null && _api.session == session) {
      try {
        await _repository.restore();
      } on ApiFailure catch (error) {
        if (error.status == 401) await _expire(session);
      }
    }
  }

  Future<void> register(String name, String email, String password) =>
      _repository.register(name, email, password);

  Future<void> logout() async {
    final token = _api.session;
    if (token == null) return;
    unawaited(_repository.revoke(token).catchError((Object _) {}));
    await _expire(token);
  }

  Future<void> _expire(String token) async {
    if (_api.session != token) return;
    _api.session = null;
    state = const AsyncLoading();
    try {
      await ref.read(secureStorageProvider).delete(key: _key);
      state = const AsyncData(null);
    } catch (error, stack) {
      state = AsyncError(error, stack);
    }
  }
}

class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({super.key, this.register = false});
  final bool register;

  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends ConsumerState<AuthScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _message;
  bool _registered = false;
  bool _showPassword = false;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy || !_form.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final auth = ref.read(authProvider.notifier);
      if (widget.register) {
        await auth.register(
          _name.text.trim(),
          _email.text.trim(),
          _password.text,
        );
        _password.clear();
        if (mounted) setState(() => _registered = true);
      } else {
        await auth.login(_email.text.trim(), _password.text);
      }
    } catch (error) {
      if (mounted) setState(() => _message = failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _google() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await ref.read(authProvider.notifier).openGoogle();
    } catch (error) {
      if (mounted) setState(() => _message = failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: widget.register
          ? AppBar(title: const Text('Crear cuenta'))
          : null,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: AutofillGroup(
                child: Form(
                  key: _form,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Image(
                        image: AssetImage('assets/brand.png'),
                        height: 112,
                        excludeFromSemantics: true,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'MailGasto IA',
                        style: theme.textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 8),
                      if (_registered) ...[
                        Text(
                          'Verifica tu correo',
                          style: theme.textTheme.titleLarge,
                        ),
                        const Text(
                          'Revisa tu correo y abre el enlace para verificar tu cuenta.',
                        ),
                        Text(_email.text.trim()),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: () => context.go('/login'),
                          child: const Text('Volver a iniciar sesión'),
                        ),
                      ] else ...[
                        Text(
                          widget.register
                              ? 'Crea tu cuenta para organizar tus movimientos.'
                              : 'Consulta tus ingresos, gastos y avisos bancarios.',
                        ),
                        const SizedBox(height: 24),
                        if (widget.register) ...[
                          TextFormField(
                            key: const ValueKey('name'),
                            controller: _name,
                            autofillHints: const [AutofillHints.name],
                            textInputAction: TextInputAction.next,
                            decoration: const InputDecoration(
                              labelText: 'Nombre',
                            ),
                            validator: (value) => value!.trim().isEmpty
                                ? 'Escribe tu nombre.'
                                : null,
                            maxLength: 80,
                          ),
                          const SizedBox(height: 12),
                        ],
                        TextFormField(
                          key: const ValueKey('email'),
                          controller: _email,
                          keyboardType: TextInputType.emailAddress,
                          textInputAction: TextInputAction.next,
                          autofillHints: const [AutofillHints.email],
                          decoration: const InputDecoration(
                            labelText: 'Correo',
                          ),
                          validator: (value) => !value!.contains('@')
                              ? 'Escribe un correo válido.'
                              : null,
                        ),
                        const SizedBox(height: 12),
                        TextFormField(
                          key: const ValueKey('password'),
                          controller: _password,
                          obscureText: !_showPassword,
                          onFieldSubmitted: (_) => _submit(),
                          autofillHints: [
                            widget.register
                                ? AutofillHints.newPassword
                                : AutofillHints.password,
                          ],
                          decoration: InputDecoration(
                            labelText: 'Contraseña',
                            suffixIcon: IconButton(
                              tooltip: _showPassword
                                  ? 'Ocultar contraseña'
                                  : 'Mostrar contraseña',
                              onPressed: () => setState(
                                () => _showPassword = !_showPassword,
                              ),
                              icon: Icon(
                                _showPassword
                                    ? Icons.visibility_off_outlined
                                    : Icons.visibility_outlined,
                              ),
                            ),
                          ),
                          validator: (value) =>
                              value!.length < 12 || value.length > 128
                              ? 'Usa entre 12 y 128 caracteres.'
                              : null,
                        ),
                        if (_message case final message?) ...[
                          const SizedBox(height: 12),
                          Text(
                            message,
                            style: TextStyle(color: theme.colorScheme.error),
                          ),
                        ],
                        const SizedBox(height: 20),
                        FilledButton(
                          onPressed: _busy ? null : _submit,
                          child: Text(
                            _busy
                                ? 'Un momento…'
                                : widget.register
                                ? 'Registrarme'
                                : 'Iniciar sesión',
                          ),
                        ),
                        if (!widget.register) ...[
                          TextButton(
                            onPressed: _busy
                                ? null
                                : () => context.push('/recover'),
                            child: const Text('Olvidé mi contraseña'),
                          ),
                          OutlinedButton.icon(
                            icon: const Icon(Icons.account_circle_outlined),
                            onPressed: _busy ? null : _google,
                            label: const Text('Continuar con Google'),
                          ),
                          TextButton(
                            onPressed: _busy
                                ? null
                                : () => context.push('/register'),
                            child: const Text('Crear cuenta'),
                          ),
                        ],
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
