import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/design.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';
import '../auth/auth.dart';
import '../mailboxes/mailboxes.dart';
import 'expenses.dart';
import 'finance.dart';
import 'finance_chart.dart';
import 'notice_style.dart';

enum _AnalysisView { chart, breakdowns, table }

class FinanceScreen extends ConsumerStatefulWidget {
  const FinanceScreen({super.key, this.home = false, this.initial});
  final bool home;
  final FinanceRange? initial;

  @override
  ConsumerState<FinanceScreen> createState() => _FinanceScreenState();
}

class _FinanceScreenState extends ConsumerState<FinanceScreen> {
  final _periodMenu = GlobalKey<PopupMenuButtonState<String>>();
  late FinanceRange _range = widget.initial ?? currentRange();
  Bucket? _selected;
  var _view = _AnalysisView.chart;

  void _setRange(FinanceRange value) => setState(() {
    _range = value;
    _selected = null;
  });

  void _open(_AnalysisView view) => setState(() => _view = view);

  void _movements([Map<String, String> filter = const {}]) =>
      context.go(financePath('/history', {...rangeQuery(_range), ...filter}));

  String get _newPath =>
      financePath('/history/new', {'currency': _range.currency});

  @override
  Widget build(BuildContext context) {
    final provider = analyticsProvider(_range);
    final data = ref.watch(provider);
    final name = ref
        .watch(authProvider)
        .asData
        ?.value
        ?.name
        .trim()
        .split(RegExp(r'\s+'))
        .firstOrNull;
    final overview = _view == _AnalysisView.chart;
    final isTable = _view == _AnalysisView.table;
    return PopScope(
      canPop: overview,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && !overview) _open(_AnalysisView.chart);
      },
      child: Scaffold(
        appBar: overview
            ? brandBar()
            : appBackBar('Análisis', () => _open(_AnalysisView.chart)),
        bottomNavigationBar: widget.home
            ? Padding(
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 8),
                child: _registerButton(),
              )
            : null,
        body: RefreshIndicator(
          onRefresh: () => ref
              .refresh(provider.future)
              .then<void>((_) {}, onError: (Object _) {}),
          child: ListView(
            key: PageStorageKey(widget.home ? 'home' : _view),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: screenPadding,
            children: [
              PageHeading(
                widget.home
                    ? (name == null || name.isEmpty ? 'Inicio' : 'Hola, $name')
                    : switch (_view) {
                        _AnalysisView.chart => 'Análisis',
                        _AnalysisView.breakdowns => 'Desgloses',
                        _AnalysisView.table => 'Tabla de datos',
                      },
                eyebrow: widget.home
                    ? 'RESUMEN'
                    : isTable
                    ? null
                    : _view == _AnalysisView.breakdowns
                    ? 'ANÁLISIS'
                    : 'EVOLUCIÓN',
                description: widget.home
                    ? 'Tus movimientos del periodo.'
                    : switch (_view) {
                        _AnalysisView.chart =>
                          'Compara los movimientos del periodo.',
                        _AnalysisView.breakdowns =>
                          '${periodLabel(_range.from, _range.to)} · ${_range.currency}',
                        _AnalysisView.table => comparisonLabel(_range),
                      },
              ),
              SizedBox(height: widget.home ? 5 : 8),
              if (overview) ...[
                RangeControls(
                  menuKey: _periodMenu,
                  range: _range,
                  onChange: _setRange,
                ),
                SizedBox(height: widget.home ? 4 : 8),
              ] else if (isTable) ...[
                Align(
                  alignment: Alignment.centerLeft,
                  child: AppBadge(_range.currency, icon: Icons.toll_outlined),
                ),
                const SizedBox(height: 12),
              ],
              data.when(
                loading: () => _LoadingPanel(home: widget.home),
                error: (error, _) => AppPanel(
                  child: RetryMessage(error, () => ref.invalidate(provider)),
                ),
                data: (report) => _report(report),
              ),
              if (widget.home) const _HomeConnections(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _registerButton() => FilledButton.icon(
    onPressed: () => context.push(_newPath),
    icon: const Icon(Icons.add_rounded),
    label: const Text('Registrar movimiento'),
  );

  Widget _report(Analytics report) {
    final bucket = report.series
        .where((item) => item.from == _selected?.from)
        .firstOrNull;
    if (_view == _AnalysisView.table) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FinanceDataTable(
            report: report,
            range: _range,
            selected: bucket,
            select: (value) => setState(() => _selected = value),
          ),
          const SizedBox(height: 14),
          OutlinedButton.icon(
            onPressed: () => _open(_AnalysisView.chart),
            icon: const Icon(Icons.bar_chart_rounded),
            label: const Text('Volver a la gráfica'),
          ),
          if (bucket != null) _bucketLink(bucket),
        ],
      );
    }
    if (_view == _AnalysisView.breakdowns) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          BreakdownCard(
            title: 'Gastos por categoría',
            rows: report.expenseCategories,
            labels: categories,
            currency: _range.currency,
            total: report.expense,
            tone: AppTone.expense,
            onTap: (key) => _movements({'tab': 'expense', 'category': key}),
          ),
          const SizedBox(height: 12),
          BreakdownCard(
            title: 'Ingresos por origen de registro',
            rows: report.incomeSources,
            labels: movementSources,
            currency: _range.currency,
            total: report.income,
            tone: AppTone.income,
            onTap: (key) => _movements({'tab': 'income', 'source': key}),
          ),
          const SizedBox(height: 12),
          const AppNotice(
            icon: Icons.filter_list_rounded,
            title: 'Detalle por categoría u origen',
            description: 'Toca una barra para consultar sus movimientos.',
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.home) ...[
          _Totals(report: report, currency: _range.currency),
          const SizedBox(height: 10),
        ],
        if (report.empty)
          _emptyPanel()
        else ...[
          _chartCard(report, bucket),
          if (!widget.home) ...[
            if (bucket != null) ...[
              const SizedBox(height: 10),
              _selection(bucket),
            ],
            const SizedBox(height: 10),
            _breakdownLink(report),
          ],
        ],
        if (widget.home) _HomeActivity(range: _range, onAll: _movements),
      ],
    );
  }

  Widget _emptyPanel() => AppPanel(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const IconTile(Icons.bar_chart_rounded),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Aún no hay movimientos en este periodo',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 3),
                  Text(
                    '${periodLabel(_range.from, _range.to)} · ${_range.currency}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (widget.home)
          OutlinedButton(
            onPressed: () => _periodMenu.currentState?.showButtonMenu(),
            child: const Text('Cambiar periodo'),
          )
        else
          FormPair(
            first: _registerButton(),
            second: OutlinedButton(
              onPressed: () => _periodMenu.currentState?.showButtonMenu(),
              child: const Text('Cambiar periodo'),
            ),
          ),
      ],
    ),
  );

  Widget _chartCard(Analytics report, Bucket? bucket) {
    final text = Theme.of(context).textTheme;
    return AppPanel(
      padding: EdgeInsets.fromLTRB(
        14,
        widget.home ? 2 : 7,
        14,
        widget.home ? 6 : 12,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SectionHeading(
            'Ingresos vs. gastos',
            compact: widget.home,
            action: _inlineAction(
              widget.home ? 'Ver análisis' : 'Ver tabla',
              widget.home ? _openAnalysis : () => _open(_AnalysisView.table),
            ),
          ),
          Row(
            children: [
              const Expanded(
                child: Wrap(
                  spacing: 12,
                  runSpacing: 4,
                  children: [
                    SeriesLegend('Ingresos', AppTone.income),
                    SeriesLegend('Gastos', AppTone.expense),
                  ],
                ),
              ),
              if (!widget.home) Text(_range.currency, style: text.labelSmall),
            ],
          ),
          const SizedBox(height: 5),
          FinanceChart(
            report: report,
            range: _range,
            compact: widget.home,
            selected: bucket,
            select: widget.home
                ? (_) => _openAnalysis()
                : (value) => setState(() => _selected = value),
          ),
        ],
      ),
    );
  }

  void _openAnalysis() =>
      context.go(financePath('/analysis', rangeQuery(_range)));

  Widget _breakdownLink(Analytics report) {
    final labels = report.expenseCategories
        .map((row) => categories[row.key] ?? row.key)
        .join(' · ');
    final text = Theme.of(context).textTheme;
    return AppPanel(
      padding: const EdgeInsets.fromLTRB(14, 3, 14, 9),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SectionHeading(
            'Gastos por categoría',
            compact: true,
            action: _inlineAction(
              'Ver desgloses',
              () => _open(_AnalysisView.breakdowns),
            ),
          ),
          Text(
            labels.isEmpty
                ? 'Consulta los gastos e ingresos del periodo.'
                : labels,
            style: text.bodySmall,
          ),
        ],
      ),
    );
  }

  Widget _bucketLink(Bucket bucket) => OutlinedButton.icon(
    onPressed: () => _movements({'from': bucket.from, 'to': bucket.to}),
    icon: const Icon(Icons.arrow_forward_rounded),
    label: const Text('Ver movimientos'),
  );

  Widget _selection(Bucket bucket) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: AppColors.blueTint,
      borderRadius: BorderRadius.circular(17),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          bucket.from == bucket.to
              ? DateFormat(
                  "d 'de' MMMM",
                  'es_CO',
                ).format(DateTime.parse(bucket.from))
              : periodLabel(bucket.from, bucket.to),
          style: Theme.of(
            context,
          ).textTheme.titleMedium?.copyWith(color: AppColors.accent),
        ),
        const SizedBox(height: 8),
        FormPair(
          first: _SelectedAmount(
            'Ingresos',
            bucket.income,
            _range.currency,
            AppTone.income,
          ),
          second: _SelectedAmount(
            'Gastos',
            bucket.expense,
            _range.currency,
            AppTone.expense,
          ),
        ),
        const SizedBox(height: 10),
        _bucketLink(bucket),
      ],
    ),
  );
}

