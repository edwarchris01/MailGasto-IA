import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';
import 'expenses.dart';

class HistoryScreen extends ConsumerStatefulWidget {
  const HistoryScreen({super.key, required this.filters});
  final HistoryFilters filters;

  @override
  ConsumerState<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends ConsumerState<HistoryScreen> {
  bool _loadingMore = false;

  void _filter(HistoryFilters filters) {
    context.go(
      Uri(
        path: '/history',
        queryParameters: {
          'from': ?filters.from,
          'to': ?filters.to,
          'category': ?filters.category,
          'status': ?filters.status,
        },
      ).toString(),
    );
  }

  Future<void> _chooseDates() async {
    final filters = widget.filters;
    final range = await pickDates(
      context,
      initial: filters.from == null || filters.to == null
          ? null
          : DateTimeRange(
              start: DateTime.parse(filters.from!),
              end: DateTime.parse(filters.to!),
            ),
    );
    if (!mounted || range == null) return;
    final dates = dateFilter(range);
    _filter((
      from: dates.from,
      to: dates.to,
      category: filters.category,
      status: filters.status,
    ));
  }

  Future<void> _more() async {
    setState(() => _loadingMore = true);
    try {
      await ref.read(historyProvider(widget.filters).notifier).loadMore();
    } catch (error) {
      if (mounted) showMessage(context, failureMessage(error));
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final filters = widget.filters;
    final provider = historyProvider(filters);
    final history = ref.watch(provider);
    return Scaffold(
      appBar: AppBar(title: const Text('Historial')),
      body: RefreshIndicator(
        onRefresh: () => ref
            .refresh(provider.future)
            .then<void>((_) {}, onError: (Object _) {}),
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Wrap(
                      spacing: 8,
                      children: [
                        OutlinedButton.icon(
                          key: const ValueKey('history-date'),
                          onPressed: _chooseDates,
                          icon: const Icon(Icons.date_range),
                          label: Text(
                            filters.from == null || filters.to == null
                                ? 'Fecha'
                                : '${dayLabel(filters.from!)} – ${dayLabel(filters.to!)}',
                          ),
                        ),
                        if (filters.from != null ||
                            filters.category != null ||
                            filters.status != null)
                          TextButton(
                            onPressed: () => _filter((
                              from: null,
                              to: null,
                              category: null,
                              status: null,
                            )),
                            child: const Text('Limpiar filtros'),
                          ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 16,
                      children: [
                        _Filter(
                          label: 'Categoría',
                          value: filters.category,
                          options: categories,
                          onChanged: (value) => _filter((
                            from: filters.from,
                            to: filters.to,
                            category: value,
                            status: filters.status,
                          )),
                        ),
                        _Filter(
                          label: 'Estado',
                          value: filters.status,
                          options: noticeStatuses,
                          onChanged: (value) => _filter((
                            from: filters.from,
                            to: filters.to,
                            category: filters.category,
                            status: value,
                          )),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            history.when(
              loading: () => const SliverToBoxAdapter(
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (error, _) => SliverToBoxAdapter(
                child: RetryMessage(error, () => ref.invalidate(provider)),
              ),
              data: (value) {
                if (value.items.isEmpty) {
                  return const SliverToBoxAdapter(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text(
                        'No hay avisos que coincidan con los filtros.',
                      ),
                    ),
                  );
                }
                return SliverPadding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  sliver: SliverList.builder(
                    itemCount: value.items.length + (value.hasMore ? 1 : 0),
                    itemBuilder: (context, index) {
                      if (index == value.items.length) {
                        return TextButton(
                          onPressed: _loadingMore ? null : _more,
                          child: Text(
                            _loadingMore ? 'Cargando…' : 'Cargar más',
                          ),
                        );
                      }
                      final notice = value.items[index];
                      return Card(
                        child: ListTile(
                          title: Text(notice.amount ?? notice.providerLabel),
                          subtitle: Padding(
                            padding: const EdgeInsets.only(top: 5),
                            child: Wrap(
                              spacing: 8,
                              runSpacing: 6,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                if (notice.amount != null)
                                  Text(notice.providerLabel),
                                Text(
                                  notice.date == null
                                      ? syncLabel(notice.receivedAt)
                                      : dayLabel(notice.date!),
                                ),
                                StatusBadge(notice.status),
                              ],
                            ),
                          ),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () => context.go(
                            GoRouterState.of(context).uri
                                .replace(path: '/history/${notice.id}')
                                .toString(),
                          ),
                        ),
                      );
                    },
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _Filter extends StatelessWidget {
  const _Filter({
    required this.label,
    required this.value,
    required this.options,
    required this.onChanged,
  });
  final String label;
  final String? value;
  final Map<String, String> options;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: Theme.of(context).textTheme.labelLarge),
      DropdownButton<String>(
        value: options.containsKey(value) ? value : '',
        items: [
          const DropdownMenuItem(value: '', child: Text('Todas')),
          for (final item in options.entries)
            DropdownMenuItem(value: item.key, child: Text(item.value)),
        ],
        onChanged: (choice) => onChanged(choice == '' ? null : choice),
      ),
    ],
  );
}

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
