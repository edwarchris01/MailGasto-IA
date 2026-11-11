import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/design.dart';
import '../../core/google_browser.dart';
import '../../core/widgets.dart';

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
  Widget build(BuildContext context) => Scaffold(
    appBar: widget.register
        ? appBackBar(
            _registered ? 'Crear cuenta' : 'Volver a iniciar sesión',
            () {
              if (_registered) {
                setState(() => _registered = false);
              } else if (context.canPop()) {
                context.pop();
              } else {
                context.go('/login');
              }
            },
          )
        : brandBar(),
    body: FormLayout(
      child: _registered
          ? _verification()
          : AutofillGroup(
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (widget.register) ...[
                      const Align(
                        alignment: Alignment.centerLeft,
                        child: IconTile(
                          Icons.person_add_alt_1_outlined,
                          size: 50,
                        ),
                      ),
                      const SizedBox(height: 16),
                      const PageHeading(
                        'Crear cuenta',
                        eyebrow: 'NUEVA CUENTA',
                        description:
                            'Tu cuenta reúne los movimientos y las consultas.',
                      ),
                    ] else ...[
                      const _AccessHero(),
                      const SizedBox(height: 24),
                      const PageHeading(
                        'Iniciar sesión',
                        description:
                            'Consulta tus ingresos y gastos en un solo lugar.',
                      ),
                    ],
                    const SizedBox(height: 20),
                    if (widget.register) ...[
                      LabeledField(
                        'Nombre',
                        child: TextFormField(
                          key: const ValueKey('name'),
                          controller: _name,
                          autofillHints: const [AutofillHints.name],
                          textInputAction: TextInputAction.next,
                          decoration: const InputDecoration(
                            hintText: 'Tu nombre',
                            counterText: '',
                          ),
                          validator: (value) => value!.trim().isEmpty
                              ? 'Escribe tu nombre.'
                              : null,
                          maxLength: 80,
                        ),
                      ),
                      const SizedBox(height: 10),
                    ],
                    LabeledField(
                      'Correo',
                      child: TextFormField(
                        key: const ValueKey('email'),
                        controller: _email,
                        keyboardType: TextInputType.emailAddress,
                        textInputAction: TextInputAction.next,
                        autofillHints: const [AutofillHints.email],
                        decoration: const InputDecoration(
                          hintText: 'nombre@ejemplo.com',
                        ),
                        validator: (value) => !value!.contains('@')
                            ? 'Escribe un correo válido.'
                            : null,
                      ),
                    ),
                    const SizedBox(height: 10),
                    PasswordField(
                      fieldKey: const ValueKey('password'),
                      label: 'Contraseña',
                      controller: _password,
                      onSubmitted: (_) => _submit(),
                      autofillHints: [
                        widget.register
                            ? AutofillHints.newPassword
                            : AutofillHints.password,
                      ],
                      validator: (value) =>
                          value!.length < 12 || value.length > 128
                          ? 'Usa entre 12 y 128 caracteres.'
                          : null,
                    ),
                    if (widget.register) ...[
                      const SizedBox(height: 8),
                      Text(
                        'Usa al menos 12 caracteres.',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(height: 16),
                    ] else
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(
                          style: TextButton.styleFrom(
                            padding: const EdgeInsets.only(left: 12),
                          ),
                          onPressed: _busy
                              ? null
                              : () => context.push('/recover'),
                          child: const Text('Olvidé mi contraseña'),
                        ),
                      ),
                    if (_message case final message?) ...[
                      AppNotice(
                        icon: Icons.error_outline,
                        title: message,
                        tone: AppTone.danger,
                      ),
                      const SizedBox(height: 10),
                    ],
                    FilledButton.icon(
                      onPressed: _busy ? null : _submit,
                      icon: const Icon(Icons.arrow_forward_rounded),
                      label: Text(
                        _busy
                            ? 'Un momento…'
                            : widget.register
                            ? 'Crear cuenta'
                            : 'Iniciar sesión',
                      ),
                    ),
                    if (widget.register) ...[
                      const SizedBox(height: 20),
                      const AppNotice(
                        icon: Icons.mail_outline,
                        title: 'Verificación por correo',
                        description:
                            'Te enviaremos un enlace para activar el acceso a tu cuenta.',
                      ),
                      const SizedBox(height: 14),
                      TextButton(
                        onPressed: _busy ? null : () => context.go('/login'),
                        child: const Text('Ya tengo una cuenta'),
                      ),
                    ] else ...[
                      const SizedBox(height: 14),
                      const Divider(height: 1),
                      const SizedBox(height: 14),
                      Text(
                        '¿Primera vez en MailGasto?',
                        textAlign: TextAlign.center,
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(fontSize: 13),
                      ),
                      const SizedBox(height: 9),
                      OutlinedButton(
                        onPressed: _busy
                            ? null
                            : () => context.push('/register'),
                        child: const Text('Crear cuenta'),
                      ),
                      const SizedBox(height: 8),
                      OutlinedButton.icon(
                        icon: const Icon(Icons.account_circle_outlined),
                        onPressed: _busy ? null : _google,
                        label: const Text('Continuar con Google'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
    ),
  );

  Widget _verification() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const _AccessHero(markOnly: true),
      const SizedBox(height: 24),
      PageHeading(
        'Verifica tu correo',
        eyebrow: 'PASO DE SEGURIDAD',
        description: 'Enviamos un enlace a ${_email.text.trim()}.',
      ),
      const SizedBox(height: 16),
      AppPanel(
        child: Column(
          children: [
            for (final (index, instruction) in const [
              'Abre el correo de MailGasto IA.',
              'Abre el enlace y confirma la contraseña.',
              'Vuelve a la app e inicia sesión.',
            ].indexed)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Row(
                  children: [
                    Container(
                      constraints: const BoxConstraints(
                        minWidth: 28,
                        minHeight: 28,
                      ),
                      alignment: Alignment.center,
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(
                        color: AppColors.blueTint,
                        borderRadius: BorderRadius.circular(9),
                      ),
                      child: Text(
                        '${index + 1}',
                        style: const TextStyle(
                          color: AppColors.primary,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(child: Text(instruction)),
                  ],
                ),
              ),
          ],
        ),
      ),
      const SizedBox(height: 22),
      FilledButton.icon(
        onPressed: () => context.go('/login'),
        icon: const Icon(Icons.arrow_forward_rounded),
        label: const Text('Volver a iniciar sesión'),
      ),
      const SizedBox(height: 22),
      const AppNotice(
        icon: Icons.mark_email_unread_outlined,
        title: 'Revisa también el correo no deseado',
        description: 'Busca el mensaje con el asunto «Verifica tu correo».',
      ),
    ],
  );
}

class _AccessHero extends StatelessWidget {
  const _AccessHero({this.markOnly = false});
  final bool markOnly;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minHeight: 156),
    alignment: Alignment.center,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 16),
    decoration: BoxDecoration(
      color: markOnly ? AppColors.blueTint : null,
      gradient: markOnly
          ? null
          : const LinearGradient(
              colors: [AppColors.blueTint, Color(0xFFE0F5F2)],
            ),
      borderRadius: BorderRadius.circular(22),
    ),
    child: markOnly ? const BrandMark(86) : const BrandLockup(hero: true),
  );
}
