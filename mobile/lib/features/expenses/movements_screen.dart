import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/design.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';
import 'email_movement_screens.dart';
import 'expenses.dart';
import 'finance.dart';
import 'finance_screens.dart';
import 'movement_fields.dart';
import 'notice_style.dart';

class MovementsScreen extends ConsumerWidget {
  const MovementsScreen(this.query, {super.key});
  final Map<String, String> query;

  void _navigate(BuildContext context, Map<String, String?> changes) =>
      context.go(
        financePath('/history', {
          for (final entry in {...query, ...changes}.entries)
            if (entry.value != null) entry.key: entry.value!,
        }),
      );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    const tabs = {
      'all': 'Todos',
      'income': 'Ingresos',
      'expense': 'Gastos',
      'notices': 'Avisos',
    };
    final tab = tabs.containsKey(query['tab']) ? query['tab']! : 'all';
    final notices = tab == 'notices';
    final defaults = currentRange();
    final from = query['from'] ?? defaults.from;
    final to = query['to'] ?? defaults.to;
    final currency = query['currency'] == 'all'
        ? null
        : query['currency'] ?? 'COP';
    final period = (from: from, to: to, currency: currency ?? 'COP');
    final movementFilter = (
      from: from,
      to: to,
      currency: currency,
      category: query['category'],
      source: query['source'],
      direction: tab == 'income' || tab == 'expense' ? tab : null,
    );
    final reports = movementsProvider(movementFilter);
    final noticeList = historyProvider((
      from: from,
      to: to,
      category: null,
      status: query['status'],
    ));
    final report =
        movementFilter.direction != null &&
            currency != null &&
            movementFilter.category == null &&
            movementFilter.source == null
        ? ref.watch(analyticsProvider(period)).asData?.value
        : null;

