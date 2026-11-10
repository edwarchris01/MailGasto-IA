import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';

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
    final cookie = result.headers['set-cookie']?.join('\n') ?? '';
    final token = RegExp(
      r'(?:^|\n)mailgasto_session=([A-Za-z0-9_-]{43})(?:;|$)',
    ).firstMatch(cookie)?.group(1);
    if (token == null) {
      throw const ApiFailure('MailGasto no entregó una sesión válida.');
    }
    return (account: _account(result.data as Json), token: token);
  }

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
    await ref.read(secureStorageProvider).write(key: _key, value: result.token);
    _api.session = result.token;
    state = AsyncData(result.account);
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
                      Icon(
                        Icons.account_balance_wallet_outlined,
                        color: theme.colorScheme.primary,
                        size: 42,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'MailGasto IA',
                        style: theme.textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 8),
                      if (_registered) ...[
                        const Text(
                          'Revisa tu correo y abre el enlace para verificar tu cuenta.',
                        ),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: () => context.go('/login'),
                          child: const Text('Volver a iniciar sesión'),
                        ),
                      ] else ...[
                        Text(
                          widget.register
                              ? 'Crea tu cuenta para consultar tus gastos.'
                              : 'Consulta tus gastos y avisos bancarios.',
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
                          obscureText: true,
                          onFieldSubmitted: (_) => _submit(),
                          autofillHints: [
                            widget.register
                                ? AutofillHints.newPassword
                                : AutofillHints.password,
                          ],
                          decoration: const InputDecoration(
                            labelText: 'Contraseña',
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
                        if (!widget.register)
                          TextButton(
                            onPressed: _busy
                                ? null
                                : () => context.push('/register'),
                            child: const Text('Crear cuenta'),
                          ),
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