Widget _inlineAction(String label, VoidCallback onPressed) => Align(
  alignment: Alignment.centerRight,
  widthFactor: 1,
  child: TextButton(
    onPressed: onPressed,
    style: TextButton.styleFrom(
      padding: const EdgeInsets.only(left: 8),
      minimumSize: const Size(0, 32),
      textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    ),
    child: Text(label, textAlign: TextAlign.end),
  ),
);

class RangeControls extends StatelessWidget {
  const RangeControls({
    super.key,
    required this.range,
    required this.onChange,
    this.showCurrency = true,
    this.showDate = true,
    this.additional = const [],
    this.menuKey,
  });
  final FinanceRange range;
  final ValueChanged<FinanceRange> onChange;
  final bool showCurrency, showDate;
  final List<Widget> additional;
  final GlobalKey<PopupMenuButtonState<String>>? menuKey;

  @override
  Widget build(BuildContext context) {
    final now = bogotaNow();
    final options = {
      'Este mes': dateFilter(monthRange(now)),
      'Mes anterior': dateFilter(monthRange(now, previous: true)),
      'Últimos seis meses': (
        from: isoDay(DateTime(now.year, now.month - 5)),
        to: isoDay(now),
      ),
    };
    final selected = options.entries
        .where((e) => e.value.from == range.from && e.value.to == range.to)
        .firstOrNull;
    final filters = Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 5,
      children: [
        PopupMenuButton<String>(
          key: menuKey,
          tooltip: 'Cambiar periodo',
          child: FilterLabel(
            key: const ValueKey('home-period'),
            selected?.key ?? 'Personalizado',
            icon: additional.isEmpty ? Icons.calendar_month_outlined : null,
            highlighted: true,
          ),
          itemBuilder: (_) => [
            for (final key in options.keys)
              PopupMenuItem(value: key, child: Text(key)),
            const PopupMenuItem(
              value: 'custom',
              child: Text('Rango personalizado'),
            ),
          ],
          onSelected: (value) async {
            var dates = options[value];
            if (dates == null) {
              final custom = await pickDates(
                context,
                initial: DateTimeRange(
                  start: DateTime.parse(range.from),
                  end: DateTime.parse(range.to),
                ),
              );
              if (custom == null || !context.mounted) return;
              dates = dateFilter(custom);
            }
            onChange((
              from: dates.from,
              to: dates.to,
              currency: range.currency,
            ));
          },
        ),
        if (showCurrency)
          PopupMenuButton<String>(
            tooltip: 'Moneda',
            initialValue: range.currency,
            child: FilterLabel(range.currency),
            itemBuilder: (_) => [
              for (final currency in currencies.keys)
                PopupMenuItem(value: currency, child: Text(currency)),
            ],
            onSelected: (value) =>
                onChange((from: range.from, to: range.to, currency: value)),
          ),
        ...additional,
      ],
    );
    if (!showDate) return filters;
    final dates = Text(
      periodLabel(range.from, range.to),
      textAlign: TextAlign.end,
      style: Theme.of(context).textTheme.labelSmall,
    );
    return Row(
      children: [
        Expanded(flex: 7, child: filters),
        const SizedBox(width: 6),
        Flexible(
          flex: 4,
          child: Align(alignment: Alignment.centerRight, child: dates),
        ),
      ],
    );
  }
}