    return Scaffold(
      appBar: brandBar(),
      bottomNavigationBar: notices
          ? null
          : Padding(
              padding: const EdgeInsets.fromLTRB(20, 6, 20, 8),
              child: FilledButton.icon(
                icon: const Icon(Icons.add_rounded),
                label: const Text('Registrar movimiento'),
                onPressed: () => context.push(
                  financePath('/history/new', {
                    'currency': currency ?? 'COP',
                    'direction': ?movementFilter.direction,
                  }),
                ),
              ),
            ),
      body: RefreshIndicator(
        onRefresh: () async {
          try {
            await (notices
                ? ref.refresh(noticeList.future).then<void>((_) {})
                : ref.refresh(reports.future).then<void>((_) {}));
            if (report != null) ref.invalidate(analyticsProvider(period));
          } catch (_) {
            // El estado del proveedor presenta el error y permite reintentar.
          }
        },
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 10),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const PageHeading('Movimientos', eyebrow: 'HISTORIAL'),
                    const SizedBox(height: 12),
                    SegmentTabs(
                      items: tabs,
                      selected: tab,
                      onSelect: (value) => _navigate(context, {
                        'tab': value,
                        'category': null,
                        'status': null,
                        'source': null,
                      }),
                    ),
                    const SizedBox(height: 6),
                    RangeControls(
                      range: period,
                      showCurrency: false,
                      showDate: false,
                      onChange: (value) => _navigate(context, {
                        'from': value.from,
                        'to': value.to,
                      }),
                      additional: [
                        if (notices)
                          _Filter(
                            'Estado',
                            query['status'],
                            const {
                              'processing': 'En proceso',
                              'pending': 'Pendiente',
                              'error': 'Error',
                            },
                            (value) => _navigate(context, {'status': value}),
                          )
                        else ...[
                          _Filter(
                            'Moneda',
                            currency,
                            currencies,
                            (value) => _navigate(context, {
                              'currency': value ?? 'all',
                            }),
                            emptyLabel: 'Todas',
                          ),
                          if (tab != 'income')
                            _Filter(
                              'Categoría',
                              query['category'],
                              categories,
                              (value) =>
                                  _navigate(context, {'category': value}),
                            ),
                          _Filter(
                            'Origen',
                            query['source'],
                            movementSources,
                            (value) => _navigate(context, {'source': value}),
                          ),
                        ],
                      ],
                    ),
                    if (report != null) ...[
                      const SizedBox(height: 4),
                      _PeriodTotal(
                        report: report,
                        currency: period.currency,
                        income: tab == 'income',
                      ),
                    ],
                  ],
                ),
              ),
            ),
            if (notices)
              ...ref
                  .watch(noticeList)
                  .when(
                    loading: () => [_progress('Cargando avisos')],
                    error: (error, _) => [
                      _retry(error, () => ref.invalidate(noticeList)),
                    ],
                    data: (page) => [
                      _noticeHeader(context, page),
                      _rows(
                        context,
                        page.items.length,
                        page.hasMore,
                        'No hay avisos que coincidan con los filtros.',
                        () => ref.read(noticeList.notifier).loadMore(),
                        (index) {
                          final notice = page.items[index];
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 9),
                            child: _NoticeTile(
                              notice,
                              onTap: () => context.push(
                                financePath('/history/${notice.id}', {
                                  ...query,
                                  'tab': 'notices',
                                }),
                              ),
                            ),
                          );
                        },
                      ),
                      const SliverPadding(
                        padding: EdgeInsets.fromLTRB(20, 4, 20, 20),
                        sliver: SliverToBoxAdapter(
                          child: AppNotice(
                            icon: Icons.info_outline,
                            title: 'Importes por confirmar',
                            description:
                                'Los avisos de esta pestaña se agregan a tus totales cuando se registran.',
                          ),
                        ),
                      ),
                    ],
                  )
            else
              ref
                  .watch(reports)
                  .when(
                    loading: () => _progress('Cargando movimientos'),
                    error: (error, _) =>
                        _retry(error, () => ref.invalidate(reports)),
                    data: (page) {
                      final groups = <List<Movement>>[];
                      for (final item in page.items) {
                        if (groups.isEmpty ||
                            groups.last.first.date != item.date) {
                          groups.add([]);
                        }
                        groups.last.add(item);
                      }
                      return _rows(
                        context,
                        groups.length,
                        page.hasMore,
                        'No hay movimientos que coincidan con los filtros.',
                        () => ref.read(reports.notifier).more(),
                        (index) => _movementGroup(
                          context,
                          groups[index],
                          showCurrency: currency == null,
                        ),
                      );
                    },
                  ),
          ],
        ),
      ),
    );
  }

  Widget _noticeHeader(BuildContext context, HistoryPage page) {
    const labels = {
      'pending': 'pendiente',
      'processing': 'en proceso',
      'error': 'con error',
    };
    final counts = [
      for (final entry in labels.entries)
        if (page.items.where((item) => item.status == entry.key).length
            case final count when count > 0)
          '$count ${entry.value}',
    ];
    return SliverPadding(
      padding: const EdgeInsets.fromLTRB(20, 2, 20, 12),
      sliver: SliverToBoxAdapter(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SectionHeading('Avisos por revisar'),
            if (page.items.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                page.hasMore
                    ? '${page.items.length} avisos mostrados'
                    : counts.join(' · '),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _movementGroup(
    BuildContext context,
    List<Movement> group, {
    required bool showCurrency,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Text(
            shortDay(group.first.date),
            style: Theme.of(context).textTheme.labelMedium,
          ),
        ),
        Card(
          child: Column(
            children: [
              for (final (index, item) in group.indexed) ...[
                if (index > 0)
                  const Divider(height: 1, indent: 10, endIndent: 10),
                MovementRow(
                  item,
                  showCurrency: showCurrency,
                  onTap: () => context.push('/history/movement/${item.id}'),
                ),
              ],
            ],
          ),
        ),
      ],
    ),
  );

  Widget _progress(String label) => SliverPadding(
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
    sliver: SliverToBoxAdapter(
      child: LinearProgressIndicator(
        semanticsLabel: label,
        borderRadius: BorderRadius.circular(5),
        minHeight: 5,
      ),
    ),
  );

  Widget _retry(Object error, VoidCallback retry) =>
      SliverToBoxAdapter(child: RetryMessage(error, retry));

  Widget _rows(
    BuildContext context,
    int count,
    bool more,
    String empty,
    Future<void> Function() next,
    Widget Function(int) row,
  ) => SliverPadding(
    padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
    sliver: count == 0
        ? SliverToBoxAdapter(
            child: AppNotice(icon: Icons.inbox_outlined, title: empty),
          )
        : SliverList.builder(
            itemCount: count + (more ? 1 : 0),
            itemBuilder: (context, index) => index < count
                ? row(index)
                : TextButton(
                    onPressed: () async {
                      try {
                        await next();
                      } catch (error) {
                        if (context.mounted) {
                          showMessage(context, failureMessage(error));
                        }
                      }
                    },
                    child: const Text('Cargar más'),
                  ),
          ),
  );
}

class _Filter extends StatelessWidget {
  const _Filter(
    this.label,
    this.value,
    this.options,
    this.onChange, {
    this.emptyLabel = 'Todos',
  });
  final String label;
  final String? value;
  final Map<String, String> options;
  final String emptyLabel;
  final ValueChanged<String?> onChange;

  @override
  Widget build(BuildContext context) => PopupMenuButton<String>(
    tooltip: label,
    initialValue: value ?? '',
    child: FilterLabel(
      options[value] ?? label,
      highlighted: value != null && label != 'Moneda',
    ),
    onSelected: (value) => onChange(value.isEmpty ? null : value),
    itemBuilder: (_) => [
      PopupMenuItem(value: '', child: Text(emptyLabel)),
      for (final entry in options.entries)
        PopupMenuItem(value: entry.key, child: Text(entry.value)),
    ],
  );
}

class _PeriodTotal extends StatelessWidget {
  const _PeriodTotal({
    required this.report,
    required this.currency,
    required this.income,
  });
  final Analytics report;
  final String currency;
  final bool income;

  @override
  Widget build(BuildContext context) {
    final tone = income ? AppTone.income : AppTone.expense;
    final amount = income ? report.income : report.expense;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: tone.tint,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        children: [
          IconTile(
            income ? Icons.south_west_rounded : Icons.north_east_rounded,
            tone: tone,
            size: 36,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  income ? 'Ingresos del periodo' : 'Gastos del periodo',
                  style: Theme.of(
                    context,
                  ).textTheme.labelMedium?.copyWith(color: tone.ink),
                ),
                const SizedBox(height: 3),
                Text(
                  '$currency ${displayMoney(amount, currency, symbol: false)}',
                  semanticsLabel: money(amount, currency),
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    color: tone.ink,
                    fontFeatures: tabularFigures,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _NoticeTile extends StatelessWidget {
  const _NoticeTile(this.notice, {required this.onTap});
  final Notice notice;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final title = Text(
      notice.provider == 'other'
          ? notice.providerLabel
          : 'Aviso de ${notice.providerLabel}',
      style: text.titleMedium,
    );
    final badge = StatusBadge(notice.status);
    final summary =
        '${receivedDay(notice.receivedAt)} · ${noticePreview(notice)}';
    return Card(
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Row(
            children: [
              IconTile(
                noticeIcon(notice.status),
                tone: noticeTone(notice.status),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: LayoutBuilder(
                  builder: (context, constraints) {
                    final stacked =
                        constraints.maxWidth < 188 ||
                        MediaQuery.textScalerOf(context).scale(14) > 18;
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (stacked) ...[
                          title,
                          const SizedBox(height: 4),
                          badge,
                        ] else
                          TrailingRow(leading: title, trailing: badge),
                        const SizedBox(height: 3),
                        Text(
                          summary,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: text.bodySmall,
                        ),
                      ],
                    );
                  },
                ),
              ),
              const SizedBox(width: 3),
              const Icon(
                Icons.chevron_right_rounded,
                size: 17,
                color: AppColors.muted,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

enum MovementView { detail, edit, correction, corrections }

class MovementScreen extends ConsumerWidget {
  const MovementScreen(this.id, {super.key, this.view = MovementView.detail});
  final String id;
  final MovementView view;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = movementProvider(id);
    return ref
        .watch(provider)
        .when(
          skipError: view == MovementView.correction,
          loading: () => Scaffold(
            appBar: AppBar(title: const Text('Detalle')),
            body: const Center(child: CircularProgressIndicator()),
          ),
          error: (error, _) => Scaffold(
            appBar: AppBar(title: const Text('Detalle')),
            body: RetryMessage(error, () => ref.invalidate(provider)),
          ),
          data: (item) {
            if (item.manual && view == MovementView.edit) {
              return MovementForm(existing: item);
            }
            final details = item.emailDetails;
            if (details == null) return _MovementDetail(item);
            return switch (view) {
              MovementView.detail => _MovementDetail(item),
              MovementView.edit => EmailMovementDetailsForm(item, details),
              MovementView.correction => EmailMovementCorrectionForm(
                item,
                details,
                key: ValueKey((item.id, details.revision)),
              ),
              MovementView.corrections => EmailCorrectionHistoryScreen(item),
            };
          },
        );
  }
}

class _MovementDetail extends ConsumerStatefulWidget {
  const _MovementDetail(this.item);
  final Movement item;

  @override
  ConsumerState<_MovementDetail> createState() => _MovementDetailState();
}

class _MovementDetailState extends ConsumerState<_MovementDetail> {
  bool _busy = false;

  Future<void> _remove(Movement item) async {
    if (_busy) return;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Eliminar movimiento manual'),
        content: Text(
          '«${item.title}» se eliminará del historial y se recalcularán los totales.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Eliminar'),
          ),
        ],
      ),
    );
    if (accepted != true || !mounted || _busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(financeRepositoryProvider).remove(item.id);
      if (!mounted) return;
      if (item.id == widget.item.id) context.pop();
      refreshFinance(ref);
    } catch (error) {
      if (mounted) showMessage(context, failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final details = item.emailDetails;
    final timeOnOriginalDate =
        details != null &&
        details.originalDate != item.date &&
        details.originalDate == item.reported.date;
    final tone = item.income ? AppTone.income : AppTone.expense;
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: appBackBar('Movimientos', () => context.pop()),
      body: ListView(
        padding: screenPadding,
        children: [
          const PageHeading('Detalle del movimiento', eyebrow: 'HISTORIAL'),
          const SizedBox(height: 14),
          Container(
            decoration: BoxDecoration(
              color: tone.tint,
              borderRadius: BorderRadius.circular(18),
            ),
            padding: const EdgeInsets.all(15),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SeriesCaption(
                  item.kind,
                  item.income
                      ? Icons.south_west_rounded
                      : Icons.north_east_rounded,
                  tone,
                ),
                const SizedBox(height: 6),
                Text(
                  item.title,
                  style: text.titleLarge?.copyWith(color: tone.ink),
                ),
                const SizedBox(height: 3),
                Text(
                  item.signedAmount,
                  style: text.headlineSmall?.copyWith(
                    color: tone.ink,
                    fontFeatures: tabularFigures,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          DetailFields([
            ('Fecha', item.reported.dateLabel(item.date)),
            ?(timeOnOriginalDate
                ? null
                : item.reported.separateTime(item.date)),
            ('Categoría', categories[item.category] ?? item.category),
            (
              'Medio de pago',
              item.reported.paymentLabel(item.method) ?? 'Sin especificar',
            ),
            if (item.reported.institution case final institution?)
              ('Entidad indicada', institution),
            ('Origen', movementSources[item.source] ?? item.source),
            if (details?.note case final note?) ('Nota', note),
            if (details != null && details.revision > 0) ...[
              ('Monto original', money(details.originalMinor, item.currency)),
              (
                'Fecha original',
                timeOnOriginalDate
                    ? item.reported.dateLabel(details.originalDate)
                    : shortDay(details.originalDate),
              ),
            ],
          ]),
          if (item.manual) ...[
            const SizedBox(height: 12),
            FormPair(
              first: OutlinedButton.icon(
                onPressed: _busy
                    ? null
                    : () => context.push('/history/movement/${item.id}/edit'),
                icon: const Icon(Icons.edit_outlined),
                label: const Text('Editar'),
              ),
              second: FilledButton.icon(
                onPressed: _busy ? null : () => _remove(item),
                style: dangerButtonStyle(),
                icon: const Icon(Icons.delete_outline),
                label: const Text('Eliminar'),
              ),
            ),
          ],
          if (details != null) ...[
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () =>
                  context.push('/history/movement/${item.id}/edit'),
              icon: const Icon(Icons.edit_outlined),
              label: Text(emailDetailsLabel(item)),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: () =>
                  context.push('/history/movement/${item.id}/correction'),
              icon: const Icon(Icons.tune_rounded),
              label: const Text('Corregir datos'),
            ),
            if (details.revision > 0) ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () =>
                    context.push('/history/movement/${item.id}/corrections'),
                icon: const Icon(Icons.history_rounded),
                label: const Text('Historial de correcciones'),
              ),
            ],
          ],
          if (item.matches.isNotEmpty) ...[
            const SizedBox(height: 18),
            const AppNotice(
              icon: Icons.copy_all_outlined,
              title: 'Posible duplicado',
              description:
                  'Compara los registros. Si corresponden al mismo movimiento, puedes eliminar el manual.',
            ),
            const SizedBox(height: 9),
            Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _MatchRow(item),
                  for (final match in item.matches) ...[
                    const Divider(height: 1, indent: 12, endIndent: 12),
                    _MatchRow(
                      match,
                      onTap: () =>
                          context.push('/history/movement/${match.id}'),
                    ),
                    if (match.manual)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
                        child: FilledButton(
                          onPressed: _busy ? null : () => _remove(match),
                          style: dangerButtonStyle(),
                          child: const Text('Eliminar manual'),
                        ),
                      ),
                  ],
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class SeriesCaption extends StatelessWidget {
  const SeriesCaption(this.label, this.icon, this.tone, {super.key});
  final String label;
  final IconData icon;
  final AppTone tone;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Icon(icon, color: tone.ink, size: 17),
      const SizedBox(width: 6),
      Expanded(
        child: Text(
          label,
          style: Theme.of(
            context,
          ).textTheme.labelMedium?.copyWith(color: tone.ink),
        ),
      ),
    ],
  );
}

class _MatchRow extends StatelessWidget {
  const _MatchRow(this.item, {this.onTap});
  final Movement item;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final tone = item.income ? AppTone.income : AppTone.expense;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                AppBadge(
                  movementSources[item.source] ?? item.source,
                  tone: item.manual ? AppTone.info : AppTone.neutral,
                ),
                Text(item.title, style: text.titleMedium),
              ],
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                Expanded(
                  child: Text(shortDay(item.date), style: text.bodySmall),
                ),
                Flexible(
                  child: Text(
                    item.signedAmount,
                    textAlign: TextAlign.end,
                    style: text.labelMedium?.copyWith(
                      color: tone.ink,
                      fontFeatures: tabularFigures,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class MovementForm extends ConsumerStatefulWidget {
  const MovementForm({
    super.key,
    this.existing,
    this.notice,
    this.direction,
    this.currency,
  }) : assert(existing == null || notice == null);
  final Movement? existing;
  final Notice? notice;
  final String? direction, currency;

  @override
  ConsumerState<MovementForm> createState() => _MovementFormState();
}

class _MovementFormState extends ConsumerState<MovementForm> {
  final _form = GlobalKey<FormState>();
  late final _id = requestId();
  final _amount = TextEditingController();
  final _method = TextEditingController();
  final _description = TextEditingController();
  String? _currency, _direction, _category, _date;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    final notice = widget.notice;
    final minor = existing?.minor ?? notice?.minor;
    if (minor != null) _amount.text = money(minor, '').trim();
    _method.text = existing?.method ?? notice?.suggestedPaymentMethod ?? '';
    _description.text = existing?.description ?? notice?.description ?? '';
    if (notice != null) {
      _currency = currencies.containsKey(notice.currency)
          ? notice.currency
          : null;
      _direction = notice.direction;
      _category = notice.category == 'ingresos' ? null : notice.category;
      _date = notice.suggestedDate;
    } else {
      _currency =
          existing?.currency ??
          (currencies.containsKey(widget.currency) ? widget.currency! : 'COP');
      _direction = existing == null
          ? widget.direction
          : (existing.income ? 'income' : 'expense');
      _category = existing?.income == false ? existing?.category : null;
      _date = existing?.date ?? isoDay(bogotaNow());
    }
  }

  @override
  void dispose() {
    _amount.dispose();
    _method.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy || !_form.currentState!.validate()) return;
    final direction = _direction;
    final date = _date;
    if (direction == null || date == null) {
      setState(
        () => _error = direction == null
            ? 'Elige si es un ingreso o un gasto.'
            : 'Selecciona la fecha del movimiento.',
      );
      return;
    }
    final currency = _currency!;
    setState(() {
      _busy = true;
      _error = null;
    });
    final existing = widget.existing;
    final notice = widget.notice;
    final data = <String, dynamic>{
      'amountMinor': parseMinor(_amount.text)!.toString(),
      'currency': currency,
      'direction': direction,
      'date': date,
      if (direction == 'expense') 'category': _category,
      if (_method.text.trim().isNotEmpty) 'paymentMethod': _method.text.trim(),
      if (_description.text.trim().isNotEmpty)
        'description': _description.text.trim(),
    };
    try {
      if (notice != null) {
        final id = await ref
            .read(expenseRepositoryProvider)
            .confirm(notice.id, data);
        if (!mounted) return;
        refreshNotices(ref, notice.id);
        refreshFinance(ref);
        context.go(_noticePath('/history/movement/$id'));
        return;
      }
      final repository = ref.read(financeRepositoryProvider);
      if (existing == null) {
        await repository.create(data, _id);
      } else {
        await repository.edit(existing.id, data);
      }
      if (!mounted) return;
      if (existing == null) {
        context.go(
          financePath('/history', {
            'tab': direction,
            'currency': currency,
            'from': date,
            'to': date,
          }),
        );
      } else {
        context.pop();
      }
      refreshFinance(ref);
    } catch (error) {
      if (!mounted) return;
      if (notice != null &&
          error is ApiFailure &&
          (error.status == 404 || error.status == 409)) {
        refreshNotices(ref, notice.id);
        refreshFinance(ref);
        showMessage(context, failureMessage(error));
        context.go(_noticePath('/history'));
      } else {
        setState(() => _error = failureMessage(error));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _noticePath(String path) => financePath(path, {
    ...GoRouterState.of(context).uri.queryParameters,
    'tab': 'notices',
  });

  String get _saveLabel {
    if (_busy) return 'Guardando…';
    if (widget.notice != null) return 'Confirmar y registrar';
    if (widget.existing != null) return 'Guardar cambios';
    return switch (_direction) {
      'income' => 'Guardar ingreso',
      'expense' => 'Guardar gasto',
      _ => 'Guardar movimiento',
    };
  }

  @override
  Widget build(BuildContext context) {
    final notice = widget.notice != null;
    final editing = widget.existing != null;
    final method = LabeledField(
      'Medio de pago',
      child: TextFormField(
        controller: _method,
        enabled: !_busy,
        maxLength: 60,
        textInputAction: TextInputAction.next,
        decoration: const InputDecoration(
          hintText: 'Opcional',
          counterText: '',
        ),
      ),
    );
    return Scaffold(
      appBar: appBackBar(
        notice ? 'Detalle del aviso' : 'Movimientos',
        () => context.pop(),
      ),
      body: FormLayout(
        child: Form(
          key: _form,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              PageHeading(
                notice
                    ? 'Confirmar movimiento'
                    : editing
                    ? 'Editar movimiento'
                    : 'Registrar movimiento',
                eyebrow: notice ? 'REVISIÓN DE AVISO' : 'CAPTURA MANUAL',
                description: notice
                    ? 'Revisa el correo original y completa los datos del movimiento.'
                    : editing
                    ? 'Actualiza los datos de este registro.'
                    : 'Agrega un ingreso o un gasto a tu historial.',
              ),
              const SizedBox(height: 12),
              LabeledField(
                'Tipo de movimiento',
                child: SegmentTabs<String>(
                  items: const {'income': 'Ingreso', 'expense': 'Gasto'},
                  selected: _direction,
                  onSelect: _busy
                      ? null
                      : (value) => setState(() {
                          _direction = value;
                          _error = null;
                        }),
                ),
              ),
              const SizedBox(height: 16),
              FormPair(
                firstFlex: 2,
                first: LabeledField(
                  'Monto',
                  child: TextFormField(
                    key: const ValueKey('movement-amount'),
                    controller: _amount,
                    enabled: !_busy,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    decoration: const InputDecoration(hintText: '42.000,00'),
                    validator: (value) => parseMinor(value ?? '') == null
                        ? 'Ingresa un monto positivo válido.'
                        : null,
                  ),
                ),
                second: LabeledField(
                  'Moneda',
                  child: DropdownButtonFormField<String>(
                    key: const ValueKey('movement-currency'),
                    initialValue: _currency,
                    decoration: const InputDecoration(),
                    isExpanded: true,
                    icon: const Icon(
                      Icons.keyboard_arrow_down_rounded,
                      size: 18,
                      color: AppColors.muted,
                    ),
                    hint: const Text('Elige'),
                    items: [
                      for (final code in currencies.keys)
                        DropdownMenuItem(value: code, child: Text(code)),
                    ],
                    onChanged: _busy
                        ? null
                        : (value) => setState(() => _currency = value!),
                    validator: (value) =>
                        value == null ? 'Selecciona la moneda.' : null,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              MovementDateField(
                date: _date,
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _date = value),
              ),
              const SizedBox(height: 12),
              if (_direction == 'expense')
                FormPair(
                  first: ExpenseCategoryField(
                    category: _category,
                    onChanged: _busy
                        ? null
                        : (value) => setState(() => _category = value),
                  ),
                  second: method,
                )
              else
                method,
              const SizedBox(height: 12),
              LabeledField(
                'Descripción opcional',
                child: TextFormField(
                  key: const ValueKey('movement-description'),
                  controller: _description,
                  enabled: !_busy,
                  maxLength: 200,
                  decoration: const InputDecoration(
                    hintText: 'Escribe una descripción',
                    counterText: '',
                  ),
                ),
              ),
              const SizedBox(height: 18),
              AppNotice(
                icon: notice ? Icons.mail_outline : Icons.edit_note_rounded,
                title: notice ? 'Origen correo' : 'Origen manual',
                description:
                    'Tu movimiento aparecerá en el historial y en los totales del periodo.',
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
                label: Text(_saveLabel),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
