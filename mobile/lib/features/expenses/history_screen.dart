import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';
import 'expenses.dart';
import 'finance.dart';
import 'movements_screen.dart';

class NoticeScreen extends ConsumerStatefulWidget {
  const NoticeScreen(this.id, {super.key, this.confirming = false});
  final String id;
  final bool confirming;

  @override
  ConsumerState<NoticeScreen> createState() => _NoticeScreenState();
}

class _NoticeScreenState extends ConsumerState<NoticeScreen> {
  bool _discarding = false;

  String _path(String path) => financePath(path, {
    ...GoRouterState.of(context).uri.queryParameters,
    'tab': 'notices',
  });

  Future<void> _discard() async {
    if (_discarding) return;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('¿Descartar este aviso?'),
        content: const Text('El aviso se quitará de la lista de Avisos.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Descartar'),
          ),
        ],
      ),
    );
    if (accepted != true || !mounted || _discarding) return;
    setState(() => _discarding = true);
    try {
      await ref.read(expenseRepositoryProvider).discard(widget.id);
      if (!mounted) return;
      refreshNotices(ref, widget.id);
      showMessage(context, 'Aviso descartado.');
      context.go(_path('/history'));
    } catch (error) {
      if (!mounted) return;
      showMessage(context, failureMessage(error));
      if (error is ApiFailure && (error.status == 404 || error.status == 409)) {
        refreshNotices(ref, widget.id);
        refreshFinance(ref);
        context.go(_path('/history'));
      }
    } finally {
      if (mounted) setState(() => _discarding = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final id = widget.id;
    final provider = noticeProvider(id);
    final state = ref.watch(provider);
    final current = state.asData?.value;
    if (widget.confirming && current != null && current.status == 'pending') {
      return MovementForm(key: ValueKey(current.id), notice: current);
    }
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: BackButton(
          onPressed: () => context.go(
            _path(widget.confirming ? '/history/$id' : '/history'),
          ),
        ),
        title: Text(
          widget.confirming ? 'Confirmar movimiento' : 'Detalle del aviso',
        ),
      ),
      body: state.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) =>
            RetryMessage(error, () => ref.invalidate(provider)),
        data: (notice) => widget.confirming
            ? const Center(child: Text('El aviso ya no está pendiente.'))
            : ListView(
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
                  if (notice.status == 'pending') ...[
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
                    const SizedBox(height: 8),
                    FilledButton.icon(
                      onPressed: _discarding
                          ? null
                          : () => context.push(_path('/history/$id/confirm')),
                      icon: const Icon(Icons.check),
                      label: const Text('Confirmar movimiento'),
                    ),
                    TextButton.icon(
                      onPressed: _discarding ? null : _discard,
                      style: TextButton.styleFrom(
                        foregroundColor: theme.colorScheme.error,
                      ),
                      icon: const Icon(Icons.delete_outline),
                      label: Text(
                        _discarding ? 'Descartando…' : 'Descartar aviso',
                      ),
                    ),
                    if (notice.provider != 'other')
                      const ListTile(
                        leading: Icon(Icons.forward_to_inbox_outlined),
                        title: Text('Cómo reenviar el aviso'),
                        subtitle: Text(
                          'Abre el mensaje original de tu banco y reenvíalo completo al Gmail vinculado.',
                        ),
                      ),
                  ],
                  if (notice.status == 'error')
                    Text(
                      notice.reason == 'mailbox_disconnected'
                          ? 'El buzón se desvinculó durante el procesamiento.'
                          : 'Ocurrió un fallo al procesar el aviso.',
                    ),
                  const ListTile(
                    title: Text('Origen'),
                    subtitle: Text('Correo'),
                  ),
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
                    subtitle: Text(
                      notice.paymentMethod ??
                          (notice.status == 'registered'
                              ? 'Sin especificar'
                              : 'Por confirmar'),
                    ),
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