class _HomeConnections extends ConsumerStatefulWidget {
  const _HomeConnections();

  @override
  ConsumerState<_HomeConnections> createState() => _HomeConnectionsState();
}

class _HomeConnectionsState extends ConsumerState<_HomeConnections> {
  bool _dismissed = false;

  @override
  Widget build(BuildContext context) {
    final mailboxes = ref.watch(mailboxesProvider).asData?.value;
    if (_dismissed ||
        mailboxes == null ||
        mailboxes.any((item) => item.state == 'active')) {
      return const SizedBox.shrink();
    }
    final reconnect = mailboxes.any((item) => item.state == 'reconnect');
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: AppPanel(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AppNotice(
              icon: Icons.mark_email_unread_outlined,
              title: reconnect
                  ? 'Revisa tus buzones'
                  : 'Importa tus avisos bancarios',
              description: reconnect
                  ? 'Reconecta tu buzón para seguir recibiendo avisos.'
                  : 'Vincula el Gmail donde recibes avisos o empieza con el registro manual.',
              tone: reconnect ? AppTone.warning : AppTone.info,
            ),
            const SizedBox(height: 10),
            FormPair(
              first: FilledButton.icon(
                onPressed: () => context.go('/settings/mailboxes'),
                icon: Icon(
                  reconnect ? Icons.refresh_rounded : Icons.add_rounded,
                ),
                label: Text(reconnect ? 'Ver buzones' : 'Vincular Gmail'),
              ),
              second: OutlinedButton(
                onPressed: () => setState(() => _dismissed = true),
                child: const Text('Más tarde'),
              ),
              firstFlex: 3,
              secondFlex: 2,
            ),
          ],
        ),
      ),
    );
  }
}

