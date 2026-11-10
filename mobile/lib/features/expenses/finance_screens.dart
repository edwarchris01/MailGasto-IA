import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../core/widgets.dart';
import '../auth/auth.dart';
import '../mailboxes/mailboxes.dart';
import 'expenses.dart';
import 'finance.dart';

const incomeColor = Color(0xff08785b);
const expenseColor = Color(0xff5140c1);
const ink = Color(0xff111a40);
const incomeSurface = Color(0xffe6f7f0);
const expenseSurface = Color(0xfff0edff);

class FinanceScreen extends ConsumerStatefulWidget {
  const FinanceScreen({super.key, this.home = false, this.initial});
  final bool home;
  final FinanceRange? initial;

  @override
  ConsumerState<FinanceScreen> createState() => _FinanceScreenState();
}

class _FinanceScreenState extends ConsumerState<FinanceScreen> {
  late FinanceRange _range = widget.initial ?? currentRange();
  Bucket? _selected;
  bool _table = false;

  void _setRange(FinanceRange value) => setState(() {
    _range = value;
    _selected = null;
  });

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
    return Scaffold(
      appBar: AppBar(
        title: const Row(
          children: [
            Image(
              image: AssetImage('assets/brand.png'),
              width: 34,
              height: 34,
              excludeFromSemantics: true,
            ),
            SizedBox(width: 6),
            Text('MailGasto IA'),
          ],
        ),
      ),
      body: RefreshIndicator(
        onRefresh: () => ref
            .refresh(provider.future)
            .then<void>((_) {}, onError: (Object _) {}),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          children: [
            Text(
              widget.home && name != null ? 'Hola, $name' : 'Análisis',
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            Text(
              widget.home
                  ? 'Tus movimientos del periodo'
                  : 'Compara ingresos y gastos',
            ),
            const SizedBox(height: 12),
            RangeControls(range: _range, onChange: _setRange),
            const SizedBox(height: 12),
            if (widget.home) const _HomeConnections(),
            data.when(
              loading: () => const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: LinearProgressIndicator(
                  semanticsLabel: 'Cargando movimientos',
                ),
              ),
              error: (error, _) =>
                  RetryMessage(error, () => ref.invalidate(provider)),
              data: (report) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (widget.home) ...[
                    _Totals(report: report, currency: _range.currency),
                    const SizedBox(height: 8),
                  ],
                  if (report.empty)
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Aún no hay movimientos en este periodo',
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              '${dayLabel(_range.from)} – ${dayLabel(_range.to)} · ${_range.currency}',
                            ),
                            if (!widget.home)
                              TextButton(
                                onPressed: () => context.push(_newPath),
                                child: const Text('Registrar movimiento'),
                              ),
                          ],
                        ),
                      ),
                    )
                  else ...[
                    _chartCard(report),
                    if (!widget.home) ...[
                      if (report.series
                              .where((bucket) => bucket.from == _selected?.from)
                              .firstOrNull
                          case final bucket?)
                        _selection(bucket),
                      _BreakdownCard(
                        title: 'Gastos por categoría',
                        rows: report.expenseCategories,
                        labels: categories,
                        currency: _range.currency,
                        total: report.expense,
                        color: expenseColor,
                        onTap: (key) =>
                            _movements({'tab': 'expense', 'category': key}),
                      ),
                      _BreakdownCard(
                        title: 'Ingresos por origen de registro',
                        rows: report.incomeSources,
                        labels: movementSources,
                        currency: _range.currency,
                        total: report.income,
                        color: incomeColor,
                        onTap: (key) =>
                            _movements({'tab': 'income', 'source': key}),
                      ),
                    ],
                  ],
                  if (widget.home) ...[
                    _HomeActivity(range: _range, onAll: _movements),
                    FilledButton.icon(
                      onPressed: () => context.push(_newPath),
                      icon: const Icon(Icons.add),
                      label: const Text('Registrar movimiento'),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _chartCard(Analytics report) => Card(
    child: Padding(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            children: [
              Text(
                'Ingresos vs. gastos',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              TextButton(
                onPressed: widget.home
                    ? () => context.go(
                        financePath('/analysis', rangeQuery(_range)),
                      )
                    : () => setState(() => _table = !_table),
                child: Text(
                  widget.home
                      ? 'Ver análisis'
                      : _table
                      ? 'Ver gráfica'
                      : 'Ver tabla',
                ),
              ),
            ],
          ),
          const Wrap(
            spacing: 14,
            children: [
              _Legend('Ingresos', incomeColor, Icons.south_west),
              _Legend('Gastos', expenseColor, Icons.north_east),
            ],
          ),
          if (_table)
            _DataTable(
              report: report,
              currency: _range.currency,
              select: (bucket) => setState(() => _selected = bucket),
            )
          else
            _Chart(
              report: report,
              range: _range,
              compact: widget.home,
              selected: _selected,
              select: widget.home
                  ? (_) =>
                        context.go(financePath('/analysis', rangeQuery(_range)))
                  : (bucket) => setState(() => _selected = bucket),
            ),
        ],
      ),
    ),
  );

  Widget _selection(Bucket bucket) => Card(
    color: Theme.of(context).colorScheme.primaryContainer,
    child: Padding(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(bucket.label, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 6),
          Wrap(
            spacing: 16,
            runSpacing: 6,
            children: [
              Text(
                'Ingresos ${money(bucket.income, _range.currency)}',
                style: const TextStyle(color: incomeColor),
              ),
              Text(
                'Gastos ${money(bucket.expense, _range.currency)}',
                style: const TextStyle(color: expenseColor),
              ),
            ],
          ),
          TextButton.icon(
            onPressed: () => _movements({'from': bucket.from, 'to': bucket.to}),
            icon: const Icon(Icons.arrow_forward),
            label: const Text('Ver movimientos'),
          ),
        ],
      ),
    ),
  );
}

