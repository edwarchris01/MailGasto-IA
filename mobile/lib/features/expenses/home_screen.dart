import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/widgets.dart';
import 'expenses.dart';

enum _Period { thisMonth, lastMonth, custom }

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  _Period _period = _Period.thisMonth;
  DateTimeRange? _custom;

  DateTimeRange get _range => _period == _Period.custom
      ? _custom!
      : monthRange(bogotaNow(), previous: _period == _Period.lastMonth);

  Future<void> _choose(_Period? value) async {
    if (value == null) return;
    if (value == _Period.custom) {
      final range = await pickDates(context, initial: _range);
      if (range == null || !mounted) return;
      setState(() => _custom = range);
    }
    setState(() => _period = value);
  }

  @override
  Widget build(BuildContext context) {
    final dates = dateFilter(_range);
    final provider = summaryProvider(dates);
    final summary = ref.watch(provider);
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Inicio')),
      body: RefreshIndicator(
        onRefresh: () => ref
            .refresh(provider.future)
            .then<void>((_) {}, onError: (Object _) {}),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            InputDecorator(
              decoration: const InputDecoration(labelText: 'Periodo'),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<_Period>(
                  key: const ValueKey('home-period'),
                  value: _period,
                  isDense: true,
                  isExpanded: true,
                  items: const [
                    DropdownMenuItem(
                      value: _Period.thisMonth,
                      child: Text('Este mes'),
                    ),
                    DropdownMenuItem(
                      value: _Period.lastMonth,
                      child: Text('Mes anterior'),
                    ),
                    DropdownMenuItem(
                      value: _Period.custom,
                      child: Text('Personalizado'),
                    ),
                  ],
                  onChanged: _choose,
                ),
              ),
            ),
            const SizedBox(height: 12),
            Text('${dayLabel(dates.from)} – ${dayLabel(dates.to)}'),
            const SizedBox(height: 16),
            summary.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (error, _) =>
                  RetryMessage(error, () => ref.invalidate(provider)),
              data: (value) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Card(
                    color: theme.colorScheme.primary,
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Gastos registrados',
                            style: TextStyle(
                              color: theme.colorScheme.onPrimary,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            money(value.total, 'COP'),
                            style: theme.textTheme.headlineMedium?.copyWith(
                              color: theme.colorScheme.onPrimary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text('Por categoría', style: theme.textTheme.titleLarge),
                  const SizedBox(height: 8),
                  if (value.breakdown.isEmpty)
                    const Text(
                      'No hay gastos registrados en COP para este periodo.',
                    ),
                  for (final row in value.breakdown)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Wrap(
                            alignment: WrapAlignment.spaceBetween,
                            spacing: 12,
                            children: [
                              Text(categories[row.category] ?? row.category),
                              Text(money(row.minor, 'COP')),
                            ],
                          ),
                          const SizedBox(height: 6),
                          ExcludeSemantics(
                            child: LinearProgressIndicator(
                              value: value.total == BigInt.zero
                                  ? 0
                                  : ((row.minor * BigInt.from(1000)) ~/
                                                value.total)
                                            .toInt() /
                                        1000,
                              minHeight: 6,
                              borderRadius: BorderRadius.circular(6),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            OutlinedButton.icon(
              onPressed: () => context.go(
                Uri(
                  path: '/history',
                  queryParameters: {
                    'from': dates.from,
                    'to': dates.to,
                    'status': 'pending',
                  },
                ).toString(),
              ),
              icon: const Icon(Icons.pending_actions),
              label: const Text('Ver avisos pendientes'),
            ),
          ],
        ),
      ),
    );
  }
}