class _HomeActivity extends ConsumerWidget {
  const _HomeActivity({required this.range, required this.onAll});
  final FinanceRange range;
  final void Function([Map<String, String>]) onAll;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pending = ref
        .watch(
          historyProvider((
            from: range.from,
            to: range.to,
            category: null,
            status: 'pending',
          )),
        )
        .asData
        ?.value;
    final recent =
        ref
            .watch(
              movementsProvider((
                from: range.from,
                to: range.to,
                currency: range.currency,
                category: null,
                source: null,
                direction: null,
              )),
            )
            .asData
            ?.value
            .items ??
        const [];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (pending != null && pending.items.isNotEmpty) ...[
          const SizedBox(height: 10),
          AppNotice(
            icon: Icons.mark_email_unread_outlined,
            compact: true,
            tone: AppTone.warning,
            title: pending.hasMore
                ? 'Avisos pendientes'
                : pending.items.length == 1
                ? '1 aviso pendiente'
                : '${pending.items.length} avisos pendientes',
            description:
                '${pending.items.first.providerLabel} · ${noticePreview(pending.items.first)}',
            onTap: () => onAll({'tab': 'notices', 'status': 'pending'}),
          ),
        ],
        if (recent.isNotEmpty) ...[
          const SizedBox(height: 4),
          SectionHeading(
            'Movimientos recientes',
            action: _inlineAction('Ver todos', () => onAll()),
          ),
          for (final item in recent.take(3))
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Card(
                child: MovementRow(
                  item,
                  onTap: () => context.push('/history/movement/${item.id}'),
                ),
              ),
            ),
        ],
      ],
    );
  }
}

class MovementRow extends StatelessWidget {
  const MovementRow(
    this.item, {
    super.key,
    this.onTap,
    this.showCurrency = false,
  });
  final Movement item;
  final VoidCallback? onTap;
  final bool showCurrency;

