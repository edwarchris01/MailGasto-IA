import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/design.dart';
import '../../core/format.dart';
import '../../core/google_browser.dart';
import '../../core/widgets.dart';
import '../auth/auth.dart';

typedef Mailbox = ({
  String id,
  String email,
  String state,
  String source,
  String? syncedAt,
});

final mailboxRepositoryProvider = Provider((ref) {
  ref.watch(authProvider.select((auth) => auth.asData?.value?.id));
  return MailboxRepository(ref.watch(apiProvider));
});
final mailboxesProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(mailboxRepositoryProvider).list(),
);

final mailboxFeedbackProvider =
    NotifierProvider<MailboxFeedback, ({bool cancelled, String? mailboxId})>(
      MailboxFeedback.new,
    );

class MailboxFeedback extends Notifier<({bool cancelled, String? mailboxId})> {
  @override
  ({bool cancelled, String? mailboxId}) build() {
    ref.watch(authProvider.select((auth) => auth.asData?.value?.id));
    return (cancelled: false, mailboxId: null);
  }

  void start(String? mailboxId) =>
      state = (cancelled: false, mailboxId: mailboxId);

  void cancel() => state = (cancelled: true, mailboxId: state.mailboxId);
}

class MailboxRepository {
  MailboxRepository(this.api);
  final ApiClient api;

  Future<List<Mailbox>> list() async => (await api.list('mailboxes'))
      .map(
        (row) => (
          id: row['id'] as String,
          email: row['email'] as String,
          state: row['state'] as String,
          source: row['source'] as String,
          syncedAt: row['last_synced_at'] as String?,
        ),
      )
      .toList();

  Future<Uri> authorize(String? id) async {
    final result = await api.object(
      'mobile/mailboxes/gmail/authorize',
      method: 'POST',
      body: {'mailboxId': ?id},
    );
    return googleAuthorizationUrl(result);
  }

  Future<void> complete(String receipt) => api.request(
    'mobile/mailboxes/gmail/complete',
    method: 'POST',
    body: {'receipt': receipt},
  );

  Future<void> reconnectExisting() =>
      api.request('mailboxes/gmail/existing', method: 'POST');

  Future<bool> disconnect(String id) async =>
      (await api.object(
        'mailboxes/${Uri.encodeComponent(id)}',
        method: 'DELETE',
      ))['providerRevoked'] ==
      true;
}

class MailboxesScreen extends ConsumerStatefulWidget {
  const MailboxesScreen({super.key});

  @override
  ConsumerState<MailboxesScreen> createState() => _MailboxesScreenState();
}

