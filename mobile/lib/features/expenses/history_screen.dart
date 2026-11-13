import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/design.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';
import 'expenses.dart';
import 'finance.dart';
import 'movements_screen.dart';
import 'notice_style.dart';

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
    return Scaffold(
      appBar: appBackBar(
        widget.confirming ? 'Detalle del aviso' : 'Movimientos',
        () =>
            context.go(_path(widget.confirming ? '/history/$id' : '/history')),
      ),
      body: state.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) =>
            RetryMessage(error, () => ref.invalidate(provider)),
        data: (notice) => widget.confirming
            ? const Center(child: Text('El aviso ya no está pendiente.'))
            : _details(context, notice),
      ),
    );
  }

  Widget _details(BuildContext context, Notice notice) {
    final tone = noticeTone(notice.status);
    final text = Theme.of(context).textTheme;
    final pending = notice.status == 'pending';
    final date = notice.date ?? notice.reported.date;
    final method =
        notice.paymentMethod ??
        (pending ? notice.reported.paymentMethod : null);
    return ListView(
      padding: screenPadding,
      children: [
        PageHeading(
          'Detalle del aviso',
          eyebrow: 'HISTORIAL',
          description: notice.providerLabel,
        ),
        const SizedBox(height: 14),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: tone.tint,
            borderRadius: BorderRadius.circular(17),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 5,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Icon(noticeIcon(notice.status), size: 19, color: tone.ink),
                  Text(
                    notice.amount ?? 'Monto por confirmar',
                    style: text.titleLarge?.copyWith(color: tone.ink),
                  ),
                  StatusBadge(notice.status),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                '${notice.providerLabel} · Recibido el ${receivedDay(notice.receivedAt, year: true)} · Correo',
                style: text.bodySmall?.copyWith(color: tone.ink),
              ),
              if (notice.description case final description?) ...[
                const SizedBox(height: 4),
                Text(
                  description,
                  style: text.bodyMedium?.copyWith(color: tone.ink),
                ),
              ],
            ],
          ),
        ),
        if (pending) ...[
          const SizedBox(height: 10),
          AppPanel(child: Text(notice.pendingExplanation)),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _discarding
                ? null
                : () => context.push(_path('/history/${notice.id}/confirm')),
            icon: const Icon(Icons.check_rounded),
            label: const Text('Confirmar movimiento'),
          ),
          const SizedBox(height: 8),
          FilledButton.icon(
            onPressed: _discarding ? null : _discard,
            style: dangerButtonStyle(),
            icon: const Icon(Icons.delete_outline),
            label: Text(_discarding ? 'Descartando…' : 'Descartar aviso'),
          ),
          if (notice.provider != 'other') ...[
            const SizedBox(height: 10),
            Card(
              child: ExpansionTile(
                leading: const Icon(Icons.forward_to_inbox_outlined),
                title: const Text('Cómo reenviar el aviso'),
                childrenPadding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                expandedAlignment: Alignment.centerLeft,
                shape: const Border(),
                collapsedShape: const Border(),
                children: const [
                  Text(
                    'Abre el mensaje original de tu banco y reenvíalo completo al Gmail vinculado.',
                  ),
                ],
              ),
            ),
          ],
        ] else if (notice.status == 'error') ...[
          const SizedBox(height: 10),
          AppNotice(
            icon: Icons.error_outline,
            title: noticePreview(notice),
            description: notice.reason == 'mailbox_disconnected'
                ? 'El buzón se desvinculó durante el procesamiento.'
                : 'Ocurrió un fallo al procesar el aviso.',
            tone: AppTone.danger,
          ),
        ] else if (notice.status == 'processing') ...[
          const SizedBox(height: 10),
          const AppNotice(
            icon: Icons.schedule_outlined,
            title: 'Estamos validando el aviso.',
          ),
        ],
        const SizedBox(height: 12),
        DetailFields([
          ('Origen', 'Correo'),
          if (notice.direction case 'income' || 'expense')
            ('Tipo', notice.direction == 'income' ? 'Ingreso' : 'Gasto'),
          (
            pending && date != null ? 'Fecha indicada' : 'Fecha',
            date == null ? 'Por confirmar' : notice.reported.dateLabel(date),
          ),
          ?notice.reported.separateTime(date),
          (
            'Medio de pago',
            notice.reported.paymentLabel(method) ??
                (notice.status == 'registered'
                    ? 'Sin especificar'
                    : 'Por confirmar'),
          ),
          if (notice.reported.institution case final institution?)
            ('Entidad indicada', institution),
          ('Categoría', categories[notice.category] ?? 'Por confirmar'),
          ('Recibido', syncLabel(notice.receivedAt)),
        ]),
      ],
    );
  }
}
