import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/design.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';
import 'finance.dart';

enum _Interval {
  day('Diaria', 'Día'),
  week('Semanal', 'Semana'),
  month('Mensual', 'Mes');

  const _Interval(this.description, this.column);
  final String description, column;
}

_Interval _interval(FinanceRange range) {
  // Use UTC for calendar arithmetic so device daylight saving can't shift a day.
  final from = DateTime.parse('${range.from}T00:00:00Z');
  final to = DateTime.parse('${range.to}T00:00:00Z');
  final days = to.difference(from).inDays + 1;
  return days <= 14
      ? _Interval.day
      : days <= 90
      ? _Interval.week
      : _Interval.month;
}

String comparisonLabel(FinanceRange range) =>
    'Comparativa ${_interval(range).description.toLowerCase()} · ${periodLabel(range.from, range.to)}';

class SeriesLegend extends StatelessWidget {
  const SeriesLegend(this.label, this.tone, {super.key, this.icon});
  final String label;
  final AppTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (icon case final symbol?)
        Icon(symbol, color: tone.ink, size: 16)
      else
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            color: tone.ink,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      const SizedBox(width: 5),
      Flexible(
        child: Text(
          label,
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: icon == null ? AppColors.muted : tone.ink,
          ),
        ),
      ),
    ],
  );
}