  @override
  Widget build(BuildContext context) {
    final tone = item.income ? AppTone.income : AppTone.expense;
    final text = Theme.of(context).textTheme;
    final amount = showCurrency
        ? '${item.currency} ${displayMoney(item.minor, item.currency, symbol: false)}'
        : displayMoney(item.minor, item.currency);
    final label = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          item.title,
          style: text.titleMedium,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 2),
        Text(
          '${categories[item.category] ?? item.category} · ${movementSources[item.source] ?? item.source}',
          style: text.bodySmall,
        ),
      ],
    );
    final value = Text(
      '${item.income ? '+' : '−'} $amount',
      semanticsLabel: '${item.kind}, ${item.signedAmount}',
      textAlign: TextAlign.end,
      style: text.titleMedium?.copyWith(
        color: tone.ink,
        fontFeatures: tabularFigures,
      ),
    );
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Row(
          children: [
            IconTile(
              item.income ? Icons.south_west_rounded : Icons.north_east_rounded,
              tone: tone,
              size: 36,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final stacked =
                      constraints.maxWidth < 210 ||
                      MediaQuery.textScalerOf(context).scale(14) > 18;
                  final amounts = Column(
                    crossAxisAlignment: stacked
                        ? CrossAxisAlignment.start
                        : CrossAxisAlignment.end,
                    children: [
                      value,
                      if (item.method case final method?
                          when method.trim().isNotEmpty)
                        Text(
                          method,
                          style: text.bodySmall,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  );
                  return stacked
                      ? Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [label, const SizedBox(height: 4), amounts],
                        )
                      : TrailingRow(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          leading: label,
                          trailing: amounts,
                        );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Totals extends StatelessWidget {
  const _Totals({required this.report, required this.currency});
  final Analytics report;
  final String currency;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      FormPair(
        first: _total(
          context,
          'Ingresos',
          report.income,
          AppTone.income,
          Icons.south_west_rounded,
        ),
        second: _total(
          context,
          'Gastos',
          report.expense,
          AppTone.expense,
          Icons.north_east_rounded,
        ),
      ),
      const SizedBox(height: 9),
      Container(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
        decoration: BoxDecoration(
          color: AppColors.ink,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Balance del periodo',
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(color: AppColors.blueTint),
            ),
            const SizedBox(height: 2),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Text(
                    '${report.balance > BigInt.zero ? '+ ' : ''}${displayMoney(report.balance, currency)}',
                    semanticsLabel: money(report.balance, currency),
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      color: AppColors.surface,
                      fontFeatures: tabularFigures,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  currency,
                  style: Theme.of(
                    context,
                  ).textTheme.labelSmall?.copyWith(color: AppColors.blueTint),
                ),
              ],
            ),
          ],
        ),
      ),
    ],
  );

  Widget _total(
    BuildContext context,
    String label,
    BigInt value,
    AppTone tone,
    IconData icon,
  ) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(11),
    decoration: BoxDecoration(
      color: tone.tint,
      borderRadius: BorderRadius.circular(18),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SeriesLegend(label, tone, icon: icon),
        const SizedBox(height: 6),
        Text(
          displayMoney(value, currency),
          semanticsLabel: money(value, currency),
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
            color: tone.ink,
            fontFeatures: tabularFigures,
          ),
        ),
        Text(
          currency,
          style: Theme.of(
            context,
          ).textTheme.labelSmall?.copyWith(color: tone.ink),
        ),
      ],
    ),
  );
}

class _SelectedAmount extends StatelessWidget {
  const _SelectedAmount(this.label, this.amount, this.currency, this.tone);
  final String label, currency;
  final BigInt amount;
  final AppTone tone;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        label,
        style: Theme.of(
          context,
        ).textTheme.labelMedium?.copyWith(color: tone.ink),
      ),
      Text(
        displayMoney(amount, currency),
        semanticsLabel: money(amount, currency),
        style: Theme.of(context).textTheme.titleLarge?.copyWith(
          color: tone.ink,
          fontFeatures: tabularFigures,
        ),
      ),
    ],
  );
}

class _LoadingPanel extends StatelessWidget {
  const _LoadingPanel({required this.home});
  final bool home;

  @override
  Widget build(BuildContext context) => AppPanel(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Cargando tus movimientos…',
          style: Theme.of(
            context,
          ).textTheme.titleMedium?.copyWith(color: AppColors.accent),
        ),
        const SizedBox(height: 10),
        if (home) ...[
          FormPair(
            first: _block(AppColors.incomeTint, 48),
            second: _block(AppColors.expenseTint, 48),
          ),
          const SizedBox(height: 12),
        ],
        const LinearProgressIndicator(
          semanticsLabel: 'Cargando movimientos',
          minHeight: 5,
          borderRadius: BorderRadius.all(Radius.circular(4)),
        ),
        const SizedBox(height: 8),
        FractionallySizedBox(
          alignment: Alignment.centerLeft,
          widthFactor: .65,
          child: _block(AppColors.neutralTint, 6),
        ),
      ],
    ),
  );

  Widget _block(Color color, double height) => Container(
    height: height,
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(8),
    ),
  );
}
