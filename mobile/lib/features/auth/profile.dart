import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/widgets.dart';
import '../mailboxes/mailboxes.dart';
import 'auth.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(authProvider).asData?.value;
    return Scaffold(
      appBar: AppBar(title: const Text('Perfil')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (account != null)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      account.name,
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    Text(account.email),
                    const Chip(
                      avatar: Icon(Icons.verified_outlined, size: 18),
                      label: Text('Correo verificado'),
                    ),
                    TextButton.icon(
                      onPressed: () => showDialog<void>(
                        context: context,
                        builder: (_) => _NameDialog(account.name),
                      ),
                      icon: const Icon(Icons.edit_outlined),
                      label: const Text('Editar nombre'),
                    ),
                  ],
                ),
              ),
            ),
          Card(
            child: ListTile(
              leading: const Icon(Icons.mail_outline),
              title: const Text('Buzones'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.go('/settings/mailboxes'),
            ),
          ),
          Card(
            child: ListTile(
              leading: const Icon(Icons.shield_outlined),
              title: const Text('Seguridad y privacidad'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push('/settings/security'),
            ),
          ),
          const SizedBox(height: 18),
          OutlinedButton.icon(
            onPressed: () => ref.read(authProvider.notifier).logout(),
            icon: const Icon(Icons.logout),
            label: const Text('Cerrar sesión'),
          ),
        ],
      ),
    );
  }
}

class _NameDialog extends ConsumerStatefulWidget {
  const _NameDialog(this.name);
  final String name;

  @override
  ConsumerState<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends ConsumerState<_NameDialog> {
  late final _name = TextEditingController(text: widget.name);
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authProvider.notifier).rename(name);
      if (mounted) Navigator.pop(context);
    } catch (error) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = failureMessage(error);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Editar nombre'),
    content: TextField(
      key: const ValueKey('profile-name'),
      controller: _name,
      enabled: !_busy,
      maxLength: 80,
      autofocus: true,
      onChanged: (_) => setState(() {}),
      decoration: InputDecoration(labelText: 'Nombre', errorText: _error),
    ),
    actions: [
      TextButton(
        onPressed: _busy ? null : () => Navigator.pop(context),
        child: const Text('Cancelar'),
      ),
      FilledButton(
        onPressed: _busy || _name.text.trim().isEmpty ? null : _save,
        child: const Text('Guardar'),
      ),
    ],
  );
}

class SecurityScreen extends ConsumerStatefulWidget {
  const SecurityScreen({super.key});
  @override
  ConsumerState<SecurityScreen> createState() => _SecurityScreenState();
}

class _SecurityScreenState extends ConsumerState<SecurityScreen> {
  bool _busy = false;

  Future<void> _delete() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final mailboxes = await ref.read(mailboxesProvider.future);
      if (!mounted) return;
      if (mailboxes.any(
        (box) => box.source == 'oauth' && box.state != 'disconnected',
      )) {
        showMessage(
          context,
          'Desvincula tus buzones de Gmail antes de solicitar la eliminación.',
        );
        context.go('/settings/mailboxes');
        return;
      }
      final accepted = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Solicitar eliminación'),
          content: const Text(
            'Recibirás un enlace en tu correo verificado. Al confirmar se borrarán tus movimientos, avisos y conversaciones.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Enviar confirmación'),
            ),
          ],
        ),
      );
      if (accepted != true || !mounted) return;
      final result = await ref
          .read(apiProvider)
          .object('account/deletion', method: 'POST');
      if (mounted) showMessage(context, result['message'] as String);
    } catch (error) {
      if (mounted) showMessage(context, failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Seguridad y privacidad')),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: ListTile(
            leading: const Icon(Icons.lock_outline),
            title: const Text('Cambiar contraseña'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push('/settings/security/password'),
          ),
        ),
        Card(
          child: ListTile(
            leading: const Icon(Icons.mail_outline),
            title: const Text('Permisos de buzones'),
            subtitle: const Text('Revisa los accesos de solo lectura.'),
            onTap: () => context.go('/settings/mailboxes'),
          ),
        ),
        const SizedBox(height: 18),
        Text('Eliminar cuenta', style: Theme.of(context).textTheme.titleMedium),
        const Text(
          'El correo de confirmación explica cómo eliminar la cuenta y sus datos.',
        ),
        OutlinedButton.icon(
          onPressed: _busy ? null : _delete,
          icon: const Icon(Icons.delete_outline),
          label: const Text('Solicitar eliminación'),
        ),
      ],
    ),
  );
}

class RecoverScreen extends ConsumerStatefulWidget {
  const RecoverScreen({super.key});
  @override
  ConsumerState<RecoverScreen> createState() => _RecoverScreenState();
}

class DeleteAccountScreen extends ConsumerStatefulWidget {
  const DeleteAccountScreen(this.token, {super.key});
  final String? token;