class _MailboxesScreenState extends ConsumerState<MailboxesScreen> {
  bool _busy = false;

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } catch (error) {
      if (mounted) showMessage(context, failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _authorize([String? id]) => _run(() async {
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Vincular con Google'),
        scrollable: true,
        content: const AppNotice(
          icon: Icons.shield_outlined,
          title: 'Permiso de lectura',
          description:
              'MailGasto solicita acceso de solo lectura a Gmail para identificar '
              'avisos de pagos e ingresos. Puedes retirar el acceso desde Buzones.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton.icon(
            onPressed: () => Navigator.pop(context, true),
            icon: const Icon(Icons.open_in_new_rounded),
            label: const Text('Continuar con Google'),
          ),
        ],
      ),
    );
    if (accepted != true || !mounted) return;
    ref.read(mailboxFeedbackProvider.notifier).start(id);
    final uri = await ref.read(mailboxRepositoryProvider).authorize(id);
    if (!mounted) return;
    await openGoogleAuthorization(
      uri,
      ref.read(apiProvider).origin,
      GoogleFlow.gmail,
    );
  });

  Future<void> _disconnect(Mailbox mailbox) => _run(() async {
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Desvincular buzón'),
        content: Text(
          'Se detendrá la sincronización de ${mailbox.email}. El historial se conserva.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            style: dangerButtonStyle(),
            child: const Text('Desvincular'),
          ),
        ],
      ),
    );
    if (accepted != true || !mounted) return;
    final revoked = await ref
        .read(mailboxRepositoryProvider)
        .disconnect(mailbox.id);
    if (mounted) {
      ref.invalidate(mailboxesProvider);
      showMessage(
        context,
        revoked
            ? 'Buzón desvinculado.'
            : 'Buzón desvinculado. Revoca también el permiso desde tu cuenta de Google.',
      );
    }
  });

  Future<void> _reconnect(Mailbox mailbox) async {
    if (mailbox.source == 'oauth') {
      await _authorize(mailbox.id);
    } else {
      await _run(() async {
        await ref.read(mailboxRepositoryProvider).reconnectExisting();
        if (mounted) ref.invalidate(mailboxesProvider);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(mailboxesProvider);
    final feedback = ref.watch(mailboxFeedbackProvider);
    return Scaffold(
      appBar: appBackBar('Perfil', () => context.go('/settings')),
      body: RefreshIndicator(
        onRefresh: () => ref
            .refresh(mailboxesProvider.future)
            .then<void>((_) {}, onError: (Object _) {}),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: screenPadding,
          children: [
            const PageHeading(
              'Buzones',
              description: 'Vincula el correo donde recibes avisos bancarios.',
            ),
            const SizedBox(height: 16),
            if (feedback.cancelled) ...[
              const AppNotice(
                icon: Icons.cancel_outlined,
                title: 'Vinculación cancelada',
                description: 'Puedes volver a abrir Google desde Buzones.',
                tone: AppTone.warning,
              ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: _busy ? null : () => _authorize(feedback.mailboxId),
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Volver a intentar'),
              ),
              const SizedBox(height: 12),
            ],
            state.when(
              loading: () => const LinearProgressIndicator(
                semanticsLabel: 'Cargando buzones',
              ),
              error: (error, _) => AppPanel(
                child: RetryMessage(
                  error,
                  () => ref.invalidate(mailboxesProvider),
                ),
              ),
              data: (mailboxes) => mailboxes.isEmpty
                  ? const AppNotice(
                      icon: Icons.mail_outline,
                      title: 'Aún no tienes buzones vinculados.',
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (final (index, mailbox) in mailboxes.indexed) ...[
                          if (index > 0) const SizedBox(height: 12),
                          _MailboxCard(
                            mailbox,
                            onReconnect: _busy
                                ? null
                                : () => _reconnect(mailbox),
                            onDisconnect: _busy
                                ? null
                                : () => _disconnect(mailbox),
                          ),
                        ],
                      ],
                    ),
            ),
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: _busy ? null : _authorize,
              icon: const Icon(Icons.add_rounded),
              label: const Text('Vincular Gmail'),
            ),
            const SizedBox(height: 13),
            const AppNotice(
              icon: Icons.shield_outlined,
              title: 'Acceso de solo lectura',
              description:
                  'MailGasto identifica avisos bancarios en el buzón autorizado.',
            ),
            const SizedBox(height: 12),
            AppPanel(
              padding: const EdgeInsets.all(11),
              child: Row(
                children: [
                  const IconTile(
                    Icons.mail_outline,
                    tone: AppTone.neutral,
                    size: 36,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Outlook',
                      style: Theme.of(
                        context,
                      ).textTheme.titleMedium?.copyWith(color: AppColors.muted),
                    ),
                  ),
                  const SizedBox(width: 5),
                  const Flexible(
                    child: AppBadge('Próximamente', tone: AppTone.neutral),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MailboxCard extends StatelessWidget {
  const _MailboxCard(
    this.mailbox, {
    required this.onReconnect,
    required this.onDisconnect,
  });
  final Mailbox mailbox;
  final VoidCallback? onReconnect, onDisconnect;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final (label, tone) = switch (mailbox.state) {
      'active' => ('Vinculado', AppTone.income),
      'reconnect' => ('Por reconectar', AppTone.warning),
      'disconnected' => ('Desvinculado', AppTone.neutral),
      _ => ('Estado desconocido', AppTone.neutral),
    };
    final reconnect =
        mailbox.state == 'reconnect' || mailbox.state == 'disconnected';
    final reconnectButton = FilledButton.tonalIcon(
      onPressed: onReconnect,
      icon: const Icon(Icons.refresh_rounded),
      label: const Text('Reconectar'),
    );
    final disconnectButton = OutlinedButton(
      onPressed: onDisconnect,
      child: const Text('Desvincular'),
    );
    return AppPanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              IconTile(
                mailbox.state == 'reconnect'
                    ? Icons.mark_email_unread_outlined
                    : Icons.mail_outline,
                tone: mailbox.state == 'reconnect'
                    ? AppTone.warning
                    : AppTone.info,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    TrailingRow(
                      leading: Text('Gmail', style: text.titleLarge),
                      trailing: AppBadge(label, tone: tone),
                    ),
                    const SizedBox(height: 3),
                    Text(mailbox.email, style: text.bodySmall),
                  ],
                ),
              ),
            ],
          ),
          if (mailbox.syncedAt case final sync?) ...[
            const SizedBox(height: 12),
            TrailingRow(
              crossAxisAlignment: CrossAxisAlignment.start,
              leading: Text('Última sincronización', style: text.labelSmall),
              trailing: Text(
                syncLabel(sync),
                textAlign: TextAlign.end,
                style: text.bodySmall,
              ),
            ),
          ] else if (mailbox.state == 'active') ...[
            const SizedBox(height: 10),
            Text('Sin fecha de sincronización', style: text.bodySmall),
          ],
          const SizedBox(height: 10),
          if (mailbox.state == 'reconnect')
            FormPair(first: reconnectButton, second: disconnectButton)
          else if (reconnect)
            reconnectButton
          else
            disconnectButton,
        ],
      ),
    );
  }
}