class RangeControls extends StatelessWidget {
  const RangeControls({
    super.key,
    required this.range,
    required this.onChange,
    this.showCurrency = true,
  });
  final FinanceRange range;
  final ValueChanged<FinanceRange> onChange;
  final bool showCurrency;

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
    return Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 12,
      children: [
        PopupMenuButton<String>(
          key: const ValueKey('home-period'),
          tooltip: 'Cambiar periodo',
          child: Chip(
            label: Text(selected?.key ?? 'Personalizado'),
            avatar: const Icon(Icons.calendar_month, size: 18),
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
          DropdownButton<String>(
            value: range.currency,
            items: [
              for (final currency in currencies.keys)
                DropdownMenuItem(value: currency, child: Text(currency)),
            ],
            onChanged: (value) =>
                onChange((from: range.from, to: range.to, currency: value!)),
          ),
        Text(
          '${dayLabel(range.from)} – ${dayLabel(range.to)}',
          style: Theme.of(context).textTheme.labelSmall,
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
    return Card(
      child: ListTile(
        leading: const Icon(Icons.mail_outline),
        title: Text(
          mailboxes.any((item) => item.state == 'reconnect')
              ? 'Revisa tus buzones'
              : 'Vincular Gmail',
        ),
        subtitle: const Text(
          'Consulta los avisos por correo o registra movimientos manualmente.',
        ),
        trailing: TextButton(
          onPressed: () => setState(() => _dismissed = true),
          child: const Text('Más tarde'),
        ),
        onTap: () => context.go('/settings/mailboxes'),
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
        ?.value
        .items;
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
        if (pending?.isNotEmpty ?? false)
          Card(
            color: const Color(0xfffff1d8),
            child: ListTile(
              leading: const Icon(
                Icons.mark_email_unread_outlined,
                color: Color(0xff8a4b08),
              ),
              title: const Text('Ver avisos pendientes'),
              subtitle: Text(pending!.first.pendingExplanation),
              onTap: () => onAll({'tab': 'notices', 'status': 'pending'}),
            ),
          ),
        if (recent.isNotEmpty) ...[
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Movimientos recientes'),
            trailing: TextButton(
              onPressed: () => onAll(),
              child: const Text('Ver todos'),
            ),
          ),
          for (final item in recent.take(3))
            MovementTile(
              item,
              onTap: () => context.push('/history/movement/${item.id}'),
            ),
        ],
        const SizedBox(height: 8),
      ],
    );
  }
}

class MovementTile extends StatelessWidget {
  const MovementTile(this.item, {super.key, this.onTap});
  final Movement item;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final color = item.income ? incomeColor : expenseColor;
    return Card(
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: item.income ? incomeSurface : expenseSurface,
          child: Icon(
            item.income ? Icons.south_west : Icons.north_east,
            color: color,
          ),
        ),
        title: Text(item.title),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              item.signedAmount,
              style: TextStyle(color: color, fontWeight: FontWeight.bold),
            ),
            Text(
              '${item.kind} · ${categories[item.category] ?? item.category} · ${movementSources[item.source]}',
            ),
          ],
        ),
        trailing: onTap == null ? null : const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}