  @override
  ConsumerState<DeleteAccountScreen> createState() =>
      _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends ConsumerState<DeleteAccountScreen> {
  bool _busy = false;
  String? _error;

  Future<void> _confirm() async {
    if (_busy || widget.token == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(apiProvider)
          .request(
            'account/deletion/confirm',
            method: 'POST',
            body: {'token': widget.token},
          );
      if (mounted) await ref.read(authProvider.notifier).logout();
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = failureMessage(error);
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Confirmar eliminación')),
    body: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const Text(
          'Se eliminarán tu cuenta, movimientos, avisos y conversaciones. Esta acción es irreversible.',
        ),
        if (_error case final error?)
          Text(
            error,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _busy || widget.token == null ? null : _confirm,
          child: const Text('Eliminar definitivamente'),
        ),
        TextButton(
          onPressed: _busy ? null : () => context.go('/settings/security'),
          child: const Text('Cancelar'),
        ),
      ],
    ),
  );
}

class _RecoverScreenState extends ConsumerState<RecoverScreen> {
  final _email = TextEditingController();
  final _form = GlobalKey<FormState>();
  bool _busy = false, _sent = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_busy || !_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authProvider.notifier).requestReset(_email.text.trim());
      if (mounted) setState(() => _sent = true);
    } catch (error) {
      if (mounted) setState(() => _error = failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Recuperar contraseña')),
    body: Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          if (_sent) ...[
            const Text(
              'Si el correo está asociado a una cuenta, recibirás un enlace.',
            ),
            TextButton(
              onPressed: () => context.go('/login'),
              child: const Text('Volver a iniciar sesión'),
            ),
          ] else ...[
            const Text('Ingresa el correo que usas para iniciar sesión.'),
            const SizedBox(height: 12),
            TextFormField(
              key: const ValueKey('recovery-email'),
              controller: _email,
              enabled: !_busy,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(labelText: 'Correo de acceso'),
              validator: (value) => value?.contains('@') == true
                  ? null
                  : 'Escribe un correo válido.',
            ),
            if (_error case final error?)
              Text(
                error,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy ? null : _send,
              child: const Text('Enviar enlace'),
            ),
          ],
        ],
      ),
    ),
  );
}

class PasswordScreen extends ConsumerStatefulWidget {
  const PasswordScreen({super.key, this.reset = false, this.token});
  final bool reset;
  final String? token;

  @override
  ConsumerState<PasswordScreen> createState() => _PasswordScreenState();
}

class _PasswordScreenState extends ConsumerState<PasswordScreen> {
  final _form = GlobalKey<FormState>();
  final _current = TextEditingController(),
      _password = TextEditingController(),
      _confirm = TextEditingController();
  bool _busy = false, _expired = false;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy || !_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final auth = ref.read(authProvider.notifier);
    try {
      if (widget.reset) {
        await auth.resetPassword(widget.token!, _password.text);
      } else {
        await auth.changePassword(_current.text, _password.text);
      }
      if (!mounted) return;
      showMessage(context, 'Contraseña actualizada.');
      if (widget.reset) {
        context.go('/login');
      } else {
        context.pop();
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _expired = error is ApiFailure && error.status == 422;
          _error = failureMessage(error);
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.reset ? 'Nueva contraseña' : 'Cambiar contraseña'),
    ),
    body: Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          if (widget.reset && (widget.token == null || _expired)) ...[
            Text(_error ?? 'El enlace de recuperación es inválido o venció.'),
            TextButton(
              onPressed: () => context.go('/recover'),
              child: const Text('Solicitar otro enlace'),
            ),
          ] else ...[
            if (!widget.reset)
              _field(_current, 'Contraseña actual', 'current-password'),
            _field(_password, 'Nueva contraseña', 'new-password'),
            _field(
              _confirm,
              'Confirma la contraseña',
              'confirm-password',
              confirmation: true,
            ),
            if (_error case final error?)
              Text(
                error,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy ? null : _save,
              child: Text(
                widget.reset ? 'Guardar contraseña' : 'Guardar cambios',
              ),
            ),
            if (!widget.reset)
              TextButton(
                onPressed: _busy ? null : () => context.push('/recover'),
                child: const Text('Recuperar contraseña'),
              ),
          ],
        ],
      ),
    ),
  );

  Widget _field(
    TextEditingController controller,
    String label,
    String key, {
    bool confirmation = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextFormField(
      key: ValueKey(key),
      controller: controller,
      enabled: !_busy,
      obscureText: true,
      decoration: InputDecoration(labelText: label),
      validator: (value) {
        if (confirmation) {
          return value == _password.text
              ? null
              : 'Las contraseñas deben coincidir.';
        }
        return value == null || value.length < 12 || value.length > 128
            ? 'Usa entre 12 y 128 caracteres.'
            : null;
      },
    ),
  );
}