class FinanceChart extends StatelessWidget {
  const FinanceChart({
    super.key,
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
    if (report.series.isEmpty) return const SizedBox.shrink();
    final peak = report.series.fold(BigInt.zero, (max, bucket) {
      final value = bucket.income > bucket.expense
          ? bucket.income
          : bucket.expense;
      return value > max ? value : max;
    });
    final divisions = compact ? 2 : 4;
    final step = _axisStep(peak, divisions);
    final ceiling = step * BigInt.from(divisions);
    final ticks = [
      for (var i = divisions; i >= 0; i--)
        _axisLabel(step * BigInt.from(i), range.currency),
    ];
    final interval = _interval(range);
    final start = DateTime.parse(range.from);
    final end = DateTime.parse(range.to);
    final sameMonth = start.month == end.month && start.year == end.year;
    final dateFormat = DateFormat(switch (interval) {
      _Interval.day when sameMonth => 'd',
      _Interval.month when start.year != end.year => 'MMM yy',
      _Interval.month => 'MMM',
      _ => 'd/M',
    }, 'es_CO');
    final axisTitle = switch (interval) {
      _Interval.day when sameMonth =>
        'Día de ${DateFormat('MMMM', 'es_CO').format(start)}',
      _Interval.day => 'Día del periodo',
      _Interval.week => 'Inicio de semana',
      _Interval.month => 'Mes',
    };
    final scale = MediaQuery.textScalerOf(context);
    final tickStyle = DefaultTextStyle.of(context).style.copyWith(
      color: AppColors.muted,
      fontSize: compact ? 9 : 10,
      height: 1.12,
      letterSpacing: 0,
    );
    final tickHeight = scale.scale(tickStyle.fontSize!) * 1.2;
    final height = compact ? 49.0 : math.max(147.0, tickHeight * 6);
    final axisWidth =
        ticks
            .map((label) {
              final painter = TextPainter(
                text: TextSpan(text: label, style: tickStyle),
                textDirection: Directionality.of(context),
                textScaler: scale,
              )..layout();
              final width = painter.width.ceilToDouble();
              painter.dispose();
              return width;
            })
            .reduce(math.max) +
        7;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ExcludeSemantics(
              child: SizedBox(
                width: axisWidth,
                height: height + tickHeight,
                child: Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      for (final tick in ticks)
                        Text(
                          tick,
                          maxLines: 1,
                          softWrap: false,
                          style: tickStyle,
                        ),
                    ],
                  ),
                ),
              ),
            ),
            Expanded(
              child: Padding(
                padding: EdgeInsets.only(top: tickHeight / 2),
                child: LayoutBuilder(
                  builder: (context, constraints) {
                    final width = math.max(
                      scale.scale(
                        compact
                            ? 18
                            : interval == _Interval.day && sameMonth
                            ? 23
                            : 40,
                      ),
                      constraints.maxWidth / report.series.length,
                    );
                    final skip = compact
                        ? math.max(1, (report.series.length / 5).ceil())
                        : 1;
                    return Stack(
                      children: [
                        Positioned(
                          top: 0,
                          left: 0,
                          right: 0,
                          child: SizedBox(
                            height: height,
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                for (var i = 0; i <= divisions; i++)
                                  const Divider(
                                    height: 1,
                                    color: AppColors.border,
                                  ),
                              ],
                            ),
                          ),
                        ),
                        SizedBox(
                          height: height + tickHeight + 7,
                          child: ListView.builder(
                            scrollDirection: Axis.horizontal,
                            itemExtent: width,
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
                                          margin: const EdgeInsets.symmetric(
                                            horizontal: 1,
                                          ),
                                          decoration: BoxDecoration(
                                            color: chosen
                                                ? AppColors.blueTint.withValues(
                                                    alpha: .82,
                                                  )
                                                : null,
                                            borderRadius:
                                                const BorderRadius.vertical(
                                                  top: Radius.circular(6),
                                                ),
                                          ),
                                          alignment: Alignment.bottomCenter,
                                          child: Row(
                                            mainAxisAlignment:
                                                MainAxisAlignment.center,
                                            crossAxisAlignment:
                                                CrossAxisAlignment.end,
                                            children: [
                                              _bar(
                                                height,
                                                bucket.income,
                                                ceiling,
                                                AppColors.income,
                                              ),
                                              const SizedBox(width: 2),
                                              _bar(
                                                height,
                                                bucket.expense,
                                                ceiling,
                                                AppColors.expense,
                                              ),
                                            ],
                                          ),
                                        ),
                                        const SizedBox(height: 4),
                                        if (index % skip == 0 ||
                                            index == report.series.length - 1)
                                          Text(
                                            dateFormat
                                                .format(
                                                  DateTime.parse(bucket.from),
                                                )
                                                .replaceAll('.', ''),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: tickStyle.copyWith(
                                              color: chosen
                                                  ? AppColors.accent
                                                  : AppColors.muted,
                                              fontWeight: chosen
                                                  ? FontWeight.w800
                                                  : FontWeight.w500,
                                            ),
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
                      ],
                    );
                  },
                ),
              ),
            ),
          ],
        ),
        if (!compact) ...[
          const SizedBox(height: 5),
          Text(
            axisTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ],
    );
  }

  BigInt _axisStep(BigInt peak, int divisions) {
    if (peak == BigInt.zero) return BigInt.from(100);
    final count = BigInt.from(divisions);
    final required = (peak + count - BigInt.one) ~/ count;
    final unit = BigInt.from(10).pow(required.toString().length - 1);
    for (final multiplier in [10, 20, 25, 50, 100]) {
      final step =
          (unit * BigInt.from(multiplier) + BigInt.from(9)) ~/ BigInt.from(10);
      if (step >= required) return step;
    }
    return required;
  }

  String _axisLabel(BigInt minor, String currency) {
    if (minor < BigInt.from(100000)) {
      return displayMoney(minor, currency, symbol: false);
    }
    return NumberFormat.compact(locale: 'es_CO').format(minor.toDouble() / 100);
  }

  Widget _bar(double height, BigInt value, BigInt max, Color color) =>
      Container(
        width: compact ? 5 : 7.5,
        height: height * value.toDouble() / max.toDouble(),
        decoration: BoxDecoration(
          color: color,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(4)),
        ),
      );
}

class FinanceDataTable extends StatelessWidget {
  const FinanceDataTable({
    super.key,
    required this.report,
    required this.range,
    required this.selected,
    required this.select,
  });
  final Analytics report;
  final FinanceRange range;
  final Bucket? selected;
  final ValueChanged<Bucket> select;