class _Totals extends StatelessWidget {
  const _Totals({required this.report, required this.currency});
  final Analytics report;
  final String currency;

  @override
  Widget build(BuildContext context) {
    final title = Theme.of(context).textTheme.titleLarge;
    final cards = [
      for (final (label, color, bg, value, icon) in [
        (
          'Ingresos',
          incomeColor,
          incomeSurface,
          report.income,
          Icons.south_west,
        ),
        (
          'Gastos',
          expenseColor,
          expenseSurface,
          report.expense,
          Icons.north_east,
        ),
      ])
        Card(
          color: bg,
          child: Padding(
            padding: const EdgeInsets.all(13),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Legend(label, color, icon),
                const SizedBox(height: 5),
                Text(
                  money(value, currency),
                  style: title?.copyWith(
                    color: color,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
          ),
        ),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (MediaQuery.textScalerOf(context).scale(16) > 21)
          ...cards
        else
          Row(children: [for (final card in cards) Expanded(child: card)]),
        Card(
          color: ink,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Balance del periodo',
                  style: TextStyle(color: Color(0xffd9dff7)),
                ),
                Text(
                  '${report.balance > BigInt.zero ? '+ ' : ''}${money(report.balance, currency)}',
                  style: title?.copyWith(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend(this.label, this.color, this.icon);
  final String label;
  final Color color;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Wrap(
    crossAxisAlignment: WrapCrossAlignment.center,
    spacing: 4,
    children: [
      Icon(icon, color: color, size: 16),
      Text(
        label,
        style: TextStyle(color: color, fontWeight: FontWeight.w700),
      ),
    ],
  );
}

class _Chart extends StatelessWidget {
  const _Chart({
    required this.report,
    required this.range,
    required this.compact,
    required this.selected,
    required this.select,
  });
  final Analytics report;
  final FinanceRange range;
  final bool compact;
  final Bucket? selected;
  final ValueChanged<Bucket> select;

  @override
  Widget build(BuildContext context) {
    final max = report.series.fold(BigInt.zero, (result, bucket) {
      final peak = bucket.income > bucket.expense
          ? bucket.income
          : bucket.expense;
      return peak > result ? peak : result;
    });
    final height = compact ? 75.0 : 132.0;
    final axis = DateFormat('d/M');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Escala común · ${money(BigInt.zero, range.currency)} – ${money(max, range.currency)}',
          style: Theme.of(context).textTheme.labelSmall,
        ),
        const SizedBox(height: 6),
        LayoutBuilder(
          builder: (context, constraints) {
            final width = math.max(
              compact ? 27.0 : 43.0,
              constraints.maxWidth / report.series.length,
            );
            return SizedBox(
              height: height + MediaQuery.textScalerOf(context).scale(30),
              child: ListView.builder(
                itemExtent: width,
                scrollDirection: Axis.horizontal,
                itemCount: report.series.length,
                itemBuilder: (context, index) {
                  final bucket = report.series[index];
                  final chosen = selected?.from == bucket.from;
                  return Semantics(
                    button: true,
                    selected: chosen,
                    label:
                        '${bucket.label}. Ingresos ${money(bucket.income, range.currency)}. Gastos ${money(bucket.expense, range.currency)}.',
                    child: InkWell(
                      onTap: () => select(bucket),
                      child: ExcludeSemantics(
                        child: Column(
                          children: [
                            Container(
                              height: height,
                              decoration: BoxDecoration(
                                color: chosen
                                    ? Theme.of(
                                        context,
                                      ).colorScheme.primaryContainer
                                    : null,
                                border: Border(
                                  bottom: BorderSide(
                                    color: Theme.of(context).dividerColor,
                                  ),
                                ),
                              ),
                              alignment: Alignment.bottomCenter,
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  _bar(height, bucket.income, max, incomeColor),
                                  const SizedBox(width: 3),
                                  _bar(
                                    height,
                                    bucket.expense,
                                    max,
                                    expenseColor,
                                  ),
                                ],
                              ),
                            ),
                            Text(
                              axis.format(DateTime.parse(bucket.from)),
                              maxLines: 1,
                              overflow: TextOverflow.clip,
                              style: Theme.of(context).textTheme.labelSmall,
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            );
          },
        ),
      ],
    );
  }

  Widget _bar(double height, BigInt value, BigInt max, Color color) =>
      Container(
        width: compact ? 7 : 10,
        height: max == BigInt.zero
            ? 0
            : height * value.toDouble() / max.toDouble(),
        decoration: BoxDecoration(
          color: color,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(4)),
        ),
      );
}

class _DataTable extends StatelessWidget {
  const _DataTable({
    required this.report,
    required this.currency,
    required this.select,
  });
  final Analytics report;
  final String currency;
  final ValueChanged<Bucket> select;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Table(
        defaultVerticalAlignment: TableCellVerticalAlignment.middle,
        border: TableBorder(
          horizontalInside: BorderSide(color: Theme.of(context).dividerColor),
        ),
        children: [
          TableRow(
            children: [
              _cell('Periodo', bold: true),
              _cell('Ingresos', color: incomeColor, bold: true),
              _cell('Gastos', color: expenseColor, bold: true),
            ],
          ),
          for (final bucket in report.series)
            TableRow(
              children: [
                InkWell(
                  onTap: () => select(bucket),
                  child: _cell(
                    bucket.label,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                ),
                _cell(money(bucket.income, currency), color: incomeColor),
                _cell(money(bucket.expense, currency), color: expenseColor),
              ],
            ),
          TableRow(
            children: [
              _cell('Total', bold: true),
              _cell(
                money(report.income, currency),
                color: incomeColor,
                bold: true,
              ),
              _cell(
                money(report.expense, currency),
                color: expenseColor,
                bold: true,
              ),
            ],
          ),
        ],
      ),
      Text('Balance del periodo · ${money(report.balance, currency)}'),
    ],
  );

  Widget _cell(String value, {Color? color, bool bold = false}) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
    child: Text(
      value,
      style: TextStyle(color: color, fontWeight: bold ? FontWeight.bold : null),
    ),
  );
}

class _BreakdownCard extends StatelessWidget {
  const _BreakdownCard({
    required this.title,
    required this.rows,
    required this.labels,
    required this.currency,
    required this.total,
    required this.color,
    required this.onTap,
  });
  final String title, currency;
  final List<Breakdown> rows;
  final Map<String, String> labels;
  final BigInt total;
  final Color color;
  final ValueChanged<String> onTap;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          if (rows.isEmpty) const Text('Sin movimientos para este desglose.'),
          for (final row in rows)
            InkWell(
              onTap: () => onTap(row.key),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 9),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${labels[row.key] ?? row.key} · ${money(row.amount, currency)}',
                    ),
                    const SizedBox(height: 4),
                    LinearProgressIndicator(
                      value: row.amount.toDouble() / total.toDouble(),
                      color: color,
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    ),
  );
}
