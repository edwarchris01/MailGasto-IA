import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/design.dart';
import '../../core/widgets.dart';
import '../mailboxes/mailboxes.dart';
import 'auth.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(authProvider).asData?.value;
    final boxes = ref.watch(mailboxesProvider).asData?.value;
    final active = boxes?.where((box) => box.state == 'active').length ?? 0;
    final reconnect =
        boxes?.where((box) => box.state == 'reconnect').length ?? 0;
    final mailboxSummary = [
      if (active > 0) '$active ${active == 1 ? 'vinculado' : 'vinculados'}',
      if (reconnect > 0) '$reconnect por reconectar',
    ].join(' · ');
    return Scaffold(
      appBar: brandBar(),
      body: ListView(
        padding: screenPadding,
        children: [
          const PageHeading(
            'Perfil',
            eyebrow: 'CUENTA',
            description: 'Administra tus datos y tus conexiones.',
          ),
          const SizedBox(height: 16),
          if (account != null) ...[
            _AccountCard(
              account,
              onEdit: () => showDialog<void>(
                context: context,
                builder: (_) => _NameDialog(account.name),
              ),
            ),
            const SizedBox(height: 24),
          ],
          const SectionHeading('Ajustes de la cuenta'),
          const SizedBox(height: 10),
          _AccountRow(
            icon: Icons.mail_outline,
            title: 'Buzones',
            description: boxes == null
                ? 'Administra tus cuentas de correo.'
                : mailboxSummary.isEmpty
                ? 'Sin buzones activos'
                : mailboxSummary,
            onTap: () => context.go('/settings/mailboxes'),
          ),
          const SizedBox(height: 10),
          _AccountRow(
            icon: Icons.shield_outlined,
            title: 'Seguridad y privacidad',
            description: 'Contraseña y gestión de datos',
            onTap: () => context.push('/settings/security'),
          ),
          const SizedBox(height: 46),
          OutlinedButton.icon(
            onPressed: () => ref.read(authProvider.notifier).logout(),
            icon: const Icon(Icons.logout_rounded),
            label: const Text('Cerrar sesión'),
          ),
        ],
      ),
    );
  }
}

class _AccountCard extends StatelessWidget {
  const _AccountCard(this.account, {required this.onEdit});
  final Account account;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final initials = account.name
        .trim()
        .split(RegExp(r'\s+'))
        .where((word) => word.isNotEmpty)
        .take(2)
        .map((word) => word.characters.first.toUpperCase())
        .join();
    return AppPanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 46,
                height: 46,
                alignment: Alignment.center,
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: AppColors.blueTint,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: ExcludeSemantics(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(
                      initials.isEmpty ? '–' : initials,
                      textAlign: TextAlign.center,
                      style: text.titleMedium?.copyWith(
                        color: AppColors.accent,
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(account.name, style: text.titleLarge),
                    const SizedBox(height: 4),
                    Text(account.email, style: text.bodySmall),
                    const SizedBox(height: 7),
                    const AppBadge(
                      'Correo verificado',
                      tone: AppTone.income,
                      icon: Icons.verified_outlined,
                    ),
                  ],
                ),
              ),
            ],
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: onEdit,
              child: const Text('Editar nombre'),
            ),
          ),
        ],
      ),
    );
  }
}