  @override
  Widget build(BuildContext context) {
    final currency = range.currency;
    final interval = _interval(range);
    String label(Bucket bucket) => switch (interval) {
      _Interval.day => shortDay(bucket.from, year: false),
      _Interval.month => DateFormat(
        'MMM y',
        'es_CO',
      ).format(DateTime.parse(bucket.from)),
      _Interval.week =>
        '${shortDay(bucket.from, year: false)} – ${shortDay(bucket.to, year: false)}',
    };

    return AppPanel(
      padding: const EdgeInsets.all(9),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Table(
            columnWidths: const {
              0: FlexColumnWidth(.9),
              1: FlexColumnWidth(),
              2: FlexColumnWidth(),
            },
            defaultVerticalAlignment: TableCellVerticalAlignment.middle,
            border: const TableBorder(
              horizontalInside: BorderSide(color: AppColors.border),
            ),
            children: [
              TableRow(
                decoration: BoxDecoration(
                  color: AppColors.neutralTint,
                  borderRadius: BorderRadius.circular(9),
                ),
                children: [
                  _cell(context, interval.column, bold: true),
                  _cell(
                    context,
                    'Ingresos',
                    color: AppColors.income,
                    bold: true,
                    right: true,
                  ),
                  _cell(
                    context,
                    'Gastos',
                    color: AppColors.expense,
                    bold: true,
                    right: true,
                  ),
                ],
              ),
              for (final bucket in report.series)
                TableRow(
                  decoration: selected?.from == bucket.from
                      ? BoxDecoration(
                          color: AppColors.blueTint,
                          borderRadius: BorderRadius.circular(8),
                        )
                      : null,
                  children: [
                    Semantics(
                      button: true,
                      selected: selected?.from == bucket.from,
                      child: InkWell(
                        onTap: () => select(bucket),
                        child: _cell(context, label(bucket), bold: true),
                      ),
                    ),
                    _amount(
                      context,
                      'Ingresos',
                      bucket.income,
                      AppColors.income,
                    ),
                    _amount(
                      context,
                      'Gastos',
                      bucket.expense,
                      AppColors.expense,
                    ),
                  ],
                ),
              TableRow(
                children: [
                  _cell(context, 'Total', bold: true),
                  _amount(
                    context,
                    'Ingresos',
                    report.income,
                    AppColors.income,
                    total: true,
                  ),
                  _amount(
                    context,
                    'Gastos',
                    report.expense,
                    AppColors.expense,
                    total: true,
                  ),
                ],
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
            child: TrailingRow(
              crossAxisAlignment: CrossAxisAlignment.start,
              leading: Text(
                'Balance del periodo',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              trailing: Text(
                '${report.balance > BigInt.zero ? '+ ' : ''}${displayMoney(report.balance, currency)}',
                textAlign: TextAlign.end,
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontFeatures: tabularFigures,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _amount(
    BuildContext context,
    String label,
    BigInt value,
    Color color, {
    bool total = false,
  }) => Semantics(
    label: '$label ${money(value, range.currency)}',
    excludeSemantics: true,
    child: _cell(
      context,
      displayMoney(value, range.currency),
      color: value == BigInt.zero && !total ? AppColors.muted : color,
      bold: value != BigInt.zero || total,
      right: true,
    ),
  );

  Widget _cell(
    BuildContext context,
    String value, {
    Color? color,
    bool bold = false,
    bool right = false,
  }) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
    child: Text(
      value,
      textAlign: right ? TextAlign.end : TextAlign.start,
      style: Theme.of(context).textTheme.bodySmall?.copyWith(
        fontSize: 12.5,
        color: color ?? AppColors.ink,
        fontWeight: bold ? FontWeight.w700 : FontWeight.w400,
        fontFeatures: tabularFigures,
      ),
    ),
  );
}

class BreakdownCard extends StatelessWidget {
  const BreakdownCard({
    super.key,
    required this.title,
    required this.rows,
    required this.labels,
    required this.currency,
    required this.total,
    required this.tone,
    required this.onTap,
  });
  final String title, currency;
  final List<Breakdown> rows;
  final Map<String, String> labels;
  final BigInt total;
  final AppTone tone;
  final ValueChanged<String> onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return AppPanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SectionHeading(title),
          const SizedBox(height: 4),
          Text(
            '${displayMoney(total, currency)} en ${tone == AppTone.income ? 'ingresos' : 'gastos'}',
            style: text.bodySmall,
          ),
          const SizedBox(height: 5),
          if (rows.isEmpty) const Text('Sin movimientos para este desglose.'),
          for (final row in rows)
            InkWell(
              onTap: () => onTap(row.key),
              borderRadius: BorderRadius.circular(8),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TrailingRow(
                      leading: Text(
                        labels[row.key] ?? row.key,
                        style: text.titleMedium,
                      ),
                      trailing: Text(
                        displayMoney(row.amount, currency),
                        textAlign: TextAlign.end,
                        style: text.titleMedium?.copyWith(
                          color: tone.ink,
                          fontFeatures: tabularFigures,
                        ),
                      ),
                    ),
                    const SizedBox(height: 7),
                    ExcludeSemantics(
                      child: LinearProgressIndicator(
                        value: total == BigInt.zero
                            ? 0
                            : row.amount.toDouble() / total.toDouble(),
                        minHeight: 7,
                        borderRadius: BorderRadius.circular(6),
                        color: tone.ink,
                        backgroundColor: tone.tint,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
