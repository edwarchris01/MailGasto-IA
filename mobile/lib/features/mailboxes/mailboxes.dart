import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/format.dart';
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
        content: const Text(
          'MailGasto solicita acceso de solo lectura a Gmail para identificar '
          'avisos bancarios y registrar sus movimientos. Puedes retirar el acceso '
          'en cualquier momento desde Buzones.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Continuar con Google'),
          ),
        ],
      ),
    );
    if (accepted != true || !mounted) return;
    final uri = await ref.read(mailboxRepositoryProvider).authorize(id);
    if (!mounted) return;
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      throw const ApiFailure('No pudimos abrir el navegador.');
    }
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

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      leading: BackButton(onPressed: () => context.go('/settings')),
      title: const Text('Buzones'),
    ),
    body: RefreshIndicator(
      onRefresh: () => ref
          .refresh(mailboxesProvider.future)
          .then<void>((_) {}, onError: (Object _) {}),
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Cuentas conectadas',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          ref
              .watch(mailboxesProvider)
              .when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (error, _) => RetryMessage(
                  error,
                  () => ref.invalidate(mailboxesProvider),
                ),
                data: (mailboxes) => Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (mailboxes.isEmpty)
                      const Text('Aún no tienes buzones vinculados.'),
                    for (final mailbox in mailboxes)
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                mailbox.email,
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              Text(switch (mailbox.state) {
                                'active' => 'Vinculado',
                                'reconnect' => 'Reconexión requerida',
                                'disconnected' => 'Desvinculado',
                                _ => 'Estado desconocido',
                              }),
                              const SizedBox(height: 4),
                              Text(
                                mailbox.syncedAt == null
                                    ? 'Sin fecha de sincronización'
                                    : 'Última sincronización: ${syncLabel(mailbox.syncedAt!)}',
                              ),
                              Wrap(
                                spacing: 8,
                                children: [
                                  if (mailbox.state == 'reconnect' ||
                                      mailbox.state == 'disconnected')
                                    TextButton(
                                      onPressed: _busy
                                          ? null
                                          : () {
                                              if (mailbox.source == 'oauth') {
                                                _authorize(mailbox.id);
                                              } else {
                                                _run(() async {
                                                  await ref
                                                      .read(
                                                        mailboxRepositoryProvider,
                                                      )
                                                      .reconnectExisting();
                                                  if (mounted) {
                                                    ref.invalidate(
                                                      mailboxesProvider,
                                                    );
                                                  }
                                                });
                                              }
                                            },
                                      child: const Text('Reconectar'),
                                    ),
                                  if (mailbox.state != 'disconnected')
                                    TextButton(
                                      onPressed: _busy
                                          ? null
                                          : () => _disconnect(mailbox),
                                      child: const Text('Desvincular'),
                                    ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _busy ? null : _authorize,
            icon: const Icon(Icons.add_link),
            label: const Text('Vincular Gmail'),
          ),
          const ListTile(
            leading: Icon(Icons.shield_outlined),
            title: Text('Acceso de solo lectura'),
            subtitle: Text(
              'Identificamos los avisos bancarios del buzón autorizado.',
            ),
          ),
          const ListTile(
            leading: Icon(Icons.mail_outline),
            title: Text('Outlook'),
            subtitle: Text('Próximamente'),
          ),
        ],
      ),
    ),
  );
}
