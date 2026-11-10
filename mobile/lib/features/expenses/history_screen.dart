import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/widgets.dart';
import 'expenses.dart';

class NoticeScreen extends ConsumerWidget {
  const NoticeScreen(this.id, {super.key});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = noticeProvider(id);
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: BackButton(
          onPressed: () => context.go(
            GoRouterState.of(context).uri.replace(path: '/history').toString(),
          ),
        ),
        title: const Text('Detalle del aviso'),
      ),
      body: ref
          .watch(provider)
          .when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (error, _) =>
                RetryMessage(error, () => ref.invalidate(provider)),
            data: (notice) => ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Align(
                  alignment: Alignment.centerLeft,
                  child: StatusBadge(notice.status),
                ),
                const SizedBox(height: 12),
                Text(
                  notice.amount ?? 'Monto por confirmar',
                  style: theme.textTheme.headlineMedium,
                ),
                const SizedBox(height: 8),
                Text(notice.description ?? notice.providerLabel),
                const SizedBox(height: 12),
                if (notice.status == 'pending')
                  Card(
                    color: const Color(0xFFFFF1C2),
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Text(
                        notice.pendingExplanation,
                        style: const TextStyle(color: Color(0xFF78350F)),
                      ),
                    ),
                  ),
                if (notice.status == 'pending' &&
                    notice.reason != 'unverified_sender')
                  const ListTile(
                    leading: Icon(Icons.forward_to_inbox_outlined),
                    title: Text('Cómo reenviar el aviso'),
                    subtitle: Text(
                      'Abre el mensaje original de tu banco y reenvíalo completo al Gmail vinculado.',
                    ),
                  ),
                if (notice.status == 'error')
                  Text(
                    notice.reason == 'mailbox_disconnected'
                        ? 'El buzón se desvinculó durante el procesamiento.'
                        : 'Ocurrió un fallo al procesar el aviso.',
                  ),
                const ListTile(title: Text('Origen'), subtitle: Text('Correo')),
                ListTile(
                  title: const Text('Fecha'),
                  subtitle: Text(
                    notice.date == null
                        ? 'Por confirmar'
                        : dayLabel(notice.date!),
                  ),
                ),
                ListTile(
                  title: const Text('Medio de pago'),
                  subtitle: Text(notice.paymentMethod ?? 'Por confirmar'),
                ),
                ListTile(
                  title: const Text('Categoría'),
                  subtitle: Text(
                    categories[notice.category] ?? 'Por confirmar',
                  ),
                ),
                ListTile(
                  title: const Text('Recibido'),
                  subtitle: Text(syncLabel(notice.receivedAt)),
                ),
              ],
            ),
          ),
    );
  }
}