class _AccountRow extends StatelessWidget {
  const _AccountRow({
    required this.icon,
    required this.title,
    required this.description,
    this.tone = AppTone.info,
    this.onTap,
  });
  final IconData icon;
  final String title, description;
  final AppTone tone;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Card(
    child: InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            IconTile(icon, tone: tone),
            const SizedBox(width: 11),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 3),
                  Text(
                    description,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            if (onTap != null)
              const Padding(
                padding: EdgeInsets.only(left: 6),
                child: Icon(
                  Icons.chevron_right_rounded,
                  color: AppColors.muted,
                  size: 18,
                ),
              ),
          ],
        ),
      ),
    ),
  );
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
    scrollable: true,
    content: LabeledField(
      'Nombre',
      child: TextField(
        key: const ValueKey('profile-name'),
        controller: _name,
        enabled: !_busy,
        maxLength: 80,
        autofocus: true,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(errorText: _error, counterText: ''),
      ),
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
  Widget build(BuildContext context) {
    final account = ref.watch(authProvider).asData?.value;
    return Scaffold(
      appBar: appBackBar('Perfil', () => context.pop()),
      body: ListView(
        padding: screenPadding,
        children: [
          const PageHeading(
            'Seguridad y privacidad',
            description: 'Controla el acceso y los datos de tu cuenta.',
          ),
          const SizedBox(height: 24),
          const SectionHeading('Acceso'),
          const SizedBox(height: 9),
          _AccountRow(
            icon: Icons.lock_outline,
            title: 'Cambiar contraseña',
            description: 'Confirma tu contraseña actual',
            onTap: () => context.push('/settings/security/password'),
          ),
          if (account != null) ...[
            const SizedBox(height: 10),
            _AccountRow(
              icon: Icons.verified_outlined,
              title: 'Correo verificado',
              description: account.email,
              tone: AppTone.income,
            ),
          ],
          const SizedBox(height: 24),
          const SectionHeading('Privacidad'),
          const SizedBox(height: 9),
          _AccountRow(
            icon: Icons.mail_outline,
            title: 'Permisos de buzones',
            description: 'Revisa los accesos de solo lectura.',
            onTap: () => context.go('/settings/mailboxes'),
          ),
          const SizedBox(height: 12),
          AppPanel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Eliminar cuenta',
                  style: Theme.of(
                    context,
                  ).textTheme.titleLarge?.copyWith(color: AppColors.danger),
                ),
                const SizedBox(height: 6),
                Text(
                  'La confirmación elimina tus movimientos, avisos y conversaciones.',
                  style: Theme.of(
                    context,
                  ).textTheme.bodyMedium?.copyWith(color: AppColors.muted),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _busy ? null : _delete,
                  style: dangerButtonStyle(),
                  icon: const Icon(Icons.delete_outline),
                  label: const Text('Solicitar eliminación'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
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
    appBar: appBackBar(
      'Seguridad y privacidad',
      () => context.go('/settings/security'),
    ),
    body: ListView(
      padding: screenPadding,
      children: [
        const PageHeading('Confirmar eliminación', eyebrow: 'PRIVACIDAD'),
        const SizedBox(height: 14),
        const AppNotice(
          icon: Icons.delete_outline,
          title: 'Eliminar cuenta',
          description:
              'Se eliminarán tu cuenta, movimientos, avisos y conversaciones. Esta acción es irreversible.',
          tone: AppTone.danger,
        ),
        if (_error case final error?) ...[
          const SizedBox(height: 10),
          AppNotice(
            icon: Icons.error_outline,
            title: error,
            tone: AppTone.danger,
          ),
        ],
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: _busy || widget.token == null ? null : _confirm,
          style: dangerButtonStyle(),
          icon: const Icon(Icons.delete_outline),
          label: const Text('Eliminar definitivamente'),
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
    FocusScope.of(context).unfocus();
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
  Widget build(BuildContext context) {
    final authenticated = ref.watch(
      authProvider.select((auth) => auth.asData?.value != null),
    );
    void back() {
      if (context.canPop()) {
        context.pop();
      } else {
        context.go(authenticated ? '/settings/security' : '/login');
      }
    }

    return Scaffold(
      appBar: appBackBar(
        authenticated ? 'Cambiar contraseña' : 'Iniciar sesión',
        back,
      ),
      body: FormLayout(
        child: Form(
          key: _form,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Align(
                alignment: Alignment.centerLeft,
                child: IconTile(Icons.key_outlined, size: 50),
              ),
              const SizedBox(height: 16),
              PageHeading(
                _sent ? 'Revisa tu correo' : 'Recuperar contraseña',
                eyebrow: 'SEGURIDAD',
                description: _sent
                    ? null
                    : 'Ingresa el correo que usas para iniciar sesión.',
              ),
              if (!_sent) ...[
                const SizedBox(height: 16),
                LabeledField(
                  'Correo de acceso',
                  child: TextFormField(
                    key: const ValueKey('recovery-email'),
                    controller: _email,
                    enabled: !_busy,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.email],
                    decoration: const InputDecoration(
                      hintText: 'nombre@ejemplo.com',
                    ),
                    validator: (value) => value?.contains('@') == true
                        ? null
                        : 'Escribe un correo válido.',
                  ),
                ),
                if (_error case final error?) ...[
                  const SizedBox(height: 10),
                  AppNotice(
                    icon: Icons.error_outline,
                    title: error,
                    tone: AppTone.danger,
                  ),
                ],
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: _busy ? null : _send,
                  icon: const Icon(Icons.send_outlined),
                  label: const Text('Enviar enlace'),
                ),
              ],
              const SizedBox(height: 24),
              AppNotice(
                icon: Icons.mark_email_read_outlined,
                title: _sent ? 'Solicitud recibida' : 'Después del envío',
                description:
                    'Si el correo está asociado a una cuenta, recibirás un enlace para crear una contraseña nueva.',
                tone: _sent ? AppTone.income : AppTone.info,
              ),
              const SizedBox(height: 14),
              TextButton(
                onPressed: _busy ? null : back,
                child: Text(
                  authenticated
                      ? 'Volver a cambiar contraseña'
                      : 'Volver a iniciar sesión',
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
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
    appBar: appBackBar(
      widget.reset ? 'Iniciar sesión' : 'Seguridad y privacidad',
      () => widget.reset ? context.go('/login') : context.pop(),
    ),
    body: FormLayout(
      child: Form(
        key: _form,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Align(
              alignment: Alignment.centerLeft,
              child: IconTile(Icons.key_outlined, size: 50),
            ),
            const SizedBox(height: 16),
            PageHeading(
              widget.reset ? 'Nueva contraseña' : 'Cambiar contraseña',
              eyebrow: 'SEGURIDAD',
            ),
            const SizedBox(height: 18),
            if (widget.reset && (widget.token == null || _expired)) ...[
              AppNotice(
                icon: Icons.timer_off_outlined,
                title:
                    _error ?? 'El enlace de recuperación es inválido o venció.',
                description:
                    'Solicita un enlace nuevo para recuperar tu cuenta.',
                tone: AppTone.warning,
              ),
              const SizedBox(height: 14),
              OutlinedButton(
                onPressed: () => context.go('/recover'),
                child: const Text('Solicitar otro enlace'),
              ),
            ] else ...[
              if (!widget.reset) ...[
                _field(_current, 'Contraseña actual', 'current-password'),
                const SizedBox(height: 12),
              ],
              _field(_password, 'Nueva contraseña', 'new-password'),
              const SizedBox(height: 12),
              _field(
                _confirm,
                'Confirma la contraseña',
                'confirm-password',
                confirmation: true,
              ),
              const SizedBox(height: 8),
              Text(
                'Usa al menos 12 caracteres en la nueva contraseña.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (_error case final error?) ...[
                const SizedBox(height: 10),
                AppNotice(
                  icon: Icons.error_outline,
                  title: error,
                  tone: AppTone.danger,
                ),
              ],
              const SizedBox(height: 18),
              FilledButton.icon(
                onPressed: _busy ? null : _save,
                icon: const Icon(Icons.check_rounded),
                label: Text(
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
    ),
  );

  Widget _field(
    TextEditingController controller,
    String label,
    String key, {
    bool confirmation = false,
  }) => PasswordField(
    fieldKey: ValueKey(key),
    label: label,
    controller: controller,
    enabled: !_busy,
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
  );
}
